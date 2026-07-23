#!/bin/sh
set -eu

source_dir=${1:-}
target_dir=${2:-./rustdesk-data}

if [ -z "$source_dir" ]; then
  echo "Uso: $0 /ruta/al/directorio/rustdesk [directorio-destino]" >&2
  exit 1
fi

for required_file in db_v2.sqlite3 id_ed25519 id_ed25519.pub; do
  if [ ! -f "$source_dir/$required_file" ]; then
    echo "Falta $source_dir/$required_file" >&2
    exit 1
  fi
done

mkdir -p "$target_dir"
cp "$source_dir/db_v2.sqlite3" "$target_dir/db_v2.sqlite3"
cp "$source_dir/id_ed25519" "$target_dir/id_ed25519"
cp "$source_dir/id_ed25519.pub" "$target_dir/id_ed25519.pub"
chmod 600 "$target_dir/id_ed25519"
chmod 644 "$target_dir/id_ed25519.pub" "$target_dir/db_v2.sqlite3"

echo "Datos importados en $target_dir"
