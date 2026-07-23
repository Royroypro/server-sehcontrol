# Preparacion para migrar el panel a MySQL

## Alcance

El panel usa actualmente `better-sqlite3` y consultas sincronas. El servidor
RustDesk OSS (`hbbs`/`hbbr`) tambien conserva su propia `db_v2.sqlite3`.

La futura migracion a MySQL cubre solamente `data/admin.sqlite3`. La base de
RustDesk debe permanecer en SQLite mientras se use RustDesk Server OSS.

## Lo que ya queda preparado

- `database/mysql/schema.sql` reproduce las tablas del panel en MySQL 8.4.
- El servicio `mysql` de `compose.yaml` esta aislado en el perfil `mysql`.
- Los datos de MySQL persisten en el volumen `mysql-data`.

Para levantarlo sin conectarlo aun al panel:

```bash
docker compose --profile mysql up -d mysql
```

## Cambios de aplicacion pendientes

1. Sustituir el acceso directo a `better-sqlite3` por una capa de repositorios
   asincrona.
2. Agregar un driver MySQL y una variable `DATABASE_URL`.
3. Convertir funciones SQLite como `datetime('now')`, `insert or ignore`,
   `pragma` y `lastInsertRowid` a sus equivalentes de MySQL.
4. Ejecutar pruebas de rutas, pagos, alertas y sincronizacion de membresias.
5. Crear un exportador que copie las tablas en orden de dependencias y compare
   conteos antes del cambio.
6. Hacer el corte con el panel detenido, una copia de seguridad y una ventana
   de rollback hacia SQLite.

No se debe apuntar el panel al contenedor MySQL hasta completar esos cambios:
la presencia del esquema es preparacion, no una migracion activa.
