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
    alias varchar(150),
    owner_user_id integer not null references users(id) on delete cascade,
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
// Tags de la libreta de direcciones "legacy" (categorias "Cabinas"/"Clientes"
// que pide el cliente). JSON array de strings, ej. '["Cabinas"]'.
addColumnIfMissing('devices', 'tags', "text not null default '[]'");

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

module.exports = db;
