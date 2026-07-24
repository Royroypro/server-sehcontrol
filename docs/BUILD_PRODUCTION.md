# Compilar el paquete de produccion

Este documento cubre el paso que falta antes de `production/README.md`
(que solo despliega): como compilar las imagenes Docker desde el codigo
fuente y armar el paquete `sehcontrol-production-<version>-amd64.tar.gz`
que ese README instala en el servidor.

El resultado de este proceso no compila nada en el servidor de
produccion: las imagenes van precompiladas dentro del paquete, y
`load-images.sh` solo las importa (`docker load`).

## Requisitos

- Docker con `buildx` en un host `amd64` (o agregar `--platform linux/amd64`
  si se compila desde otra arquitectura, por ejemplo un Mac con Apple
  Silicon).
- Definir un numero de version para el release. Convencion usada hasta
  ahora: `AAAA.MM.DD` y, si hay mas de un build el mismo dia, `AAAA.MM.DD.N`
  (ejemplo: `2026.07.24.1`).

## 1. Elegir la version y preparar variables

```bash
VERSION=2026.07.24.1
RUSTDESK_TAG=1.1.16-membership-amd64
PANEL_IMAGE="sehcontrol-panel:${VERSION}-amd64"
RUSTDESK_IMAGE="sehcontrol-rustdesk-server:${RUSTDESK_TAG}"
OUTDIR="dist/production-${VERSION}-amd64"
mkdir -p "$OUTDIR"
```

`RUSTDESK_TAG` solo cambia si se toco
`patches/rustdesk-membership.patch` o `RUSTDESK_SERVER_COMMIT` en
`Dockerfile.rustdesk`. Si no cambio nada, se reutiliza el mismo tag y no
hace falta reconstruir esa imagen (paso 3).

## 2. Compilar la imagen del panel

```bash
docker build --platform linux/amd64 -t "$PANEL_IMAGE" .
```

Usa `Dockerfile` (Node 22, `npm ci --omit=dev`, corre como usuario
`node`).

## 3. Compilar (o reutilizar) la imagen de rustdesk-server

Reconstruir solo si cambio el patch o el commit fijado:

```bash
docker build --platform linux/amd64 -f Dockerfile.rustdesk -t "$RUSTDESK_IMAGE" .
```

`Dockerfile.rustdesk` clona `rustdesk/rustdesk-server` en el commit fijado
por `RUSTDESK_SERVER_COMMIT` y aplica
`patches/rustdesk-membership.patch`, que hace cumplir los bloqueos que el
panel escribe en `peer.status`. No sustituir por la imagen OSS oficial sin
portar primero ese parche (mismo aviso que el README principal).

Si no cambio nada, saltar este paso: la imagen `$RUSTDESK_IMAGE` ya existe
en el daemon local de un build anterior.

## 4. Exportar las imagenes comprimidas

```bash
docker save "$PANEL_IMAGE" | gzip > "$OUTDIR/sehcontrol-panel-${VERSION}-amd64.tar.gz"
docker save "$RUSTDESK_IMAGE" | gzip > "$OUTDIR/sehcontrol-rustdesk-server-${RUSTDESK_TAG}.tar.gz"
```

## 5. Generar SHA256SUMS

```bash
(cd "$OUTDIR" && sha256sum \
  "sehcontrol-panel-${VERSION}-amd64.tar.gz" \
  "sehcontrol-rustdesk-server-${RUSTDESK_TAG}.tar.gz" \
  > SHA256SUMS)
```

`load-images.sh` verifica este archivo antes de cargar las imagenes.

## 6. Generar IMAGE-METADATA.txt

```bash
{
  echo "Sehcontrol production build ${VERSION}"
  echo "Platform: linux/amd64"
  echo
  for IMG in "$PANEL_IMAGE" "$RUSTDESK_IMAGE"; do
    echo "Image: $IMG"
    echo "Docker image ID: $(docker image inspect "$IMG" --format '{{.Id}}')"
    echo "Uncompressed size: $(docker image inspect "$IMG" --format '{{.Size}}') bytes"
    echo
  done
  echo "Archive SHA-256 values are stored in SHA256SUMS inside the release package."
} > "$OUTDIR/IMAGE-METADATA.txt"
```

Mismo formato que ya trae el paquete actual (ver `IMAGE-METADATA.txt` en
la raiz del repo como referencia).

## 7. Actualizar y copiar la configuracion de despliegue

`production/` en el repo mantiene siempre la configuracion vigente para el
proximo release: `compose.yaml`, `.env.example`, `nginx-sehcontrol.conf`,
`load-images.sh` y `README.md` (el doc de despliegue). Antes de copiarla,
actualiza los tags de imagen en `production/compose.yaml` para que
coincidan con `$PANEL_IMAGE` y `$RUSTDESK_IMAGE` (a diferencia del
`compose.yaml` de la raiz, que usa un tag `-local` para desarrollo, el de
`production/` debe llevar los tags versionados que se acaban de compilar).

```bash
cp production/compose.yaml production/.env.example \
   production/nginx-sehcontrol.conf production/load-images.sh \
   production/README.md \
   "$OUTDIR/"
chmod +x "$OUTDIR/load-images.sh"
```

## 8. Empaquetar todo en un .tar.gz distribuible

```bash
tar -czf "dist/sehcontrol-production-${VERSION}-amd64.tar.gz" \
  -C dist "production-${VERSION}-amd64"
sha256sum "dist/sehcontrol-production-${VERSION}-amd64.tar.gz" \
  > "dist/sehcontrol-production-${VERSION}-amd64.tar.gz.sha256"
```

`dist/` esta excluido de git (`.gitignore`); estos paquetes se distribuyen
por fuera del repositorio, no se commitean.

## 9. Verificar el paquete antes de subirlo

Probarlo en un directorio limpio (o un servidor de staging) antes de
tocar produccion:

```bash
mkdir -p /tmp/sehcontrol-verify && cd /tmp/sehcontrol-verify
tar -xzf "/ruta/al/repo/dist/sehcontrol-production-${VERSION}-amd64.tar.gz"
cd "production-${VERSION}-amd64"
sha256sum --check SHA256SUMS
./load-images.sh
```

Confirma que `load-images.sh` termina mostrando los dos `RepoTags`
esperados sin errores, y que el `Docker image ID` de cada imagen coincide
con el que quedo en `IMAGE-METADATA.txt`.

## 10. Publicar

Segui `production/README.md` con el `.tar.gz` recien generado para
instalarlo en `sehcontrol.sehuacho.com`.
