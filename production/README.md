# Despliegue de produccion

Destino preparado:

- Ubuntu 20.04.6 LTS, `amd64`.
- `sehcontrol.sehuacho.com`.
- Nginx y HTTPS en `443`.
- Panel enlazado solo a `127.0.0.1:8899`.
- RustDesk ID y relay en `sehcontrol.sehuacho.com:21117`.

## 1. Instalar el paquete

Descarga y descomprime el paquete de la version en:

```bash
mkdir -p /home/ubuntu/server-sehcontrol
cd /home/ubuntu/server-sehcontrol
tar -xzf sehcontrol-production-2026.07.23.1-amd64.tar.gz
```

El paquete no contiene contrasenas ni claves privadas.

## 2. Configurar secretos

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 48
nano .env
```

Coloca el resultado aleatorio en `JWT_SECRET` y define
`DEFAULT_ADMIN_PASSWORD`. El correo ya queda configurado como
`admin@sehuacho.com`. La contrasena solo se usa al crear la base por primera
vez; cambiar el archivo despues no modifica un administrador existente.

## 3. Instalar la clave RustDesk existente

```bash
mkdir -p data rustdesk-data public/client
chmod 700 rustdesk-data
nano rustdesk-data/id_ed25519
nano rustdesk-data/id_ed25519.pub
chmod 600 rustdesk-data/id_ed25519
chmod 644 rustdesk-data/id_ed25519.pub
```

La clave publica esperada es:

```text
20WVH2iU16txMRGam1ciZqhVfzfAJlFzNhgSdAFHWwk=
```

No copies la clave privada al repositorio ni al paquete. Debe escribirse
directamente en el servidor y corresponder a esa clave publica.

## 4. Cargar imagenes precompiladas

```bash
chmod +x load-images.sh
./load-images.sh
```

El script verifica primero `SHA256SUMS` y luego importa las dos imagenes
Docker. No compila nada.

## 5. Iniciar Sehcontrol

```bash
docker compose -f compose.yaml config
docker compose -f compose.yaml up -d
docker compose -f compose.yaml ps
curl --fail http://127.0.0.1:8899/health
```

El puerto `8899` debe permanecer bloqueado en UFW. Los puertos RustDesk
permitidos son TCP `21115`, `21116`, `21117`, `21118`, `21119` y UDP `21116`.

## 6. Activar Nginx

```bash
sudo cp nginx-sehcontrol.conf /etc/nginx/sites-available/sehcontrol
sudo ln -s /etc/nginx/sites-available/sehcontrol /etc/nginx/sites-enabled/sehcontrol
sudo nginx -t
sudo systemctl reload nginx
curl --fail https://sehcontrol.sehuacho.com/health
```

Si el enlace ya existe, no vuelvas a crearlo. La configuracion utiliza el
certificado existente de Let's Encrypt.

## 7. Comprobacion final

```bash
docker compose -f compose.yaml logs --tail=100 panel hbbs hbbr
ss -lntup | grep -E '8899|2111[5-9]'
```

Abre `https://sehcontrol.sehuacho.com/admin/`, inicia sesion y cambia la
contrasena inicial. Confirma en Configuracion que la clave publica mostrada
coincide con la indicada arriba.
