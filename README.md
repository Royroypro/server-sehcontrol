# Sehcontrol

Despliegue unificado del panel de administracion Sehcontrol y RustDesk Server
OSS. Incluye:

- `panel`: usuarios, membresias, pagos, equipos, alertas y API RustDesk.
- `hbbs`: registro de IDs, rendezvous y senalizacion.
- `hbbr`: relay para conexiones que no pueden ser directas.
- `mysql`: servicio opcional preparado para una migracion futura del panel.

`hbbs` se compila desde el commit fijado en `RUSTDESK_SERVER_COMMIT` y aplica
`patches/rustdesk-membership.patch`. Ese parche hace cumplir los bloqueos que
el panel escribe en `peer.status`; no debe sustituirse por la imagen OSS
oficial sin portar primero el parche.

## Desplegar

1. Crea la configuracion y cambia las contrasenas:

   ```bash
   cp .env.example .env
   ```

2. Define `RUSTDESK_RELAY_HOST` con el dominio o IP publica del servidor.

3. Inicia todo:

   ```bash
   mkdir -p data rustdesk-data
   docker compose up -d --build
   ```

4. Comprueba los servicios:

   ```bash
   docker compose ps
   docker compose logs -f panel hbbs hbbr
   ```

El panel queda en `http://<servidor>:8899/admin/`. Los clientes RustDesk usan
el valor de `RUSTDESK_RELAY_HOST` como servidor ID/relay y la clave publica
generada en `rustdesk-data/id_ed25519.pub`.

El despliegue usa red host, recomendada por la documentacion oficial de
RustDesk para Linux. Deben estar permitidos:

- TCP `21115`, `21116`, `21117`, `21118` y `21119`.
- UDP `21116`.
- TCP `8899` para el panel.

Para evitar que un cliente transfiriendo archivos pesados sature el enlace
en perjuicio de los demas, ver
[`docs/BANDWIDTH_LIMIT.md`](docs/BANDWIDTH_LIMIT.md).

## Importar una instalacion existente

Deten primero los procesos o contenedores antiguos de `hbbs` y `hbbr` para que
SQLite consolide su WAL. Luego importa la base y las claves:

```bash
./scripts/import-rustdesk-data.sh /ruta/al/directorio/rustdesk
docker compose up -d --build
```

En este servidor, la instalacion binaria detectada esta en:

```bash
./scripts/import-rustdesk-data.sh /home/server3/rustdesk-server-bin/run
```

Conservar `id_ed25519` evita que todos los clientes tengan que cambiar la clave
del servidor.

## Persistencia y actualizaciones

`data/` contiene la base del panel. `rustdesk-data/` contiene la base y las
claves de RustDesk. Ambos directorios estan excluidos de Git.

```bash
git pull
docker compose up -d --build
```

La preparacion para MySQL esta explicada en
`docs/MYSQL_MIGRATION.md`. MySQL no se inicia ni se usa por defecto.

## Expiracion de ScreenCam Preview

Al arrancar el servidor se ejecuta inmediatamente un barrido de sesiones de
ScreenCam Preview y luego se repite cada 30 segundos. El scheduler usa
`setTimeout()` recursivo con `unref()`, por lo que su temporizador no mantiene
vivo el proceso por si solo.

Cada barrido marca primero en SQLite las sesiones vencidas y encola su cleanup
asincrono sin esperar a MediaMTX. Las comprobaciones oportunistas que ya se
ejecutan al iniciar una preview y durante media-auth siguen activas. El TTL
total permanece en 300 segundos y la espera inicial para sesiones que aun no
publicaron permanece en 120 segundos.

Durante `SIGTERM` o `SIGINT` se detiene el scheduler, se deja de aceptar nuevas
conexiones HTTP y se espera el drenaje de la cola de cleanup durante un maximo
de 5 segundos. El timeout no cancela ni descarta tareas que ya estuvieran
pendientes o activas.

## Produccion

`production/README.md` cubre el despliegue del paquete ya compilado en
`sehcontrol.sehuacho.com`. Para generar ese paquete a partir del codigo
fuente (compilar las imagenes, empaquetarlas y firmarlas), ver
[`docs/BUILD_PRODUCTION.md`](docs/BUILD_PRODUCTION.md).
