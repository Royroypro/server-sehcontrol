#!/usr/bin/env bash
# Limita y reparte de forma justa el ancho de banda del relay de RustDesk
# (hbbr/hbbs, puertos TCP 21117 y 21119) para que un solo cliente
# transfiriendo archivos pesados no sature la conexion y afecte a los demas.
#
# Mecanismo: en la interfaz WAN se separa el trafico del relay en una clase
# HTB con techo propio; dentro de esa clase se usa CAKE, que reparte el ancho
# de banda disponible en partes iguales entre las conexiones activas en cada
# momento (a mas clientes conectados, menor la porcion de cada uno; si hay
# uno solo, puede usar todo el techo). El resto del trafico del host (panel,
# SSH, etc.) queda en una clase separada que no compite por ese cupo.
#
# El ingreso (datos que los clientes suben hacia el relay) se shape via un
# dispositivo ifb, que es la forma estandar en Linux de aplicar tc a trafico
# entrante.
#
# Uso: rustdesk-bandwidth-limit.sh {start|stop|restart|status}
#
# Variables de entorno (todas opcionales, con defaults):
#   IFACE            interfaz WAN (default: la de la ruta por defecto)
#   RELAY_PORTS      puertos TCP del relay (default: "21117 21119")
#   RELAY_UP_MBIT    techo de subida para el relay, en Mbit/s (default: 25)
#   RELAY_DOWN_MBIT  techo de bajada para el relay, en Mbit/s (default: 10)
#   LINK_UP_MBIT     capacidad total de subida del enlace (default: 40)
#   LINK_DOWN_MBIT   capacidad total de bajada del enlace (default: 20)
#   IFB_DEV          nombre del dispositivo ifb (default: ifb0)
#
# Los valores por defecto surgen de una medicion real de este enlace
# (~40 Mbit/s de subida, ~15-20 Mbit/s de bajada) dejando margen para el
# resto del trafico del host. Ajustalos a la capacidad real de tu conexion.

set -euo pipefail

IFACE="${IFACE:-$(ip route show default | awk '/default/ {print $5; exit}')}"
RELAY_PORTS="${RELAY_PORTS:-21117 21119}"
RELAY_UP_MBIT="${RELAY_UP_MBIT:-25}"
RELAY_DOWN_MBIT="${RELAY_DOWN_MBIT:-10}"
LINK_UP_MBIT="${LINK_UP_MBIT:-40}"
LINK_DOWN_MBIT="${LINK_DOWN_MBIT:-20}"
IFB_DEV="${IFB_DEV:-ifb0}"

REST_UP_MBIT=$((LINK_UP_MBIT - RELAY_UP_MBIT))
if [ "$REST_UP_MBIT" -lt 1 ]; then
  REST_UP_MBIT=1
fi

require_root() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Este script necesita root (usa sudo)." >&2
    exit 1
  fi
}

require_iface() {
  if [ -z "$IFACE" ]; then
    echo "No se pudo detectar la interfaz WAN. Definila con IFACE=..." >&2
    exit 1
  fi
  if ! ip link show "$IFACE" >/dev/null 2>&1; then
    echo "La interfaz '$IFACE' no existe." >&2
    exit 1
  fi
}

teardown() {
  tc qdisc del dev "$IFACE" root 2>/dev/null || true
  tc qdisc del dev "$IFACE" ingress 2>/dev/null || true
  if ip link show "$IFB_DEV" >/dev/null 2>&1; then
    tc qdisc del dev "$IFB_DEV" root 2>/dev/null || true
    ip link set dev "$IFB_DEV" down 2>/dev/null || true
  fi
}

setup_egress() {
  tc qdisc add dev "$IFACE" root handle 1: htb default 30

  # Clase padre = capacidad total de subida del enlace.
  tc class add dev "$IFACE" parent 1: classid 1:1 htb \
    rate "${LINK_UP_MBIT}mbit" ceil "${LINK_UP_MBIT}mbit" quantum 15000

  # Clase del relay RustDesk: techo propio + CAKE para reparto justo
  # entre las conexiones activas en ese momento.
  tc class add dev "$IFACE" parent 1:1 classid 1:10 htb \
    rate "${RELAY_UP_MBIT}mbit" ceil "${RELAY_UP_MBIT}mbit" quantum 15000
  tc qdisc add dev "$IFACE" parent 1:10 handle 10: cake

  # Clase por defecto: resto del trafico del host (panel, SSH, etc.), con
  # prioridad para no competir con el relay pero pudiendo usar el enlace
  # completo cuando el relay no lo esta usando.
  tc class add dev "$IFACE" parent 1:1 classid 1:30 htb \
    rate "${REST_UP_MBIT}mbit" ceil "${LINK_UP_MBIT}mbit" prio 0 quantum 15000

  local port
  for port in $RELAY_PORTS; do
    tc filter add dev "$IFACE" protocol ip parent 1: prio 1 u32 \
      match ip sport "$port" 0xffff flowid 1:10
  done
}

setup_ingress() {
  if ! lsmod | grep -q '^ifb'; then
    modprobe ifb numifbs=1 2>/dev/null || modprobe ifb || true
  fi
  if ! ip link show "$IFB_DEV" >/dev/null 2>&1; then
    ip link add "$IFB_DEV" type ifb
  fi
  ip link set dev "$IFB_DEV" up

  tc qdisc add dev "$IFACE" handle ffff: ingress

  local port
  for port in $RELAY_PORTS; do
    tc filter add dev "$IFACE" parent ffff: protocol ip u32 \
      match ip dport "$port" 0xffff \
      action mirred egress redirect dev "$IFB_DEV"
  done

  # Todo lo que llega a ifb0 ya es solo trafico del relay (filtrado arriba),
  # asi que alcanza con una unica clase con techo + CAKE.
  tc qdisc add dev "$IFB_DEV" root handle 1: htb default 10
  tc class add dev "$IFB_DEV" parent 1: classid 1:10 htb \
    rate "${RELAY_DOWN_MBIT}mbit" ceil "${RELAY_DOWN_MBIT}mbit" quantum 15000
  tc qdisc add dev "$IFB_DEV" parent 1:10 handle 10: cake
}

start() {
  require_root
  require_iface
  teardown
  setup_egress
  setup_ingress
  echo "Shaping activo en $IFACE (subida) / $IFB_DEV (bajada) para puertos: $RELAY_PORTS"
  echo "  Relay: ${RELAY_UP_MBIT}mbit subida / ${RELAY_DOWN_MBIT}mbit bajada (reparto justo con CAKE)"
  echo "  Resto del host: hasta ${LINK_UP_MBIT}mbit subida"
}

stop() {
  require_root
  require_iface
  teardown
  echo "Shaping removido de $IFACE / $IFB_DEV."
}

status() {
  require_iface
  echo "== $IFACE (egreso) =="
  tc -s qdisc show dev "$IFACE"
  echo
  echo "== $IFACE (ingreso) =="
  tc -s qdisc show dev "$IFACE" ingress 2>/dev/null || echo "(sin qdisc de ingreso)"
  echo
  if ip link show "$IFB_DEV" >/dev/null 2>&1; then
    echo "== $IFB_DEV (bajada del relay) =="
    tc -s qdisc show dev "$IFB_DEV"
    echo
    tc -s class show dev "$IFB_DEV"
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  *)
    echo "Uso: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
