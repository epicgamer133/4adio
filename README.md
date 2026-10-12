# Radio Station

> **Experimental.** Design and features are still being explored. See [docs/PROJECT_NOTES.md](docs/PROJECT_NOTES.md) for the vision, the design decisions and the current status.

A self-hosted live radio. The server shuffles your library and broadcasts **one continuous stream**. Everyone who tunes in hears the same moment of the same song, the same way FM radio works.

- **Always synced.** The station plays even when nobody is listening. Joining means tapping into the live feed, so there's no "start from the beginning" and nothing to drift.
- **Music stays private.** Songs live in `data/audio/`, which is never served. Listeners only ever get `/stream`: an endless live MP3 feed with no file URLs, no seeking and no download link.
- **Fair shuffle.** Every song plays once before any song repeats, and the same song never plays twice in a row. New uploads join the current cycle.
- **Admin panel.** Drag-and-drop uploads in any format. Songs are converted and loudness-matched, and the title, artist and cover art are read from the file's tags. You can edit info, set "Listen on" links per song, queue requests, skip, and toggle songs in or out of rotation.
- **Visualizers.** Nebula, Spectrum, Halo, Waves, Warp and Minimal. They react to the real audio and take their colors from the current cover art. You can also add an optional custom background image or video.
- **Live UI.** Cover art, title, artist, progress, up next, recently played, listener count, station socials, per-song streaming links, lock-screen controls and keyboard shortcuts (`Space` play/stop, `V` visualizer, `F` fullscreen).

> **Honest limit:** nothing played in a browser can be made impossible to *record*. Someone can always capture their own speakers. What this design stops is downloading or scraping your files, which is the realistic threat.

---

## How it fits on your server without touching anything else

```
visitor ──https──> your existing nginx/Apache ──> 127.0.0.1:8090 (this app)
                    (new subdomain block only)      listens on localhost only
```

- The app runs as its own process on **localhost:8090**. It cannot be reached from outside except through the proxy.
- You add **one new** server block (nginx) or virtual host (Apache) for a subdomain like `radio.yourdomain.com`. Your existing sites and config files stay untouched.
- Everything the app writes stays inside its own folder (`data/`).
- It must run at the **root of a subdomain**, not in a subfolder like `yoursite.com/radio`.

**Requirements:** a VPS or dedicated server with shell access. Shared/cPanel hosting can't run a 24/7 stream process, so this won't work there.

Pick **one** install option.

---

## Option A: Docker (most isolated, recommended)

Nothing is installed on the host except Docker; ffmpeg lives inside the container.

```bash
# 1. Copy this folder to the server, e.g. /opt/radio-station, then:
cd /opt/radio-station
cp .env.example .env
nano .env                      # set ADMIN_PASSWORD (and ADMIN_PATH)

# 2. Data folder owned by the container's user
mkdir -p data && sudo chown 1000:1000 data

# 3. Start it
docker compose up -d --build
docker compose logs -f         # should say: "Night Radio" on http://0.0.0.0:8090
```

Then do **Step 3: Reverse proxy** below.

Update later with `docker compose up -d --build`. Your songs in `data/` are kept.

## Option B: Plain Node.js + systemd

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install -y ffmpeg
# Node 20+ (if `node -v` is older or missing):
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs

sudo mkdir -p /opt/radio-station && sudo cp -r ./* ./.env.example /opt/radio-station/
cd /opt/radio-station
sudo cp .env.example .env && sudo nano .env        # set ADMIN_PASSWORD
sudo npm install --omit=dev
sudo mkdir -p data

sudo useradd --system --home /opt/radio-station --shell /usr/sbin/nologin radio
sudo chown -R radio:radio /opt/radio-station
sudo cp deploy/radio-station.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now radio-station
journalctl -u radio-station -f
```

The systemd unit is sandboxed: the process can only write to `/opt/radio-station/data`.

## Step 3: Reverse proxy (both options)

1. Point a DNS **A record** for `radio.yourdomain.com` at your server.
2. Add the config for your web server. Change `radio.example.com` to your subdomain:
   - **nginx:** `deploy/nginx-radio.conf` → `/etc/nginx/sites-available/radio.conf`
     ```bash
     sudo ln -s /etc/nginx/sites-available/radio.conf /etc/nginx/sites-enabled/
     sudo nginx -t && sudo systemctl reload nginx
     ```
   - **Apache:** `deploy/apache-radio.conf` → `/etc/apache2/sites-available/radio.conf`
     ```bash
     sudo a2enmod proxy proxy_http headers && sudo a2ensite radio
     sudo apachectl configtest && sudo systemctl reload apache2
     ```
   `nginx -t` / `configtest` validate before reloading, so a typo can't take your other sites down.
3. HTTPS: `sudo certbot --nginx -d radio.yourdomain.com` (or `--apache`).
4. Set `SECURE_COOKIES=true` in `.env` and restart (`docker compose up -d` or `sudo systemctl restart radio-station`).

The proxy configs disable buffering on `/stream` and `/events`. This is required: a buffering proxy holds the audio back and the stream stutters.

---

## Using it

- **Radio:** `https://radio.yourdomain.com`
- **Admin:** `https://radio.yourdomain.com/admin`, or whatever you set `ADMIN_PATH` to. Use something unguessable.

**Admin tabs**
- **On air:** what's playing, skip, up next, request queue, history, and live listener count.
- **Library:** drop songs in. Each one uploads, converts (a few seconds to a minute), then joins rotation. Click a cover to replace it. **Edit** sets the title, artist, album and the *Listen on* links (Spotify, Apple Music, YouTube, SoundCloud, Bandcamp, TIDAL, Deezer, other). **Play next** puts a song in the request queue, which plays before the shuffle. The toggle removes a song from rotation without deleting it.
- **Station:** name, tagline, accent color, default visualizer, custom background (image or looping video), and station socials (Instagram, X, TikTok, YouTube, Spotify, SoundCloud, Facebook, Twitch, Discord, website).

**Backups:** copy the `data/` folder. It holds everything: songs, covers, library and settings.

**Embedding on your main site:** add your main domain to `FRAME_ANCESTORS` in `.env` (e.g. `self https://4tunat.com`), then use
`<iframe src="https://radio.yourdomain.com" allow="autoplay; fullscreen" style="width:100%;height:600px;border:0"></iframe>`.

---

## Trying it on this Windows PC first (optional)

```bash
winget install OpenJS.NodeJS.LTS
```
```bash
winget install Gyan.FFmpeg
```
Open a new terminal in this folder, copy `.env.example` to `.env`, set `ADMIN_PASSWORD`, then:
```bash
npm install
```
```bash
npm start
```
Then open http://127.0.0.1:8090 for the radio, or http://127.0.0.1:8090/admin for the admin panel.

---

## How the sync works (for the curious)

- **Broadcast.** Every upload is converted to identical CBR MP3 (44.1 kHz stereo). The server splits songs into MP3 frames and sends them to every listener at exactly real-time speed, so all listeners get the same bytes at the same moment.
- **Joining.** A new listener first receives the last 2 seconds of audio, so playback starts instantly, then continues on the live feed.
- **Now-playing timing.** Track changes are pushed over Server-Sent Events with server timestamps. Each listener's page measures its own buffer delay and switches the cover/title at the moment *they* hear the new song, not before.
- **Self-healing.** If a listener drifts more than 8 s behind (a slow connection, or a phone that slept), the page silently reconnects to live. Dead connections retry with backoff.

## File layout

```
server/        Node backend (broadcaster, shuffle, uploads, auth)
public/        Listener page + admin scripts (nothing secret)
views/         Admin page HTML (served only at ADMIN_PATH)
data/          PRIVATE: songs, covers, library.json, settings.json
deploy/        nginx / Apache / systemd configs
```
