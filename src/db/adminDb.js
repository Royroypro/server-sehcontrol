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

module.exports = db;
