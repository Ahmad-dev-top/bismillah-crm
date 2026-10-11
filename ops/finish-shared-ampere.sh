#!/usr/bin/env bash
set -euo pipefail
APP=/opt/bismillah/current
NODE_DIR=/usr/local/lib/nodejs
export PATH="$NODE_DIR/bin:$PATH"

chmod 640 /etc/bismillah/api.env
chown root:bismillah /etc/bismillah/api.env

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

echo "==> systemd"
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

cd /home/ubuntu/dogar-api
docker compose up -d caddy
sleep 3
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile || docker compose restart caddy
sleep 2
echo "==> health"
curl -sS --max-time 10 http://127.0.0.1:3010/api/health || true
echo
systemctl is-active bi-api bi-worker bi-scheduler
echo "remaining done"
