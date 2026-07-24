#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
sha256sum --check SHA256SUMS
gzip --decompress --stdout sehcontrol-panel-2026.07.24.1-amd64.tar.gz | docker load
gzip --decompress --stdout sehcontrol-rustdesk-server-1.1.16-membership-amd64.tar.gz | docker load
docker image inspect \
  sehcontrol-panel:2026.07.24.1-amd64 \
  sehcontrol-rustdesk-server:1.1.16-membership-amd64 \
  --format '{{.RepoTags}} {{.Architecture}} {{.Id}}'
