const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dbPath = path.resolve(__dirname, '../..', process.env.ADMIN_DB_PATH || './data/admin.sqlite3');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  create table if not exists plans (
    id integer primary key autoincrement,
    name varchar(100) not null unique,
    description text,
    max_devices integer not null default 1,
    price_cents integer not null default 0,
    currency varchar(10) not null default 'USD',
    duration_days integer not null default 30,
    is_public tinyint not null default 0,
    created_at datetime not null default (current_timestamp)
  );

  create table if not exists users (
    id integer primary key autoincrement,
    email varchar(255) not null unique,
    name varchar(150),
    password_hash text not null,
    role varchar(20) not null default 'client' check (role in ('admin','client')),
    plan_id integer references plans(id) on delete set null,
    plan_started_at datetime,
    plan_expires_at datetime,
    status varchar(20) not null default 'active' check (status in ('active','suspended')),
    created_at datetime not null default (current_timestamp)
  );

  create table if not exists devices (
    id integer primary key autoincrement,
    rustdesk_id varchar(100) not null unique,
    rustdesk_uuid text,
    alias varchar(150),
    owner_user_id integer not null references users(id) on delete cascade,
    claimed_by_user_id integer references users(id) on delete set null,
    claim_source varchar(30),
    claimed_at datetime not null default (current_timestamp)
  );

  create index if not exists idx_devices_owner on devices(owner_user_id);
  create index if not exists idx_users_plan on users(plan_id);

  -- Pagos y adelantos. days_added es opcional: si viene, el pago extiende
  -- plan_expires_at esos dias exactos (permite pagos parciales/adelantos que
  -- no coinciden con la duracion completa de un plan). Si no viene, es un
  -- pago registrado solo como historial (ej. adelanto que se aplicara despues).
  create table if not exists payments (
    id integer primary key autoincrement,
    receipt_number integer,
    user_id integer not null references users(id) on delete cascade,
    amount_cents integer not null,
    currency varchar(10) not null default 'USD',
    method varchar(20) not null default 'other' check (method in ('cash','transfer','card','other')),
    concept varchar(200),
    days_added integer,
    note varchar(300),
    status varchar(20) not null default 'paid' check (status in ('paid','pending')),
    registered_by integer references users(id) on delete set null,
    created_at datetime not null default (current_timestamp)
  );

  -- Avisos automaticos (vencimiento proximo, vencido, suspendido) y mensajes
  -- manuales que manda el admin. user_id null = mensaje broadcast a todos.
  -- dedupe_key evita mandar el mismo aviso automatico mas de una vez por
  -- ciclo de plan (se recalcula si el usuario renueva y cambia su fecha).
  create table if not exists alerts (
    id integer primary key autoincrement,
    user_id integer references users(id) on delete cascade,
    type varchar(30) not null check (type in ('expiry_warning','expired','suspended','payment_received','custom')),
    title varchar(200) not null,
    message varchar(1000) not null,
    dedupe_key varchar(200) unique,
    email_sent tinyint not null default 0,
    created_by integer references users(id) on delete set null,
    created_at datetime not null default (current_timestamp)
  );

  -- Lectura por usuario (separado de "alerts" porque un mensaje broadcast
  -- -user_id null- tiene muchos destinatarios: cada quien marca su propia
  -- lectura sin afectar a los demas).
  create table if not exists alert_reads (
    alert_id integer not null references alerts(id) on delete cascade,
    user_id integer not null references users(id) on delete cascade,
    read_at datetime not null default (current_timestamp),
    primary key (alert_id, user_id)
  );

  create table if not exists activity_log (
    id integer primary key autoincrement,
    actor_user_id integer references users(id) on delete set null,
    action varchar(100) not null,
    target_type varchar(50),
    target_id varchar(100),
    detail varchar(500),
    created_at datetime not null default (current_timestamp)
  );

  -- Info que el cliente RustDesk YA manda solo (protocolo estandar, sin
  -- ningun parche) a /api/sysinfo y /api/heartbeat cuando el api-server
  -- configurado no es rustdesk.com. Se guarda aparte de la tabla "peer" de
  -- hbbs porque esos endpoints los atiende este panel, no hbbs.
  create table if not exists device_sysinfo (
    rustdesk_id varchar(100) primary key,
    hostname varchar(200),
    os varchar(300),
    cpu varchar(200),
    memory varchar(50),
    username varchar(100),
    client_version varchar(50),
    last_heartbeat_at datetime,
    updated_at datetime not null default (current_timestamp)
  );

  -- Fila unica (id=1) con los datos de la plataforma: usados como encabezado
  -- de los comprobantes PDF y como moneda/idioma por defecto del panel.
  create table if not exists platform_settings (
    id integer primary key check (id = 1),
    business_name varchar(200) not null default 'Mi Empresa',
    tax_id varchar(50),
    address varchar(300),
    phone varchar(50),
    whatsapp_number varchar(50),
    contact_email varchar(200),
    default_currency varchar(10) not null default 'USD',
    language varchar(10) not null default 'es',
    updated_at datetime not null default (current_timestamp)
  );
  insert or ignore into platform_settings (id) values (1);

  create index if not exists idx_payments_user on payments(user_id);
  create index if not exists idx_alerts_user on alerts(user_id);
  create index if not exists idx_alerts_created on alerts(created_at);
  create index if not exists idx_activity_created on activity_log(created_at);
`);

// Migraciones livianas para bases ya creadas antes de agregar estas columnas
// ("create table if not exists" no altera tablas existentes).
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`pragma table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`alter table ${table} add column ${column} ${definition}`);
    return true;
  }
  return false;
}
addColumnIfMissing('plans', 'currency', "varchar(10) not null default 'USD'");
addColumnIfMissing('plans', 'description', 'text');
const addedPlanVisibility = addColumnIfMissing('plans', 'is_public', 'tinyint not null default 0');
if (addedPlanVisibility) {
  db.prepare("update plans set is_public = 1 where name in ('Free', 'Pro', 'Enterprise')").run();
}
addColumnIfMissing('users', 'name', 'varchar(150)');
addColumnIfMissing('payments', 'status', "varchar(20) not null default 'paid'");
addColumnIfMissing('payments', 'receipt_number', 'integer');
addColumnIfMissing('platform_settings', 'whatsapp_number', 'varchar(50)');
// Dias antes del vencimiento en los que se genera un aviso automatico
// (expiry_warning). JSON array de enteros, ej. '[10,7,5,3,1]'. Configurable
// desde el panel (Configuracion) -- ver src/notifications.js generateExpiryAlerts.
addColumnIfMissing('platform_settings', 'expiry_warning_days', "text not null default '[10,7,5,3,1]'");
// Duracion maxima de una sesion de previsualizacion de ScreenCam, en
// segundos. El default (300 = 5 minutos) es el mismo limite que ya regia
// hardcodeado en src/screenCamPreview.js -- este cambio no altera el
// comportamiento de ninguna instalacion existente hasta que un admin lo
// edite explicitamente desde Configuracion. Limites en
// src/screenCamPreview.js (PREVIEW_DURATION_MIN_SECONDS/MAX_SECONDS).
addColumnIfMissing('platform_settings', 'screen_cam_preview_duration_seconds', 'integer not null default 300');
// Version publicada de cada cliente descargable, y las notas que el cliente
// muestra al ofrecer la actualizacion. La declara el admin al subir el
// binario: el archivo se guarda con nombre fijo (sehcontrol.exe/.apk) y no
// lleva la version adentro de forma legible, asi que extraerla del binario
// seria adivinar. Vacio = no se anuncia ninguna actualizacion, que es el
// estado de cualquier instalacion existente hasta que un admin la declare.
addColumnIfMissing('platform_settings', 'client_version_windows', 'text');
addColumnIfMissing('platform_settings', 'client_notes_windows', 'text');
addColumnIfMissing('platform_settings', 'client_version_android', 'text');
addColumnIfMissing('platform_settings', 'client_notes_android', 'text');
addColumnIfMissing('platform_settings', 'client_version_linux', 'text');
addColumnIfMissing('platform_settings', 'client_notes_linux', 'text');
// Nombre con el que se subio el binario, para servirlo igual. No es
// cosmetico: el empaquetador portable de Windows decide que hacer segun su
// PROPIO nombre de archivo (libs/portable/src/main.rs, `click_setup`). Con
// "...install.exe" instala; con cualquier otro nombre se limita a extraerse
// en %LOCALAPPDATA% y ejecutarse como portable. Publicarlo renombrado a
// "sehcontrol.exe" convertia el instalador en un portable sin avisar.
addColumnIfMissing('platform_settings', 'client_filename_windows', 'text');
addColumnIfMissing('platform_settings', 'client_filename_android', 'text');
addColumnIfMissing('platform_settings', 'client_filename_linux', 'text');
// Tags de la libreta de direcciones "legacy" (categorias "Cabinas"/"Clientes"
// que pide el cliente). JSON array de strings, ej. '["Cabinas"]'.
addColumnIfMissing('devices', 'tags', "text not null default '[]'");
addColumnIfMissing('devices', 'rustdesk_uuid', 'text');
addColumnIfMissing('devices', 'claimed_by_user_id', 'integer references users(id) on delete set null');
addColumnIfMissing('devices', 'claim_source', 'varchar(30)');
// Identificador de hardware estable (machine-id/MachineGuid/IOPlatformUUID,
// hasheado) que el cliente manda en deviceInfo.machine_id. Permite reconocer
// la misma maquina fisica cuando el cliente se reinstala y RustDesk le asigna
// un id nuevo (ver deviceClaim.findDeviceByMachineId / migrateDeviceId).
addColumnIfMissing('devices', 'machine_id', 'text');
db.exec('create index if not exists idx_devices_machine on devices(owner_user_id, machine_id)');

// Un login aceptado prueba que el dispositivo fue visto al menos una vez.
// Completa instalaciones creadas antes de que el login actualizara
// last_heartbeat_at; el heartbeat periódico seguirá determinando "En linea".
db.prepare(`
  update device_sysinfo
  set last_heartbeat_at = (
    select max(l.created_at) from activity_log l
    where l.action = 'device_login'
      and l.target_type = 'device'
      and l.target_id = device_sysinfo.rustdesk_id
  )
  where last_heartbeat_at is null
    and exists (
      select 1 from activity_log l
      where l.action = 'device_login'
        and l.target_type = 'device'
        and l.target_id = device_sysinfo.rustdesk_id
    )
`).run();

// Versiones Android antiguas enviaron /sysinfo sin hostname/username y
// borraron esos campos antes de que el upsert preservara valores existentes.
// Recupera el ultimo dato confiable registrado durante /api/login.
const incompleteDeviceInfo = db.prepare(`
  select rustdesk_id from device_sysinfo
  where hostname is null or hostname = '' or username is null or username = ''
`).all();
const latestDeviceLogin = db.prepare(`
  select detail from activity_log
  where action = 'device_login' and target_type = 'device' and target_id = ?
  order by created_at desc limit 1
`);
const restoreDeviceInfo = db.prepare(`
  update device_sysinfo set
    hostname = coalesce(nullif(hostname, ''), ?),
    username = coalesce(nullif(username, ''), ?)
  where rustdesk_id = ?
`);
for (const row of incompleteDeviceInfo) {
  const activity = latestDeviceLogin.get(row.rustdesk_id);
  if (!activity?.detail) continue;
  try {
    const detail = JSON.parse(activity.detail);
    restoreDeviceInfo.run(detail.hostname || null, detail.username || null, row.rustdesk_id);
  } catch (_) {
    // Actividad histórica con formato libre: se conserva sin intentar migrar.
  }
}

// Numera con receipt_number los pagos viejos que quedaron sin numero (los
// que ya existian antes de agregar esta columna).
const maxReceipt = db.prepare('select coalesce(max(receipt_number), 0) n from payments').get().n;
const unnumbered = db.prepare('select id from payments where receipt_number is null order by created_at asc').all();
if (unnumbered.length) {
  const assign = db.prepare('update payments set receipt_number = ? where id = ?');
  const tx = db.transaction((rows) => {
    let next = maxReceipt + 1;
    for (const r of rows) assign.run(next++, r.id);
  });
  tx(unnumbered);
}

// Licenciamiento del modulo ScreenCam (pantalla -> RTSP), jerarquia
// plan -> cliente -> dispositivo (el override mas especifico pisa al mas
// general). "enabled" nulo en customer_modules/device_screen_cam_settings
// significa "sin override, heredar del nivel anterior" -- ver
// src/screenCamPolicy.js (resolvePolicy) para la logica de resolucion.
db.exec(`
  create table if not exists plan_modules (
    plan_id integer not null references plans(id) on delete cascade,
    module varchar(50) not null,
    enabled tinyint not null default 0,
    mode varchar(20) not null default 'managed' check (mode in ('local','managed','supervised')),
    max_streams integer not null default 1,
    primary key (plan_id, module)
  );

  create table if not exists customer_modules (
    user_id integer not null references users(id) on delete cascade,
    module varchar(50) not null,
    enabled tinyint,
    mode varchar(20) check (mode in ('local','managed','supervised')),
    max_streams integer,
    primary key (user_id, module)
  );

  -- rustdesk_id sin "references devices(rustdesk_id)" a proposito: ese valor
  -- cambia en una reinstalacion (ver deviceClaim.migrateDeviceId, que mueve
  -- esta fila igual que ya hace con device_sysinfo). Una FK con el pragma
  -- foreign_keys=ON activo violaria integridad referencial durante ese UPDATE
  -- si no se declara ON UPDATE CASCADE, asi que se maneja a mano.
  create table if not exists device_screen_cam_settings (
    rustdesk_id varchar(100) primary key,
    enabled tinyint,
    desired_state varchar(20) not null default 'stopped' check (desired_state in ('running','stopped')),
    mode varchar(20) check (mode in ('local','managed','supervised')),
    max_streams integer,
    actual_state varchar(20),
    encoder varchar(50),
    last_error varchar(300),
    rtsp_clients integer,
    last_report_at datetime,
    updated_at datetime not null default (current_timestamp)
  );
`);

// Direccion RTSP local reportada por heartbeat (ver docs/CLIENT_INTEGRATION.md
// seccion 12.1): separado en ip/puerto en vez de una url ya armada, para que
// el servidor decida el formato de presentacion sin parsear nada del cliente.
addColumnIfMissing('device_screen_cam_settings', 'local_ip', 'varchar(50)');
addColumnIfMissing('device_screen_cam_settings', 'rtsp_port', 'integer');
// Puertos elegidos por el admin, que NO son lo mismo que el rtsp_port de
// arriba: aquel es el que el equipo *reporta* estar usando (heartbeat), este
// es el que se le *ordena* usar. Por eso el sufijo _override y por eso son
// columnas distintas -- compartirlas haria que el primer heartbeat del equipo
// pisara la decision del administrador.
//
// null = sin override: el equipo usa 554/80, que es lo que un Dahua o un
// Hikvision asumen al darlo de alta por IP. Solo hacen falta cuando esos
// puertos ya estan ocupados en esa maquina.
addColumnIfMissing('device_screen_cam_settings', 'rtsp_port_override', 'integer');
addColumnIfMissing('device_screen_cam_settings', 'onvif_port_override', 'integer');
// Credenciales RTSP (Digest/Basic) por dispositivo -- el panel las genera y
// las manda al cliente via client-policy/WS, nunca al reves. Guardadas en
// texto plano: el cliente necesita el valor real para autenticar (no un
// hash), y esta base ya no se expone fuera del servidor. Ver
// docs/CLIENT_INTEGRATION.md seccion 14.
addColumnIfMissing('device_screen_cam_settings', 'rtsp_user', 'varchar(50)');
addColumnIfMissing('device_screen_cam_settings', 'rtsp_password', 'varchar(100)');
// Lo que el cliente reporta que aplico de verdad (heartbeat), para que el
// panel pueda detectar una desconfiguracion (el panel mando credenciales
// pero el equipo sigue con el stream abierto).
addColumnIfMissing('device_screen_cam_settings', 'reported_auth_enabled', 'tinyint');
addColumnIfMissing('device_screen_cam_settings', 'reported_rtsp_user', 'varchar(50)');

// Seleccion remota de pantalla (ver docs/CLIENT_INTEGRATION.md seccion 15).
// La seleccion se guarda por display_id, NO por indice: Windows reordena los
// indices al conectar/desconectar/duplicar monitores. El indice solo queda
// como referencia de respaldo dentro de screen_cam_displays.
addColumnIfMissing('device_screen_cam_settings', 'selected_display_id', 'varchar(200)');
addColumnIfMissing('device_screen_cam_settings', 'selected_display_name', 'varchar(200)');
addColumnIfMissing('device_screen_cam_settings', 'fallback_to_primary', 'tinyint not null default 1');
// Lo que el cliente reporta que esta capturando de verdad (heartbeat).
addColumnIfMissing('device_screen_cam_settings', 'active_display_id', 'varchar(200)');
addColumnIfMissing('device_screen_cam_settings', 'fallback_active', 'tinyint');
addColumnIfMissing('device_screen_cam_settings', 'display_warning', 'varchar(300)');
// Ultima lista de pantallas reportada, como JSON. Por dispositivo: cada
// equipo tiene su propia configuracion de monitores.
addColumnIfMissing('device_screen_cam_settings', 'displays', 'text');
addColumnIfMissing('device_screen_cam_settings', 'displays_updated_at', 'datetime');

// Sesiones temporales de previsualizacion de video (WebRTC). No se guarda
// video ni fragmentos: esta tabla solo registra quien pidio ver que equipo,
// cuando, y el token temporal de publicacion (reutilizable mientras la sesion
// siga viva). stopped, failed y expired impiden nuevos handshakes. Sirve ademas
// como registro de auditoria de quien abrio una vista en vivo.
db.exec(`
  create table if not exists screen_cam_preview_sessions (
    id varchar(40) primary key,
    rustdesk_id varchar(100) not null,
    requested_by integer references users(id) on delete set null,
    status varchar(20) not null default 'creating'
      check (status in ('creating','waiting_client','publishing','ready','stopped','expired','failed')),
    publish_token varchar(100) not null,
    playback_url varchar(500),
    error varchar(200),
    expires_at datetime not null,
    started_at datetime,
    ended_at datetime,
    created_at datetime not null default (current_timestamp)
  );
  create index if not exists idx_preview_device on screen_cam_preview_sessions(rustdesk_id, status);
`);
// Token separado para la REPRODUCCION en el navegador: el de publicacion
// (publish_token) nunca sale del cliente, y este nunca llega al equipo. Asi
// un token filtrado de un lado no sirve para el otro.
addColumnIfMissing('screen_cam_preview_sessions', 'read_token', 'varchar(100)');


// Sesiones persistentes del cliente nativo Sehcontrol.
//
// El token real nunca se guarda: solamente su SHA-256. rustdesk_id no tiene
// clave foranea porque puede cambiar cuando el cliente se reinstala. La
// pertenencia actual del dispositivo se comprueba al validar la sesion.
db.exec(`
  create table if not exists native_sessions (
    id varchar(36) primary key,
    token_hash varchar(64) not null unique,
    user_id integer not null references users(id) on delete cascade,
    rustdesk_id varchar(100),
    machine_id varchar(200),
    expires_at datetime not null,
    last_used_at datetime not null default (current_timestamp),
    revoked_at datetime,
    created_at datetime not null default (current_timestamp)
  );

  create index if not exists idx_native_sessions_user
    on native_sessions(user_id, revoked_at);

  create index if not exists idx_native_sessions_device
    on native_sessions(rustdesk_id, revoked_at);
`);

module.exports = db;
