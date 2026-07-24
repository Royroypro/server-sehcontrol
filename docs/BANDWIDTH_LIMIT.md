# Limitar el ancho de banda del relay (hbbr)

## Problema

RustDesk no tiene una opcion de configuracion para limitar el ancho de
banda por cliente. Si un cliente transfiere un archivo pesado (o mantiene
una sesion de pantalla remota muy intensa) a traves del relay (`hbbr`,
puertos TCP `21117` y `21119`), puede consumir todo el enlace y degradar
las sesiones de los demas clientes.

## Esto es por servidor, no por proyecto

El script queda versionado en el repo y llega a cualquier servidor que
haga `git pull`, pero **no se ejecuta solo ni forma parte de
`docker compose up`**. Es configuracion de sistema operativo (`tc`), no de
la aplicacion, asi que hay que instalarlo y ajustarlo a mano en cada
servidor donde corra el stack (desarrollo, staging, produccion, etc.).

En particular, al pasar de desarrollo a produccion (u otro servidor
nuevo):

- **Volve a medir el enlace real** de ese servidor (los defaults del
  script, `25`/`10`/`40`/`20` Mbit/s, surgieron de medir la conexion WiFi
  de este servidor de desarrollo; un VPS/hosting de produccion casi
  seguro tiene una capacidad distinta, tipicamente mayor y simetrica) y
  pasa los valores correctos por variable de entorno.
- **Edita las rutas del archivo de servicio** `scripts/rustdesk-bandwidth-limit.service`
  (`ExecStart`/`ExecStop`) para que apunten a donde este clonado el repo
  en ese servidor.
- **Instala y habilita el `.service` ahi tambien** si queres que el limite
  sobreviva a un reinicio; no se propaga solo entre servidores.

## Solucion

`scripts/rustdesk-bandwidth-limit.sh` aplica traffic control (`tc`) a nivel
de sistema operativo para separar el trafico del relay del resto del
trafico del host, y dentro de esa porcion reparte el ancho de banda de
forma justa entre las conexiones activas (qdisc CAKE): si hay un solo
cliente transfiriendo, puede usar todo el cupo asignado al relay; si hay
varios al mismo tiempo, cada uno recibe automaticamente una porcion
equivalente, sin que ninguno pueda acaparar el resto.

El script shape tanto la subida (trafico que sale del servidor hacia los
clientes, en la interfaz WAN) como la bajada (trafico que los clientes
suben hacia el servidor, redirigido con un dispositivo `ifb` segun el
mecanismo estandar de Linux para dar forma al trafico entrante).

Esto es independiente de la aplicacion (panel/hbbs/hbbr no se tocan) y
funciona con `network_mode: host`, que es como corren los contenedores en
este proyecto.

## Uso manual

```bash
sudo ./scripts/rustdesk-bandwidth-limit.sh start    # aplica los limites
sudo ./scripts/rustdesk-bandwidth-limit.sh status    # muestra clases y contadores
sudo ./scripts/rustdesk-bandwidth-limit.sh stop      # quita los limites
```

Ajusta la capacidad segun tu enlace real con variables de entorno:

```bash
sudo RELAY_UP_MBIT=25 RELAY_DOWN_MBIT=10 LINK_UP_MBIT=40 LINK_DOWN_MBIT=20 \
  ./scripts/rustdesk-bandwidth-limit.sh start
```

- `RELAY_UP_MBIT` / `RELAY_DOWN_MBIT`: techo total (compartido entre todos
  los clientes activos) para el trafico del relay.
- `LINK_UP_MBIT` / `LINK_DOWN_MBIT`: capacidad total estimada del enlace,
  usada para reservar el resto del ancho de banda al panel/SSH/otros
  servicios del host.

Los valores por defecto (`25`/`10`/`40`/`20` Mbit/s) surgen de una medicion
real de este servidor. Volve a medir tu enlace (por ejemplo con un
speedtest) si la conexion cambia, y ajusta las variables.

## Dejarlo activo tras un reinicio del servidor

```bash
sudo cp scripts/rustdesk-bandwidth-limit.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rustdesk-bandwidth-limit.service
```

Edita las lineas `Environment=` comentadas en el archivo de servicio si
necesitas otros valores que los defaults del script.

## Verificar que esta funcionando

```bash
sudo ./scripts/rustdesk-bandwidth-limit.sh status
```

Muestra los contadores de paquetes/bytes por clase (`1:10` = relay,
`1:30` = resto del trafico) tanto en la interfaz WAN como en `ifb0`. Con
transferencias activas, `tc -s class show dev <iface>` deberia reflejar el
trafico pasando por la clase `1:10` sin superar el techo configurado.

## Limites de este enfoque

- El reparto justo (CAKE) es por conexion activa en cada instante, no una
  cuota por cliente a lo largo del tiempo: si un cliente termina su
  transferencia y se desconecta, el que sigue conectado vuelve a tener el
  cupo completo disponible.
- Los techos (`RELAY_UP_MBIT`/`RELAY_DOWN_MBIT`) son un limite duro para
  *todo* el relay en conjunto, no por cliente individual. Si se necesita
  ademas un tope maximo por cliente (por ejemplo, "ningun cliente puede
  pasar de 5 Mbit/s aunque este solo"), se puede extender el script para
  clasificar por IP de origen/destino en vez de (o ademas de) por puerto;
  eso requiere mantener una clase HTB por IP activa.
