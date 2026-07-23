#!/bin/sh
set -eu

service_name=${1:-}
if [ "$service_name" != "hbbs" ] && [ "$service_name" != "hbbr" ]; then
  echo "El primer argumento debe ser hbbs o hbbr" >&2
  exit 1
fi

marker="/root/.reload-$service_name"

stop_child() {
  if [ "${child_pid:-0}" -gt 0 ] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid"
    wait "$child_pid" || true
  fi
}
trap 'stop_child; exit 0' TERM INT

while true; do
  rm -f "$marker"
  "$@" &
  child_pid=$!
  reload=0

  while kill -0 "$child_pid" 2>/dev/null; do
    if [ -f "$marker" ]; then
      reload=1
      stop_child
      break
    fi
    sleep 2
  done

  if [ "$reload" -eq 1 ]; then
    continue
  fi

  wait "$child_pid"
  exit $?
done
