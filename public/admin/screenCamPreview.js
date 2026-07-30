(function exposeScreenCamPreview(root, factory) {
  const helpers = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = helpers;
  } else {
    root.ScreenCamPreview = helpers;
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function waitForIceGatheringComplete(pc, timeoutMs = 8000) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Tiempo de espera ICE agotado'));
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timeout);
        pc.removeEventListener('icegatheringstatechange', onStateChange);
      }

      function onStateChange() {
        if (pc.iceGatheringState !== 'complete') return;
        cleanup();
        resolve();
      }

      pc.addEventListener('icegatheringstatechange', onStateChange);
    });
  }

  function localOfferSdp(pc) {
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('El navegador no genero una oferta SDP');
    return sdp;
  }

  // ---------- Reintento WHEP: clasificacion y backoff ----------
  //
  // 404: el path todavia no existe en MediaMTX (el cliente no arranco a
  //   publicar todavia). Es el caso NORMAL al principio de toda sesion, se
  //   reintenta sin limite de intentos (el limite real es el vencimiento de
  //   la sesion, que corta todo desde afuera via isSessionActive()).
  // 409/503: el gateway esta ocupado/reiniciando. Tambien transitorio, pero
  //   con un tope de reintentos (MAX_CONGESTION_RETRIES): si sigue asi mas
  //   de un puñado de intentos, algo mas serio esta pasando y no tiene
  //   sentido seguir insistiendo indefinidamente.
  // 401/403: el token no sirve (sesion reemplazada/revocada). No hay nada
  //   que un reintento pueda arreglar: es definitivo.
  // Cualquier otro codigo: se trata como definitivo por seguridad (mejor
  //   mostrar error que reintentar indefinidamente algo no contemplado).
  const WHEP_BACKOFF_SEQUENCE_MS = [300, 500, 750, 1000, 1500];
  const MAX_CONGESTION_RETRIES = 8;
  const DEFAULT_FIRST_FRAME_TIMEOUT_MS = 6000;
  const DEFAULT_DISCONNECT_GRACE_MS = 4000;

  function classifyWhepOutcome({ aborted, status }) {
    if (aborted) return 'cancelled';
    if (typeof status === 'number' && status >= 200 && status < 300) return 'success';
    if (status === 404 || status === 409 || status === 503) return 'transient_failure';
    return 'fatal_failure';
  }

  function whepBackoffMs(attemptIndex) {
    const i = Math.max(0, Math.min(attemptIndex, WHEP_BACKOFF_SEQUENCE_MS.length - 1));
    return WHEP_BACKOFF_SEQUENCE_MS[i];
  }

  // ---------- Marcas de tiempo (solo duraciones, nunca URLs ni tokens) ----------
  function createTimingMarks(now = () => Date.now()) {
    const marks = {};
    return {
      mark(name, value) {
        marks[name] = value != null ? value : now();
        return marks[name];
      },
      get(name) {
        return marks[name];
      },
      durations() {
        const d = {};
        if (marks.preview_requested_at != null && marks.mediamtx_publisher_ready_at != null) {
          d.request_to_publisher_ms = marks.mediamtx_publisher_ready_at - marks.preview_requested_at;
        }
        if (marks.whep_attempt_started_at != null && marks.whep_accepted_at != null) {
          d.whep_attempt_to_201_ms = marks.whep_accepted_at - marks.whep_attempt_started_at;
        }
        if (marks.whep_accepted_at != null && marks.peer_connected_at != null) {
          d.whep_201_to_connected_ms = marks.peer_connected_at - marks.whep_accepted_at;
        }
        if (marks.peer_connected_at != null && marks.first_frame_at != null) {
          d.connected_to_first_frame_ms = marks.first_frame_at - marks.peer_connected_at;
        }
        if (marks.preview_requested_at != null && marks.first_frame_at != null) {
          d.total_request_to_first_frame_ms = marks.first_frame_at - marks.preview_requested_at;
        }
        return d;
      },
      raw() {
        return { ...marks };
      },
    };
  }

  // ---------- Evitar pantalla negra ----------
  // El video queda oculto hasta que exista un frame realmente decodificado:
  // ni srcObject asignado ni "conectado" en WebRTC garantizan eso. Se
  // dispara con lo primero que llegue entre loadeddata/canplay/playing/
  // requestVideoFrameCallback (cuando el navegador lo soporta), una sola vez.
  function attachFirstFrameGate(videoEl, { onFirstFrame, onStalled, onError } = {}) {
    let fired = false;
    const events = ['loadeddata', 'canplay', 'playing'];
    const listeners = events.map((name) => {
      const fn = () => fire();
      videoEl.addEventListener(name, fn);
      return [name, fn];
    });
    let rvfcHandle = null;
    if (typeof videoEl.requestVideoFrameCallback === 'function') {
      rvfcHandle = videoEl.requestVideoFrameCallback(() => fire());
    }
    const onStalledEvt = () => { if (!fired) onStalled?.(); };
    const onErrorEvt = (e) => { if (!fired) onError?.(e); };
    videoEl.addEventListener('stalled', onStalledEvt);
    videoEl.addEventListener('error', onErrorEvt);

    function fire() {
      if (fired) return;
      fired = true;
      cleanup();
      onFirstFrame?.();
    }

    function cleanup() {
      for (const [name, fn] of listeners) videoEl.removeEventListener(name, fn);
      videoEl.removeEventListener('stalled', onStalledEvt);
      videoEl.removeEventListener('error', onErrorEvt);
      if (rvfcHandle != null && typeof videoEl.cancelVideoFrameCallback === 'function') {
        videoEl.cancelVideoFrameCallback(rvfcHandle);
      }
    }

    return { dispose: cleanup, hasFired: () => fired };
  }

  // ---------- Controller de WHEP ----------
  // Encapsula TODO el ciclo de vida de un intento de reproduccion: nunca
  // deja mas de una RTCPeerConnection, un fetch, un timer de reintento ni un
  // AbortController vivos a la vez (cada intento nuevo cierra al anterior
  // antes de empezar). El llamador solo reacciona a callbacks; no maneja
  // directamente pc/fetch/timers.
  function createWhepController(config) {
    const {
      whepUrl,
      fetchImpl = (typeof fetch !== 'undefined' ? fetch : undefined),
      pcFactory = () => new RTCPeerConnection(),
      setTimeoutImpl = (typeof setTimeout !== 'undefined' ? setTimeout : undefined),
      clearTimeoutImpl = (typeof clearTimeout !== 'undefined' ? clearTimeout : undefined),
      now = () => Date.now(),
      getVideoElement = () => null,
      onStatus = () => {},
      onFirstFrame = () => {},
      onTerminal = () => {},
      onTiming = () => {},
      isSessionActive = () => true,
      waitForIceGathering = waitForIceGatheringComplete,
      firstFrameTimeoutMs = DEFAULT_FIRST_FRAME_TIMEOUT_MS,
      disconnectGraceMs = DEFAULT_DISCONNECT_GRACE_MS,
      maxCongestionRetries = MAX_CONGESTION_RETRIES,
    } = config;

    if (typeof whepUrl !== 'string' || !whepUrl) throw new Error('whepUrl requerido');
    if (typeof fetchImpl !== 'function') throw new Error('fetchImpl requerido');

    let cancelled = false;
    let pc = null;
    let abortController = null;
    let retryTimer = null;
    let inFlight = false;
    let transientAttempts = 0;
    let congestionAttempts = 0;
    let firstFrameTimer = null;
    let disconnectTimer = null;
    let frameGate = null;
    const timing = createTimingMarks(now);

    function clearRetryTimer() {
      if (retryTimer != null) { clearTimeoutImpl(retryTimer); retryTimer = null; }
    }
    function clearFirstFrameTimer() {
      if (firstFrameTimer != null) { clearTimeoutImpl(firstFrameTimer); firstFrameTimer = null; }
    }
    function clearDisconnectTimer() {
      if (disconnectTimer != null) { clearTimeoutImpl(disconnectTimer); disconnectTimer = null; }
    }
    function disposeFrameGate() {
      if (frameGate) { frameGate.dispose(); frameGate = null; }
    }
    function closePeerConnection() {
      disposeFrameGate();
      clearFirstFrameTimer();
      clearDisconnectTimer();
      if (pc) {
        try { pc.close(); } catch (_) { /* ya cerrado */ }
        pc = null;
      }
    }
    function abortInFlightFetch() {
      if (abortController) {
        try { abortController.abort(); } catch (_) { /* noop */ }
        abortController = null;
      }
    }

    function finish(reason) {
      cancelled = true;
      clearRetryTimer();
      closePeerConnection();
      abortInFlightFetch();
      onTerminal(reason);
    }

    function cancel() {
      if (cancelled) return;
      cancelled = true;
      clearRetryTimer();
      closePeerConnection();
      abortInFlightFetch();
    }

    function scheduleRetry(attemptIndex) {
      clearRetryTimer();
      const delay = whepBackoffMs(attemptIndex);
      retryTimer = setTimeoutImpl(() => { retryTimer = null; attempt(); }, delay);
    }

    function retryAfterStall() {
      if (cancelled) return;
      closePeerConnection();
      if (!isSessionActive()) { finish('session_inactive'); return; }
      transientAttempts += 1;
      onStatus('Preparando video…');
      scheduleRetry(transientAttempts - 1);
    }

    function armFirstFrameGate(video, ownerPc) {
      disposeFrameGate();
      clearFirstFrameTimer();
      frameGate = attachFirstFrameGate(video, {
        onFirstFrame: () => {
          if (cancelled || pc !== ownerPc) return;
          clearFirstFrameTimer();
          timing.mark('first_frame_at');
          onTiming(timing.raw(), timing.durations());
          onStatus('En vivo');
          onFirstFrame();
        },
        onStalled: () => { if (pc === ownerPc) retryAfterStall(); },
        onError: () => { if (pc === ownerPc) retryAfterStall(); },
      });
      firstFrameTimer = setTimeoutImpl(() => {
        firstFrameTimer = null;
        if (cancelled || pc !== ownerPc || frameGate?.hasFired()) return;
        retryAfterStall();
      }, firstFrameTimeoutMs);
    }

    function handleConnectionState(ownerPc) {
      if (cancelled || pc !== ownerPc) return;
      const state = ownerPc.connectionState;
      if (state === 'connected') {
        clearDisconnectTimer();
        if (timing.get('peer_connected_at') == null) {
          timing.mark('peer_connected_at');
          onTiming(timing.raw(), timing.durations());
        }
      } else if (state === 'failed' || state === 'closed') {
        retryAfterStall();
      } else if (state === 'disconnected') {
        if (disconnectTimer == null) {
          disconnectTimer = setTimeoutImpl(() => {
            disconnectTimer = null;
            if (!cancelled && pc === ownerPc) retryAfterStall();
          }, disconnectGraceMs);
        }
      }
    }

    function attempt() {
      if (cancelled || inFlight) return;
      if (!isSessionActive()) { finish('session_inactive'); return; }
      inFlight = true;
      runAttempt().finally(() => { inFlight = false; });
    }

    async function runAttempt() {
      closePeerConnection(); // nunca dos PeerConnection vivas a la vez
      abortInFlightFetch(); // ni dos fetch en vuelo

      timing.mark('whep_attempt_started_at');
      let localPc;
      try {
        localPc = pcFactory();
      } catch (_) {
        onStatus('No se pudo crear la conexion de video', true);
        finish('pc_create_failed');
        return;
      }
      if (cancelled) { try { localPc.close(); } catch (_) { /* noop */ } return; }
      pc = localPc;
      const controllerAbort = new AbortController();
      abortController = controllerAbort;

      if (typeof pc.addEventListener === 'function') {
        pc.addEventListener('connectionstatechange', () => handleConnectionState(localPc));
        pc.addEventListener('iceconnectionstatechange', () => handleConnectionState(localPc));
      }
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.ontrack = (ev) => {
        if (cancelled || pc !== localPc) return;
        const video = getVideoElement();
        if (!video) return;
        video.srcObject = ev.streams[0];
        armFirstFrameGate(video, localPc);
        const playPromise = video.play?.();
        if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {});
      };

      let status = null;
      let aborted = false;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await waitForIceGathering(pc);
        if (cancelled || pc !== localPc) return;
        onStatus('Preparando video…');
        const res = await fetchImpl(whepUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp', Accept: 'application/sdp' },
          body: localOfferSdp(pc),
          signal: controllerAbort.signal,
        });
        status = res.status;
        if (cancelled || pc !== localPc) return;
        if (res.ok) {
          const answer = await res.text();
          await pc.setRemoteDescription({ type: 'answer', sdp: answer });
          timing.mark('whep_accepted_at');
          onTiming(timing.raw(), timing.durations());
        }
      } catch (err) {
        if (err?.name === 'AbortError') aborted = true;
        else if (status == null) status = 0; // fallo de red antes de tener status
      }

      if (cancelled || pc !== localPc) return;

      const outcome = classifyWhepOutcome({ aborted, status });
      if (outcome === 'cancelled') return; // ya se estaba cancelando, en silencio
      if (outcome === 'success') {
        transientAttempts = 0;
        congestionAttempts = 0;
        onStatus('Recibiendo video…');
        return; // el pc sigue vivo esperando ontrack/primer frame
      }

      closePeerConnection();

      if (outcome === 'fatal_failure') {
        onStatus(
          status === 401 || status === 403
            ? 'No autorizado para reproducir esta sesion'
            : `No se pudo reproducir (${status})`,
          true,
        );
        finish('fatal_failure');
        return;
      }

      // transient_failure: 404 sigue reintentando sin tope (lo corta la
      // expiracion de la sesion); 409/503 tienen un tope propio.
      if (status === 409 || status === 503) {
        congestionAttempts += 1;
        if (congestionAttempts > maxCongestionRetries) {
          onStatus('El gateway sigue ocupado, se agotaron los reintentos', true);
          finish('congestion_retry_limit');
          return;
        }
      }
      transientAttempts += 1;
      onStatus('Preparando video…');
      scheduleRetry(transientAttempts - 1);
    }

    return {
      start(previewRequestedAt) {
        if (previewRequestedAt != null) timing.mark('preview_requested_at', previewRequestedAt);
        timing.mark('mediamtx_publisher_ready_at');
        attempt();
      },
      cancel,
      getTimingSnapshot: () => timing.raw(),
      getTimingDurations: () => timing.durations(),
    };
  }

  return {
    waitForIceGatheringComplete,
    localOfferSdp,
    classifyWhepOutcome,
    whepBackoffMs,
    createTimingMarks,
    attachFirstFrameGate,
    createWhepController,
    WHEP_BACKOFF_SEQUENCE_MS,
    MAX_CONGESTION_RETRIES,
    DEFAULT_FIRST_FRAME_TIMEOUT_MS,
    DEFAULT_DISCONNECT_GRACE_MS,
  };
}));
