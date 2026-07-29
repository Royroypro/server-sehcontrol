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

  return { waitForIceGatheringComplete, localOfferSdp };
}));
