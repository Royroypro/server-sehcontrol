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

### Sesiones del cliente nativo

El panel web conserva una cookie JWT de 12 horas. El cliente nativo Sehcontrol
recibe una sesión opaca persistente, almacenada localmente en el mismo campo
`access_token` que ya utiliza el cliente. Por eso no requiere un flujo nuevo de
inicio de sesión ni cambios de protocolo.

El servidor guarda solamente el hash SHA-256 del token. La sesión:

- vence después de `NATIVE_SESSION_TTL_DAYS` días sin uso;
- renueva su vencimiento como máximo una vez cada
  `NATIVE_SESSION_TOUCH_INTERVAL_HOURS` horas;
- queda vinculada al usuario y, cuando está disponible, al equipo;
- se revoca al cerrar sesión, cambiar la contraseña o suspender la cuenta.

Los valores predeterminados son 90 días de inactividad y una actualización
máxima cada 24 horas. Se aceptan entre 1 y 365 días, y entre 1 y 168 horas,
respectivamente. Los JWT nativos emitidos antes de esta migración continúan
funcionando únicamente hasta completar sus 12 horas originales.

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

## Produccion

`production/README.md` cubre el despliegue del paquete ya compilado en
`sehcontrol.sehuacho.com`. Para generar ese paquete a partir del codigo
fuente (compilar las imagenes, empaquetarlas y firmarlas), ver
[`docs/BUILD_PRODUCTION.md`](docs/BUILD_PRODUCTION.md).
