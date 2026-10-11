#!/usr/bin/env bash
# Shared Ampere VM: keep Caddy on :80/:443 (portfolio + documind).
# CRM API listens on 127.0.0.1/0.0.0.0:3010 (host :3000 is wa-bridge).
set -euo pipefail

HOST=bismillah-crm.duckdns.org
APP=/opt/bismillah/current
NODE_DIR=/usr/local/lib/nodejs
export DEBIAN_FRONTEND=noninteractive

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo bash $0" >&2
  exit 1
fi

echo "==> swap (2G) so Chromium + CRM can coexist"
if ! swapon --show | grep -q .; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile || true
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> packages"
apt-get update -y
apt-get install -y curl xz-utils build-essential python3 ca-certificates \
  postgresql postgresql-contrib redis-server iptables-persistent

echo "==> Node 22 ARM64 (leave /usr/bin/node 18 for pm2 wa-bridge)"
if ! "$NODE_DIR/bin/node" -v 2>/dev/null | grep -q '^v22'; then
  mkdir -p /usr/local/lib
  tarball=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ \
    | grep -oE 'node-v22\.[0-9]+\.[0-9]+-linux-arm64.tar.xz' | head -1)
  if [ -z "$tarball" ]; then
    echo "could not find node 22 arm64 tarball" >&2
    exit 1
  fi
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/${tarball}" -o /tmp/node22.tar.xz
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xJf /tmp/node22.tar.xz -C "$NODE_DIR" --strip-components=1
  rm -f /tmp/node22.tar.xz
fi
"$NODE_DIR/bin/node" -v
export PATH="$NODE_DIR/bin:$PATH"

echo "==> postgres + redis loopback"
sed -i "s/^#\?listen_addresses.*/listen_addresses = '127.0.0.1'/" /etc/postgresql/*/main/postgresql.conf || true
sed -i 's/^bind .*/bind 127.0.0.1/' /etc/redis/redis.conf
sed -i 's/^#\?appendonly .*/appendonly yes/' /etc/redis/redis.conf
systemctl enable --now postgresql redis-server
systemctl restart redis-server

echo "==> app user + dirs"
id bismillah >/dev/null 2>&1 || adduser --system --group --home /opt/bismillah bismillah
mkdir -p /opt/bismillah /etc/bismillah /var/log/bismillah /var/lib/bismillah/imports \
  /var/backups/bismillah /opt/bismillah/current
chown -R bismillah:bismillah /opt/bismillah /var/log/bismillah /var/lib/bismillah /var/backups/bismillah
chown root:bismillah /etc/bismillah
chmod 750 /etc/bismillah

echo "==> secrets"
if [ ! -f /etc/bismillah/api.env ]; then
  DB_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
  JWT="$(openssl rand -base64 48)"
  sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bismillah') THEN
    CREATE ROLE bismillah LOGIN PASSWORD '${DB_PASS}';
  ELSE
    ALTER ROLE bismillah PASSWORD '${DB_PASS}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE bismillah OWNER bismillah'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'bismillah')\gexec
GRANT ALL PRIVILEGES ON DATABASE bismillah TO bismillah;
SQL
  cat >/etc/bismillah/api.env <<EOF
DATABASE_URL=postgres://bismillah:${DB_PASS}@127.0.0.1:5432/bismillah
REDIS_URL=redis://127.0.0.1:6379
PG_POOL_MAX=8
JWT_SECRET=${JWT}
PORT=3010
LISTEN_HOST=0.0.0.0
LOG_LEVEL=info
CORS_ORIGINS=https://${HOST}
WHATSAPP_DRY_RUN=true
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_API_VERSION=v21.0
WHATSAPP_CONCURRENCY=4
TZ=Asia/Karachi
EOF
  chmod 640 /etc/bismillah/api.env
  chown root:bismillah /etc/bismillah/api.env
fi

echo "==> iptables: 3010 only from loopback + docker (dogar-api_default is 172.18.0.0/16)"
iptables -C INPUT -i lo -p tcp --dport 3010 -j ACCEPT 2>/dev/null \
  || iptables -I INPUT -i lo -p tcp --dport 3010 -j ACCEPT
iptables -C INPUT -p tcp --dport 3010 -s 172.18.0.0/16 -j ACCEPT 2>/dev/null \
  || iptables -I INPUT -p tcp --dport 3010 -s 172.18.0.0/16 -j ACCEPT
iptables -C INPUT -p tcp --dport 3010 -j DROP 2>/dev/null \
  || iptables -A INPUT -p tcp --dport 3010 -j DROP
netfilter-persistent save || true

echo "==> npm ci + web build"
if [ ! -f "$APP/package.json" ]; then
  echo "missing $APP/package.json — extract the tarball first" >&2
  exit 1
fi
chown -R bismillah:bismillah "$APP"
sudo -u bismillah env PATH="$NODE_DIR/bin:$PATH" HOME=/opt/bismillah \
  bash -lc "cd $APP && npm ci && npm run build -w @bi/web"

echo "==> schema"
sudo -u postgres psql -d bismillah -v ON_ERROR_STOP=1 -f "$APP/ops/schema.sql"
sudo -u postgres psql -d bismillah -v ON_ERROR_STOP=1 -c \
  "GRANT ALL ON ALL TABLES IN SCHEMA public TO bismillah; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO bismillah; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO bismillah; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO bismillah;"

echo "==> admin user"
if [ ! -f /etc/bismillah/admin-once.txt ]; then
  ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)"
  sudo -u bismillah env PATH="$NODE_DIR/bin:$PATH" \
    NODE_ENV=production \
    ADMIN_EMAIL='admin@localhost' \
    ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    node --env-file=/etc/bismillah/api.env --experimental-strip-types \
    "$APP/scripts/create-local-admin.ts"
  umask 077
  printf 'email=admin@localhost\npassword=%s\n' "$ADMIN_PASSWORD" >/etc/bismillah/admin-once.txt
  chmod 600 /etc/bismillah/admin-once.txt
fi

echo "==> systemd (Node 22 binary, not /usr/bin/node)"
install -m 644 "$APP/ops/systemd/bi-api.service" /etc/systemd/system/bi-api.service
install -m 644 "$APP/ops/systemd/bi-worker.service" /etc/systemd/system/bi-worker.service
install -m 644 "$APP/ops/systemd/bi-scheduler.service" /etc/systemd/system/bi-scheduler.service
sed -i "s|/usr/bin/node|$NODE_DIR/bin/node|g" \
  /etc/systemd/system/bi-api.service \
  /etc/systemd/system/bi-worker.service \
  /etc/systemd/system/bi-scheduler.service
install -m 644 "$APP/ops/logrotate/bismillah" /etc/logrotate.d/bismillah
systemctl daemon-reload
systemctl enable --now bi-api bi-worker bi-scheduler
systemctl restart bi-api bi-worker
systemctl start bi-scheduler

echo "==> Caddy site + compose bind-mount"
python3 - <<'PY'
from pathlib import Path
compose = Path("/home/ubuntu/dogar-api/docker-compose.yml")
text = compose.read_text()
if "/srv/bismillah-web" not in text:
    old = """    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./site:/srv/site:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on:
      - api
"""
    new = """    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./site:/srv/site:ro
      - /opt/bismillah/current/apps/web/dist:/srv/bismillah-web:ro
      - caddy_data:/data
      - caddy_config:/config
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      - api
"""
    if old not in text:
        raise SystemExit("docker-compose.yml caddy volumes block not found; refusing to patch")
    compose.write_text(text.replace(old, new, 1))
    print("patched docker-compose.yml")
else:
    print("docker-compose.yml already has bismillah-web mount")
PY

CADDY=/home/ubuntu/dogar-api/Caddyfile
if ! grep -q 'bismillah-crm.duckdns.org' "$CADDY"; then
  cp -a "$CADDY" "${CADDY}.bak.$(date +%Y%m%d%H%M)"
  cat "$APP/ops/caddy/bismillah-crm.caddy" >> "$CADDY"
  chown ubuntu:ubuntu "$CADDY"
  echo "appended Caddy site"
else
  echo "Caddy site already present"
fi

echo "==> reload caddy (brief blip on existing sites)"
cd /home/ubuntu/dogar-api
docker compose up -d caddy
sleep 3
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile || docker compose restart caddy

echo "==> health"
sleep 2
curl -sS --max-time 10 http://127.0.0.1:3010/api/health || true
systemctl --no-pager --full status bi-api bi-worker bi-scheduler | sed -n '1,40p'
echo "bootstrap done"
