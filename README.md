# 2b2t Highway Surveillance Bot Network

A self-hosted network of Minecraft accounts that hold fixed positions on the
Nether highways of **2b2t** (the long-running anarchy server) and passively **log
every player that passes by** — name, coordinates, heading, speed, and gear — to a
live web dashboard and Discord. It also ships a **stash-hunting cartography map**
built from uploaded Xaero's World Map data, plus per-player **wealth/threat intel**
scoring.

There is **no autonomy, pathfinding, or travel**: the operator manually drives each
account to its spot once, and the software handles presence, queueing, monitoring,
notifications, and the dashboard from then on.

> **Responsible use.** This is a personal/educational project for an anarchy server
> that has no in-game rules. Automating Minecraft accounts can still violate the
> Minecraft EULA and Microsoft's terms — run it only with accounts you own, at your
> own risk. Don't use it to harass people. The "surveillance" here is limited to
> what any player standing on a highway can already see in-game.

---

## How it works

Each account runs **two cooperating pieces**, coordinated by one Node.js
orchestrator. This "hybrid" model is the core design idea:

```
                 2b2t.org
                    │  (one real session per account)
             ┌──────┴───────┐
             │  ZenithProxy │   external GraalVM binary, one per account, each in
             │  (per acct)  │   its own tmux session. Holds the 2b2t connection,
             └──────┬───────┘   queue slot, auth, anti-AFK, auto-reconnect.
        ┌───────────┼───────────────┐
        │ SOCKS5 (per-account IP)   │ localhost
   (2b2t rate-limits per IP)   ┌────┴─────────┐
                               │  mineflayer  │  "the monitor" — connects to the
                               │   monitor    │  LOCAL ZenithProxy port as an offline
                               │  (Node.js)   │  spectator, watches nearby players.
                               └────┬─────────┘
                                    │ events
                          ┌─────────┴──────────┐
                          │    Orchestrator    │  index.js — manages lifecycles,
                          │    (Node.js app)    │  polls each ZenithProxy's tmux pane,
                          └─────────┬──────────┘  runs the dashboard + Discord.
                                    │ WS + REST
                          ┌─────────┴──────────┐
                          │    Web Dashboard   │  Express + WebSocket on :3000,
                          │   (vanilla SPA)    │  static files in dashboard/public/.
                          └────────────────────┘
```

Why it's split this way:

- **ZenithProxy** (not included in this repo — installed separately on the box) holds
  each account's real 2b2t session, including the brutal non-priority queue. It runs
  in its own detached **tmux** session so the Node app can restart without dropping
  the game connection (a disconnect means losing your queue position).
- **The mineflayer monitor** connects *offline* to that account's local ZenithProxy
  port as a shared spectator IGN, scans nearby-player entities, and logs sightings.
- **The orchestrator** (`index.js`) is the brain. It doesn't own the ZenithProxy
  processes — it reads their state by **parsing the tmux pane output** (queue
  position, device-login codes, in-world/kick/death detection) and serves the
  dashboard, provisioning, and all Discord notifications.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md)
for the full internals, data model, and a deep dive on the dashboard.

---

## Features

- **Passive player surveillance** — logs every player that passes a monitored
  highway spot: IGN, coordinates, heading, speed, and full gear with enchantments.
- **Live web dashboard** (Express + WebSocket) — overview KPIs, a canvas map of
  bots/sightings/highways, per-player intel, metrics timelines, and settings.
- **Role-based access** — `viewer < trusted < admin/owner`, enforced server-side.
  Viewers get **redacted** data (map + activity only, no names/IPs/positions).
- **Cartography / stash hunting** — upload a zipped Xaero's World Map dimension and
  the server decodes it (dependency-free ZIP + region reader), renders 512×512
  terrain tiles, and surfaces stash candidates on a pan/zoom board.
- **Wealth & threat intel** — per-player scoring from `api.2b2t.vc` (playtime, gear,
  account age, remoteness, K/D…) with fully configurable feature weights.
- **Discord notifications** — device-login codes, queue milestones (250/100/50/10),
  "in the server" pings, sightings, deaths, drops (with cause), and ops alerts.
- **Proxy pool management** — Webshare SOCKS5 sync, per-account egress IP, latency
  health checks, and a closest-working-proxy picker (2b2t rate-limits per IP).
- **Fleet automation** — auto-provision a new account (free port + pooled proxy +
  ZenithProxy clone + tmux launch), device-code login surfaced to the dashboard,
  queue tracking, and auto-remediation of genuinely stuck accounts.
- **Resilient ops** — tmux-decoupled sessions survive app restarts, systemd units,
  a watchdog heartbeat, append-only metrics, and global crash guards.
- **No database** — everything persists to flat JSON/JSONL files under `data/`.

---

## Tech stack

- **Runtime:** Node.js (CommonJS), no build step, no framework.
- **Backend:** `express`, `ws`, `mineflayer`, `socks`, `dotenv`, `chalk`.
- **Frontend:** vanilla HTML/CSS/JS (no React/Vue/bundler) in `dashboard/public/`.
- **Persistence:** flat files under `data/` (JSON + JSONL).
- **External (not in repo):** [ZenithProxy](https://github.com/rfresh2/ZenithProxy)
  per account; `tmux` + `systemd` for 24/7 operation on a Linux VPS.

---

## Project structure

```
index.js                 Orchestrator: provisioning, tmux poller, remediation, Discord, dashboard wiring
config.js                Central config with env overrides — read this to see every knob
state.js                 Persistent runtime state (bot status, placed flags)
lib/parsers.js           Pure parsers for ZenithProxy tmux output (queue pos, device code, deaths…)
bot/
  BotFactory.js          Creates the offline mineflayer monitor
  BotStateMachine.js     Monitor lifecycle (connect → monitor → disconnect)
  modules/PlayerMonitor.js  Entity scan loop → sightings + gear
proxy/ProxyPool.js       Webshare sync + SOCKS5 health checks + best-proxy picker
metrics/                 Append-only time-series + wealth estimator
logging/                 Structured logger + rate-limited Discord notifier
auth/Auth.js             Dashboard auth: scrypt passwords, HMAC session tokens, roles
cartography/             Xaero World Map decoding + terrain tile rendering
dashboard/
  server.js              Express + WebSocket API (routes, auth, viewer redaction)
  public/                The dashboard SPA (index.html, app.js, style.css, login.html)
ops/                     systemd units, watchdog, Caddy templates, deploy + HTTPS scripts
test/run.js              Node test runner (parsers, metrics, cartography) — `npm test`
data/                    Runtime state + secrets (gitignored; *.example.* templates included)
```

---

## Requirements

- **Node.js 18+**
- For real monitoring: a **ZenithProxy** instance per Minecraft account, and the
  **Minecraft (Microsoft) accounts** themselves. *(The dashboard runs standalone
  without any of this — handy for UI work.)*
- A **Linux VPS** if you want it running 24/7 (`tmux` + `systemd`).
- Optional: **Webshare** SOCKS5 proxies (needed once you run more than one account),
  a **Discord webhook** for alerts, and `api.2b2t.vc` (public) for wealth intel.

---

## Setup

### Quick start (dashboard only, no bots)

Great for trying it out or working on the UI — it boots with zero accounts.

```bash
git clone https://github.com/fernandito0901/2b2t-surveillance-bot-network.git
cd 2b2t-surveillance-bot-network
npm install

cp .env.example .env
# edit .env — at minimum set ADMIN_PASSWORD (and DASHBOARD_PORT if 3000 is taken)

node index.js
# → open http://localhost:3000
```

On first run, if there are no users yet, it creates the initial **owner** account
from `ADMIN_USER` / `ADMIN_PASSWORD`. If you leave the password blank, a random one
is generated and printed to the console **once** — copy it, log in, and change it.

### Full deployment (with live bots)

The monitoring half needs one **ZenithProxy** per account, running in tmux, holding
each account's 2b2t session. In short:

1. Install and configure ZenithProxy per account on your VPS (built for the same
   Minecraft version as your driving client — currently **1.21.4**).
2. Point the monitor at the local ZenithProxy port with `SERVER_HOST=127.0.0.1`,
   `SERVER_PORT=<zenith port>`, `SERVER_AUTH=offline` (see `.env.example`).
3. Add each account through the dashboard's **Admin** tab — it auto-provisions a
   port + proxy, launches ZenithProxy in tmux, and surfaces the device-login code.
4. Once an account is in-world, drive it to its highway spot and click **Place** —
   the monitor attaches and starts logging.

The `ops/` folder has everything for a production box: a `2b2t-app` **systemd** unit,
a **watchdog** heartbeat, **Caddy** templates + `enable-https.sh` for TLS, and
`deploy.sh` for shipping code changes safely (it excludes `data/` and secrets and
never restarts the running ZenithProxy sessions). `PROJECT_OVERVIEW.md` §6 has the
full deploy flow.

---

## Configuration

All settings live in [`config.js`](config.js) with environment overrides; copy
`.env.example` to `.env` and change only what you need. The most important knobs:

| Variable | Purpose |
|---|---|
| `SERVER_HOST` / `SERVER_PORT` / `SERVER_AUTH` | Where the monitor connects (the local ZenithProxy; use `offline`) |
| `SERVER_VERSION` | Must match your ZenithProxy build (e.g. `1.21.4`) |
| `MONITOR_IGN` | Shared spectator IGN used to watch each account |
| `OWNER_IGN` / `PROXY_WHITELIST` | Your account(s) allowed to drive the bots |
| `WHITELIST` / `WATCHLIST` | Players that never alert / that trigger priority alerts |
| `DISCORD_WEBHOOK_URL` | Discord webhook for notifications (blank disables) |
| `PUBLIC_HOST` | Public IP/host shown in "in the server" pings |
| `DASHBOARD_PORT` / `DASHBOARD_HOST` / `TRUST_PROXY` | Dashboard binding |
| `ADMIN_USER` / `ADMIN_PASSWORD` | Bootstraps the first dashboard user |
| `WEBSHARE_API_KEY` / `WEBSHARE_PROXY_LIST_URL` | Webshare SOCKS5 proxy sourcing |
| `PROXY_MAX_LATENCY_MS` / `PROXY_PREFER_COUNTRIES` | Proxy picker tuning |
| `LOG_LEVEL` / `ACTIVITY_RETENTION_DAYS` | Logging + activity retention |

Advanced wealth-scoring weights (`WEALTH_W_*`), TTLs, and remediation thresholds
are all documented inline in `config.js`.

---

## Using the dashboard

Tabs are gated by role (enforced on the server, not just hidden):

| Tab | Role | What it shows |
|---|---|---|
| **Overview** | viewer+ | KPIs, live map, bot status cards, activity feed |
| **Intel** | trusted+ | Per-player profiles: gear, threat, patterns, hours |
| **Map** | trusted+ | Cartography board: pan/zoom canvas, stash candidates, terrain tiles |
| **Metrics** | trusted+ | Per-account availability %, drop/queue timelines |
| **Settings** | admin+ | Watchlist/whitelist, Discord, sighting-alert mode |
| **Admin** | admin+ | Manage accounts (add/relogin/delete) and dashboard users |

Add accounts and manage dashboard users from **Admin**; tune alerting from
**Settings**; upload a zipped Xaero dimension from the **Map** tab to populate the
cartography board.

---

## Security notes

- **The dashboard is served over plain HTTP by default** (`0.0.0.0:3000`), so logins
  cross the network in cleartext. For any real deployment, put it behind HTTPS
  (`ops/enable-https.sh` sets up Caddy + Let's Encrypt on a subdomain) or bind it to
  localhost and use an SSH tunnel.
- Auth uses **scrypt-hashed passwords** and **HMAC-signed, httpOnly session cookies**,
  with a 5-strike login lockout and server-side role enforcement.
- Player names are attacker-controlled and are **HTML-escaped** before display.
- **Secrets and runtime data are never committed.** `.env`, `*.pem`, logs, and
  everything under `data/` (accounts, users, proxies, auth cache, session secret) are
  gitignored. The repo ships only `*.example.*` templates — copy and fill them in
  locally.

---

## License

[MIT](LICENSE) © fernandito0901

## Acknowledgements

Built on [mineflayer](https://github.com/PrismarineJS/mineflayer) and
[ZenithProxy](https://github.com/rfresh2/ZenithProxy); wealth/intel data from the
community [2b2t.vc API](https://api.2b2t.vc); map data from
[Xaero's World Map](https://chocolateminecraft.com/); proxies via
[Webshare](https://www.webshare.io/).
