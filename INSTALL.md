# Quick install (demo)

Bare-minimum setup on a Debian server that already runs Apache and other sites. The radio runs as its own service on `localhost:8090` and gets its own subdomain. Existing sites are not changed.

Replace `radio.yourdomain.com` with your subdomain. Point its DNS **A record** at the server first.

## 1. Install

```bash
sudo apt update && sudo apt install -y ffmpeg git nodejs npm   # needs Node 20+ (check: node -v)
sudo git clone https://github.com/epicgamer133/4adio.git /opt/radio-station
cd /opt/radio-station
sudo npm install --omit=dev
sudo cp .env.example .env
sudo nano .env        # set ADMIN_PASSWORD
```

If `node -v` is older than 20: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs`

## 2. Run it as a service

```bash
sudo useradd --system --home /opt/radio-station --shell /usr/sbin/nologin radio
sudo mkdir -p data && sudo chown -R radio:radio /opt/radio-station
sudo cp deploy/radio-station.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now radio-station
```

## 3. Hook up Apache

```bash
sudo cp deploy/apache-radio.conf /etc/apache2/sites-available/radio.conf
sudo nano /etc/apache2/sites-available/radio.conf    # change radio.example.com
sudo a2enmod proxy proxy_http headers && sudo a2ensite radio
sudo apachectl configtest && sudo systemctl reload apache2   # only reloads if the config is valid
```

## 4. HTTPS

```bash
sudo apt install -y certbot python3-certbot-apache
sudo certbot --apache -d radio.yourdomain.com
```

Then set `SECURE_COOKIES=true` in `.env` and run `sudo systemctl restart radio-station`.

## In a subfolder instead (`yourdomain.com/radio`)

Use this instead of all the steps above when the radio should live inside a site that already runs on the server. One script does everything:

```bash
sudo git clone https://github.com/epicgamer133/4adio.git /opt/radio-station
sudo bash /opt/radio-station/deploy/setup-subpath.sh yourdomain.com
```

It asks for an admin password once, then installs the radio as a service and adds a single `Include` line to that domain's Apache site (backed up first). If the Apache config test fails, or the homepage answers differently afterwards, it restores the backup on its own. Re-run the same command to update. Undo: add `--uninstall` to the end.

Listen at `https://yourdomain.com/radio/`, admin at `https://yourdomain.com/radio/admin`. Doing it by hand instead: set `BASE_PATH=/radio` in `.env` and paste `deploy/apache-radio-subpath.conf` into the site's HTTPS virtual host.

## Done

- Listen: `https://radio.yourdomain.com`
- Admin (upload songs): `https://radio.yourdomain.com/admin`

**Update:** `cd /opt/radio-station && sudo git pull && sudo npm install --omit=dev && sudo chown -R radio:radio . && sudo systemctl restart radio-station`

**Remove:** `sudo a2dissite radio && sudo systemctl reload apache2 && sudo systemctl disable --now radio-station && sudo rm -rf /opt/radio-station`

More detail (Docker, nginx, moving an existing library): see [README.md](README.md).
