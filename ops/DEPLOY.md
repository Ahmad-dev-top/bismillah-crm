# Deploy Bismillah CRM on Oracle Cloud Ampere A1 (ARM64) + DuckDNS

Target: a fresh **Ubuntu 24.04** VM on Oracle Cloud Always Free **Ampere A1**
(ARM64). The hostname is a **DuckDNS** name such as `yoursub.duckdns.org`.
There is no Cloudflare proxy: browsers talk to this VM on 80/443.

Replace `YOURSUB` everywhere with your DuckDNS subdomain (the part before
`.duckdns.org`).

Keep `WHATSAPP_DRY_RUN=true` until Meta has approved templates. The worker
still runs end to end and logs payloads without contacting Meta.

---

## 0. Oracle Cloud console (do this before SSH)

1. Create or pick an **Ampere A1** instance, image **Ubuntu 24.04** (aarch64).
2. Attach a **reserved public IPv4** if you can. Always Free IPs can move
   after a stop; DuckDNS will catch that if the updater cron is running.
3. **VCN security list** (or NSG) ingress, source `0.0.0.0/0`:
   - TCP 22
   - TCP 80
   - TCP 443
   Nothing else public. Postgres and Redis stay on the VM only.
4. SSH key-only. Disable password logins in a later step; do not lose the key.

Oracle Ubuntu images often filter with **iptables** as well as ufw. Opening
ufw without the security list (or the other way around) looks like “nginx
works locally but DuckDNS times out.”

---

## 1. First login: user, firewall, SSH

```bash
# as ubuntu (Oracle’s default user)
sudo timedatectl set-timezone Asia/Karachi

sudo apt-get update
sudo apt-get install -y ufw curl git build-essential python3 ca-certificates

sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

# Oracle images: also punch 80/443 in iptables if curl from your laptop still fails
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || true

sudo adduser --system --group --home /opt/bismillah bismillah
sudo mkdir -p /opt/bismillah /etc/bismillah /var/log/bismillah /var/lib/bismillah/imports /var/backups/bismillah /var/www/certbot
sudo chown -R bismillah:bismillah /opt/bismillah /var/log/bismillah /var/lib/bismillah /var/backups/bismillah
sudo chmod 750 /etc/bismillah
```

Harden SSH (`/etc/ssh/sshd_config.d/bismillah.conf`):

```
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
```

Then `sudo systemctl reload ssh`. Confirm a **second** SSH session with the
key works before you close the first.

---

## 2. DuckDNS

1. At [duckdns.org](https://www.duckdns.org) create `YOURSUB` and copy the token.
2. Point it at the VM’s public IPv4 (the website “update ip” button is enough once).
3. On the VM:

```bash
sudo tee /etc/bismillah/duckdns.env >/dev/null <<'EOF'
DUCKDNS_SUB=YOURSUB
DUCKDNS_TOKEN=paste-the-token
EOF
sudo chmod 600 /etc/bismillah/duckdns.env
sudo chown root:root /etc/bismillah/duckdns.env
```

After the app is deployed (step 6), install the updater:

```bash
sudo chmod +x /opt/bismillah/current/ops/duckdns-update.sh
sudo /opt/bismillah/current/ops/duckdns-update.sh
echo '*/5 * * * * root /opt/bismillah/current/ops/duckdns-update.sh >/dev/null 2>&1' | sudo tee /etc/cron.d/duckdns
```

Check from your laptop: `nslookup YOURSUB.duckdns.org` should show the VM IP.

---

## 3. Node 22 (ARM64), PostgreSQL 16, Redis

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # v22.x, aarch64

sudo apt-get install -y postgresql postgresql-contrib redis-server

# Bind to loopback only
sudo sed -i "s/^#\?listen_addresses.*/listen_addresses = '127.0.0.1'/" /etc/postgresql/*/main/postgresql.conf
# pg_hba: keep local peer/md5; do not add 0.0.0.0/0

sudo sed -i 's/^bind 127.0.0.1 ::1/bind 127.0.0.1/' /etc/redis/redis.conf
sudo sed -i 's/^#\?appendonly .*/appendonly yes/' /etc/redis/redis.conf
# Comment out any bind that includes a public address

sudo systemctl enable --now postgresql redis-server
sudo ss -lntp | grep -E '5432|6379'   # must be 127.0.0.1, not 0.0.0.0
```

Database role (generate the password; do not reuse the Windows laptop password):

```bash
DB_PASS="$(openssl rand -base64 24)"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
CREATE USER bismillah WITH PASSWORD '${DB_PASS}';
CREATE DATABASE bismillah OWNER bismillah;
GRANT ALL PRIVILEGES ON DATABASE bismillah TO bismillah;
SQL
echo "Save this DB password in api.env: ${DB_PASS}"
```

---

## 4. Secrets file

```bash
JWT="$(openssl rand -base64 48)"
sudo tee /etc/bismillah/api.env >/dev/null <<EOF
DATABASE_URL=postgres://bismillah:${DB_PASS}@127.0.0.1:5432/bismillah
REDIS_URL=redis://127.0.0.1:6379
PG_POOL_MAX=8
JWT_SECRET=${JWT}
PORT=3000
LOG_LEVEL=info
CORS_ORIGINS=https://YOURSUB.duckdns.org
WHATSAPP_DRY_RUN=true
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_API_VERSION=v21.0
WHATSAPP_CONCURRENCY=4
TZ=Asia/Karachi
EOF
sudo chmod 600 /etc/bismillah/api.env
sudo chown root:bismillah /etc/bismillah/api.env
```

`JWT` and `DB_PASS` are still in this shell’s history. Clear the session when
done. Never commit `api.env`.

---

## 5. Deploy the tree

From your laptop (PowerShell), with the repo already on disk:

```powershell
scp -r "D:\Bismillah CRM\bismillah-crm" ubuntu@YOUR_VM_IP:~/bismillah-crm
```

On the VM:

```bash
sudo rm -rf /opt/bismillah/current
sudo mv ~/bismillah-crm /opt/bismillah/current
sudo chown -R bismillah:bismillah /opt/bismillah/current

cd /opt/bismillah/current
sudo -u bismillah npm ci
sudo -u bismillah npm run build -w @bi/web

sudo -u postgres psql -d bismillah -v ON_ERROR_STOP=1 -f /opt/bismillah/current/ops/schema.sql
# After schema.sql the owner of new objects is postgres. Hand them to the app role:
sudo -u postgres psql -d bismillah -v ON_ERROR_STOP=1 -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO bismillah; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO bismillah; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO bismillah; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO bismillah;"
```

Create one staff user. Pick a strong password; do not reuse the Windows laptop
password. The script reads `ADMIN_PASSWORD` (required on the VM) and optional
`ADMIN_EMAIL`:

```bash
cd /opt/bismillah/current
sudo -u bismillah env \
  NODE_ENV=production \
  ADMIN_EMAIL='admin@localhost' \
  ADMIN_PASSWORD='choose-a-strong-password' \
  node --env-file=/etc/bismillah/api.env --experimental-strip-types \
  scripts/create-local-admin.ts
```

Do not leave `ChangeMe123!` on a public VM. Do not echo the password into logs.

---

## 6. systemd units

Ubuntu 24.04 Redis unit is `redis-server.service`; Postgres is `postgresql.service`.

```bash
sudo cp /opt/bismillah/current/ops/systemd/bi-api.service /etc/systemd/system/
sudo cp /opt/bismillah/current/ops/systemd/bi-worker.service /etc/systemd/system/
sudo cp /opt/bismillah/current/ops/systemd/bi-scheduler.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bi-api bi-worker bi-scheduler
sudo systemctl status bi-api bi-worker bi-scheduler --no-pager
curl -sS http://127.0.0.1:3000/api/health
```

Health must show `"postgres":"ok"`. The API listens on **127.0.0.1:3000** only;
nginx is the public front door.

---

## 7. nginx + Let’s Encrypt (DuckDNS)

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo mkdir -p /var/www/certbot

# Put your real DuckDNS hostname in HOST (example: bismillah.duckdns.org)
HOST=YOURSUB.duckdns.org

# First certificate: HTTP only
sudo sed "s/YOURSUB.duckdns.org/${HOST}/g" /opt/bismillah/current/ops/nginx/bismillah-http.conf \
  | sudo tee /etc/nginx/sites-available/bismillah >/dev/null
sudo ln -sfn /etc/nginx/sites-available/bismillah /etc/nginx/sites-enabled/bismillah
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d "$HOST" --agree-tos -m you@example.com --redirect
```

Then install the full TLS site (same `HOST`):

```bash
HOST=YOURSUB.duckdns.org
sudo cp /opt/bismillah/current/ops/nginx/bismillah.conf /etc/nginx/sites-available/bismillah
sudo sed -i "s/YOURSUB.duckdns.org/${HOST}/g" /etc/nginx/sites-available/bismillah
sudo nginx -t && sudo systemctl reload nginx
```

Confirm the cert paths match `/etc/letsencrypt/live/${HOST}/`.

```bash
sudo cp /opt/bismillah/current/ops/logrotate/bismillah /etc/logrotate.d/bismillah
```

Open `https://YOURSUB.duckdns.org` — login page, TLS padlock.

---

## 8. Backups

```bash
sudo chmod +x /opt/bismillah/current/ops/backup/pg-backup.sh
echo '0 2 * * * root TZ=Asia/Karachi /opt/bismillah/current/ops/backup/pg-backup.sh >> /var/log/bismillah/backup.log 2>&1' \
  | sudo tee /etc/cron.d/bismillah-backup
sudo /opt/bismillah/current/ops/backup/pg-backup.sh
```

Restore drill (uses a throwaway database, not production):

```bash
sudo -u postgres createdb bismillah_restore_test
sudo -u postgres pg_restore -d bismillah_restore_test --clean --if-exists /var/backups/bismillah/bismillah-*.dump
sudo -u postgres dropdb bismillah_restore_test
```

A dump that has never been restored is not a backup. Optional: set
`BACKUP_REMOTE` and install `rclone` to Object Storage so the file leaves this
disk.

---

## 9. What not to turn on yet

- Leave **`WHATSAPP_DRY_RUN=true`**. Meta is not configured.
- Do not import the 548 customers until you are ready to assign packages and
  prices **yourself** in the app. Incomplete rows will not be billed or messaged.
- The midnight and 09:00 jobs belong to **systemd + Redis**, not your laptop.

---

## 10. Verification checklist

Work down the list. The last item is the gate.

- [ ] `ss -lntp` shows Postgres and Redis on `127.0.0.1` only; 22/80/443 public
- [ ] `YOURSUB.duckdns.org` resolves to this VM
- [ ] `https://YOURSUB.duckdns.org` loads the login page (valid certificate)
- [ ] Login works; JWT is not in localStorage
- [ ] `curl -sS http://127.0.0.1:3000/api/health` → `"status":"ok"`
- [ ] `systemctl is-enabled bi-api bi-worker bi-scheduler` → enabled
- [ ] DuckDNS cron: `*/5 * * * *` and a successful `duckdns-update.sh`
- [ ] Backup cron at 02:00 Asia/Karachi; `pg_restore --list` on tonight’s dump
- [ ] Restore drill into `bismillah_restore_test` succeeded
- [ ] SSH password login is off; you still have a working key
- [ ] **Reboot the VM and confirm notifications still fire without anyone logging in**
      (`sudo reboot`, wait, `systemctl is-active bi-worker bi-scheduler`,
      Redis still has the repeatable jobs, worker log shows the next sweep
      without opening a browser)
