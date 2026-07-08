# 2b2t Highway Surveillance — Project Overview & AI Handoff

> Read this first. It explains what the system is, how it's built, how to connect,
> and how to work on the dashboard UI. Written for an AI (or engineer) picking up a
> **system overview + UI review/overhaul** of the web dashboard.

---

## 1. What this is

A **surveillance bot network for 2b2t** (the anarchy Minecraft server). It parks
Minecraft accounts at fixed spots on the Nether highways and **logs every player that
passes by** — their name, coords, heading, speed, gear (with enchants) — to a live web
dashboard + Discord, and offers a **stash-hunting cartography map** built from uploaded
Xaero's World Map data.

It runs 24/7 on a single AWS Lightsail VPS. The operator watches everything through the
web dashboard (the thing you're reviewing/overhauling).

---

## 2. Architecture (the "hybrid" model — important)

Each Minecraft account runs **two cooperating pieces**:

```
                 2b2t.org
                    │  (one real session per account)
             ┌──────┴───────┐
             │  ZenithProxy │   native GraalVM binary, one per account,
             │  (per acct)  │   each in its own tmux session. Holds the 2b2t
             └──────┬───────┘   connection, queue, auth, antiafk, autoReconnect.
        ┌───────────┼───────────────┐
        │ SOCKS5 (Webshare)         │ localhost
        │ per-account egress IP     │
   (2b2t rate-limits per IP)   ┌────┴─────────┐
                               │ mineflayer   │  "the monitor" — connects to the LOCAL
                               │ monitor      │  ZenithProxy as an offline spectator,
                               │ (Node.js)    │  watches for nearby players, logs sightings.
                               └────┬─────────┘
                                    │ events
                          ┌─────────┴──────────┐
                          │   Orchestrator     │  index.js — the Node app. Manages
                          │   (Node.js app)    │  lifecycles, polls each ZenithProxy's
                          └─────────┬──────────┘  tmux pane, runs the dashboard + Discord.
                                    │ WS + REST
                          ┌─────────┴──────────┐
                          │   Web Dashboard    │  Express + WebSocket, served on :3000.
                          │  (the UI to review)│  Static SPA in dashboard/public/.
                          └────────────────────┘
```

Key consequences of this design:
- **The orchestrator (Node app) is decoupled from the bots.** Restarting the app does
  **not** drop the 2b2t sessions — ZenithProxy lives in separate tmux sessions
  (`KillMode=process`). The mineflayer monitor reconnects on app start.
- **Restarting a ZenithProxy = the bot loses its queue position** (2b2t doesn't save
  non-priority queue spots). So we avoid ZenithProxy restarts.
- The orchestrator reads bot state by **parsing each ZenithProxy's tmux pane output**
  (`tmux capture-pane`), not an API — see `lib/parsers.js`.
- A **`placed` flag** (persisted) gates manual control: when placed, the monitor holds
  the spot; when not, the operator is driving it manually through ZenithProxy.
- **Data model (important):** the one live "where is a bot" model is **`accounts.json`
  + the `placed` flag** (`state.placedBots`). A sighting's `spotId` is *derived at
  runtime* as `account.username || account.id` — it is not stored anywhere.
  `spots.json` is fully dead (no readers) and `groups.json` is only a cosmetic
  coverage overlay (empty in prod); neither drives monitoring.

---

## 3. Tech stack

- **Runtime:** Node.js (CommonJS). No build step, no framework.
- **Backend deps:** `express` (dashboard), `ws` (WebSocket), `mineflayer` (the monitor),
  `socks` (SOCKS5 proxy health checks), `dotenv`, `chalk`.
- **Frontend:** **vanilla** HTML + CSS + JS. No React/Vue/bundler. `dashboard/public/`.
- **Persistence:** flat files under `data/` (JSON + JSONL). No database.
- **Process mgmt:** systemd unit `2b2t-app` on the VPS; ZenithProxy in `tmux`.
- **Proxies:** Webshare static-residential SOCKS5 (per-account egress IP).
- **External binary:** ZenithProxy (not in this repo — installed on the VPS under
  `~/zenith/<account>/`), currently built for **Minecraft 1.21.4**.

---

## 4. Repository map

```
index.js                     Orchestrator: lifecycle, tmux poller, remediation,
                             dashboard boot, Discord, all HTTP data-builders. (~1600 lines)
config.js                    Central config (env-overridable). Read this to see every knob.
state.js                     Persistent runtime state (bot status, placed flags) → data/state.json
lib/parsers.js               Pure parsers for ZenithProxy tmux-pane output (queue pos, device
                             code, in-world detection, deaths, drops, kick reasons). Unit-tested.
bot/
  BotFactory.js              Creates the mineflayer monitor bot.
  BotStateMachine.js         Monitor lifecycle wrapper (connect/monitor/death handling).
  modules/PlayerMonitor.js   The surveillance scan loop: nearby players → sightings + gear.
proxy/ProxyPool.js           Webshare API sync + SOCKS5 latency/health checks + best-proxy picker.
metrics/MetricsStore.js      Append-only time-series (availability %, drops, queue trend).
logging/
  Logger.js                  Structured console + JSONL activity logger.
  DiscordNotifier.js         Rate-limited Discord webhook (sightings, drops, deaths, alerts).
auth/Auth.js                 Dashboard login: scrypt passwords, HMAC session tokens, roles.
cartography/                 Xaero World Map decoding + rendering (stash-hunting map).
  XaeroDecoder.js            Dep-free ZIP reader + block-palette base-signal detection.
  XaeroRegion.js             Full per-pixel region.xaero decoder (chunk-level pinpointing).
  blockColors.js             block name → RGB for terrain rendering.
  renderRegion.js            512×512 PNG encoder (terrain tiles).
dashboard/
  server.js                  Express + WS server: routes, auth middleware, role redaction.
  public/                    ★ THE UI — static SPA (this is what you're reviewing) ★
    index.html               App shell + all tab/view markup.
    app.js                   All frontend logic (~2000 lines): WS, REST, canvas map, tabs.
    style.css                Design system + all styling (dark command-center theme).
    login.html               Standalone login page.
test/run.js                  Node test runner (parsers, metrics, cartography). `npm test`.
data/                        Runtime state (gitignored-ish): accounts.json, state.json,
                             users.json, settings.json, activity/*.jsonl, metrics/*.jsonl,
                             cartography/*.json + tiles/. NOT for editing by hand.
ops/watchdog.sh              Cron heartbeat → Discord on service/dashboard/proxy/RAM problems.
```

---

## 5. The Dashboard UI (focus for the overhaul)

**Files:** `dashboard/public/{index.html, app.js, style.css, login.html}`. Vanilla, no
build. Edit → deploy (scp) → hard-refresh. `app.js` uses inline `onclick=` handlers (CSP
allows `unsafe-inline`), a global `apiFetch()` wrapper, and a persistent WebSocket.

### Tabs / views (with required role)
| Tab (button id)        | View id          | Role     | Purpose |
|------------------------|------------------|----------|---------|
| Overview (`tab-dashboard`) | *(default)*  | viewer+  | KPIs, live map, bot status cards, activity feed |
| Intel (`tab-intel`)    | `intel-view`     | trusted  | Per-player profiles: gear, threat, patterns, hours |
| Map (`tab-carto`)      | `carto-view`     | trusted  | Cartography board: pan/zoom canvas, stash candidates, terrain tiles |
| Metrics (`tab-metrics`)| `metrics-view`   | trusted  | Per-account availability %, drop/queue timelines, proxy/plan |
| Settings (`tab-settings`)| `settings-view`| admin    | Watchlist/whitelist, Discord, sighting-alert mode |
| Admin (`tab-admin`)    | `admin-view`     | admin    | Manage accounts (add/relogin/delete), dashboard users |

### Roles (enforced server-side, not just hidden)
`viewer < trusted < admin`. Viewers get **redacted** data (map + activity only — no bot
names/IPs/positions/accounts). Redaction happens in `server.js` (`_redactForViewer`) and
per-route. `data-role="..."` on nav buttons hides tabs client-side, but the server is the
real gate. **When reviewing/redesigning, preserve the redaction contract.**

### Design system (`style.css` `:root`)
Dark "command-center" theme:
```
--bg #08080d  --bg-1 #0d0d16 (panels)  --bg-2 #14141f (cards)  --bg-3 #1a1a28 (hover/inputs)
--text #e6e6f2  --text-2 #9a9ab5  --text-3 #6b6b85  --text-4 #4a4a60
accents: --green #22c55e  --blue #38bdf8  --amber #f59e0b  --red #ef4444  --indigo #6366f1
--border #1d1d2e  --border-2 #2a2a40   radii --r-sm/md/lg 7/10/13px
fonts: --font Inter, --mono JetBrains Mono   transition --t 160ms
```
Colors carry meaning: green = in-world/healthy, blue = queuing, amber = warning/connecting,
red = down/login-required/death.

### Data flow
- **WebSocket** (`/`, cookie-authed): pushes `initial` on connect, then live events
  (`player_detected`, bot/account/settings updates, `cartography_updated`, etc.). The
  frontend keeps a `systemStatus` object and re-renders on messages.
- **REST** (all under `/api/`, cookie-authed): the tables below. Frontend uses `apiFetch()`.
- Both redact for viewers.

### Key REST endpoints (see `dashboard/server.js`)
```
POST /api/login            {username,password} → sets httpOnly sid cookie (rate-limited)
GET  /api/me               current {username, role}
GET  /api/status           full system status (bots, accounts, groups, monitor, activity)
GET  /api/activity?range&limit    recent sightings
GET  /api/intel?range&sort&limit  player profiles (trusted)
GET  /api/metrics?range           per-account metrics (trusted)
GET  /api/cartography?dim          map data: regions, stash candidates, sightings (trusted)
GET  /api/cartography/tile?dim&x&z rendered 512×512 terrain PNG (trusted)
GET  /api/cartography/waypoints    downloadable Xaero waypoints (trusted)
POST /api/cartography/upload       upload a zipped Xaero dimension (trusted, 80mb)
POST /api/bots/:id/placed          toggle placed flag (trusted)
POST /api/accounts/:id/start       (re)provision + launch an account (trusted)
POST /api/accounts/add             begin device-code login for a new account (admin)
POST /api/accounts/:id/relogin     re-auth an account (admin)
PUT  /api/settings                 update watchlist/whitelist/discord (admin)
GET/POST/PATCH/DELETE /api/users   dashboard user management (admin)
```

---

## 6. How to connect / run

There are three ways to work with it. **For a UI overhaul, option A (run locally) is
best** — the dashboard runs standalone with no bots and no VPS access needed.

### A. Run the dashboard locally (recommended for UI work)
```bash
npm install
# create a minimal .env (see §7). At minimum:
#   DASHBOARD_PORT=3000
#   ADMIN_USER=admin
#   ADMIN_PASSWORD=<pick-one>
node index.js
# → open http://localhost:3000, log in with the admin creds above.
```
The app boots the dashboard even with **zero accounts** (it just shows an empty fleet).
On first run it creates the admin user and prints the password to the console. You can add
mock data by hand-editing `data/*.json` if you want populated screens, or point it at the
live backend (option B) to see real data. No Minecraft bots are needed to iterate on UI.

> `.claude/launch.json` does not exist yet. If you use a preview/dev-server tool, create
> one that runs `node index.js` on port 3000.

### B. Access the live dashboard (see real data + current UI)
- URL: **http://YOUR_SERVER_IP:3000** (plain HTTP — see security note in §8).
- Log in with the **admin** account to see the full UI (all tabs). Ask the operator for
  the admin username/password (do **not** expect them in this file).

### C. SSH to the VPS (to deploy or inspect the running system)
- Host/user: **`admin@YOUR_SERVER_IP`** (AWS Lightsail, Debian).
- Auth: an SSH **private key** the operator will provide (Lightsail default key). It is
  **not** in this repo. On the box the app lives at `~/2b2t/`, ZenithProxy at `~/zenith/`.
- Useful: `sudo systemctl status 2b2t-app`, `tmux ls` (bot sessions: `zn`, `zc`, `zd`,
  `z-southhighw`), `tail -f ~/2b2t/app.log`.

### Deploy flow
- **Frontend change** (`dashboard/public/*`): copy the file up, then hard-refresh the
  browser. **No restart.**
  ```bash
  scp -i <key> dashboard/public/app.js admin@YOUR_SERVER_IP:~/2b2t/dashboard/public/
  ```
- **Backend change** (`index.js`, `lib/`, `dashboard/server.js`, etc.): copy up, then
  ```bash
  ssh -i <key> admin@YOUR_SERVER_IP 'sudo systemctl restart 2b2t-app'
  ```
  Restarting the app is safe (bots survive in tmux); **never restart ZenithProxy** — that
  dumps queue positions.
- Always `node --check <file>` and `npm test` before deploying.

---

## 7. Configuration (`.env`)

All config lives in `config.js` with env overrides. Full `.env` for the live system (fill
real values — **secrets provided separately by the operator**):
```ini
# --- Minecraft / hybrid ---
SERVER_HOST=127.0.0.1          # monitor connects to the local ZenithProxy
SERVER_PORT=25571              # (per-account base; auto-assigned)
SERVER_AUTH=offline
SERVER_VERSION=1.21.4          # MUST match ZenithProxy's build version
MONITOR_IGN=MonitorBot           # shared spectator identity
MONITOR_VIEW_DISTANCE=short

# --- Owner / lists ---
OWNER_IGN=<your IGN>
WHITELIST=Name1,Name2          # players that never trigger alerts
WATCHLIST=Name1,Name2          # players that DO trigger priority alerts
PROXY_WHITELIST=<your IGN>     # accounts allowed to drive the bots

# --- Discord ---
DISCORD_WEBHOOK_URL=<secret>
DISCORD_SIGHTING_ALERTS=off    # off | exit | all

# --- Fleet / public ---
FLEET_BASE_PORT=25571
PUBLIC_HOST=YOUR_SERVER_IP

# --- Dashboard ---
DASHBOARD_PORT=3000
DASHBOARD_HOST=0.0.0.0
TRUST_PROXY=false
ADMIN_USER=admin
ADMIN_PASSWORD=<secret>        # only used to bootstrap the first admin user

# --- Proxies (Webshare) ---
WEBSHARE_API_KEY=<secret>
PROXY_MAX_LATENCY_MS=250
PROXY_PREFER_COUNTRIES=US,CA

# --- Logging ---
LOG_LEVEL=info
ACTIVITY_RETENTION_DAYS=0      # 0 = keep forever
```

---

## 8. Security & secrets (read before sharing anything)

- **Secrets NOT in this file (get them from the operator, keep them out of shared docs):**
  the SSH private key, the dashboard **admin password**, the **Webshare API key**, the
  **Discord webhook URL**, and any Microsoft account emails. They live in the VPS `.env`
  (`~/2b2t/.env`) and Lightsail — read them there, don't hardcode or paste them around.
- **Auth model:** scrypt-hashed passwords, HMAC-signed stateless session cookies
  (`httpOnly`, `SameSite=Lax`), 5-strikes login lockout, server-side role enforcement.
- **Known gap (top priority if you touch infra):** the dashboard is served over **plain
  HTTP on `0.0.0.0:3000`**, so the login/cookie cross the internet in cleartext. Put it
  behind HTTPS (Caddy/Cloudflare) or bind to localhost + SSH-tunnel. This is intentionally
  deferred — flag it, don't silently "fix" it in a UI PR.
- Player names are attacker-controlled → the frontend escapes them (`escapeHtml`) before
  DOM insertion, and canvas text is inert. **Preserve this when redesigning** any view that
  renders player/account names.

---

## 9. Gotchas & conventions

- **Tabs are role-gated on the server.** A redesign must keep viewer redaction intact.
- **The map is a `<canvas>`** drawn in `app.js` (bot markers, sightings, highways, ring
  roads, terrain tiles). It's not DOM — restyling it means editing the draw code, not CSS.
- **Coordinates:** Minecraft `+X=East, −Z=North, +Z=South, −X=West`; Nether↔Overworld is
  ×8/÷8. The cartography board is dimension-aware.
- **Files in `data/` are runtime state** — don't commit or hand-edit casually.
- **No bundler / no TypeScript.** Keep the vanilla stack unless the operator asks otherwise;
  a framework rewrite is a big call, not an incidental one.
- Backend has global `unhandledRejection`/`uncaughtException` handlers (won't crash on a
  stray error) and bounded resource usage (caps on caches, metrics, logs).

---

## 10. Current state & recent context (as of handoff)

- **Live:** 4 accounts running on the VPS, mostly cycling through 2b2t's (brutal) queue.
- **The dominant operational reality: these are non-priority 2b2t accounts.** They take
  5–9h to queue, get kicked by 2b2t's non-prio session limit, and lose their queue spot on
  any disconnect. The only real fix is paid **priority queue** — not a code issue.
- **Recently diagnosed:** bots dropped when the operator drove them because their client
  version didn't match ZenithProxy's **1.21.4** → 2b2t anti-cheat kicked them. Fix: drive
  with a 1.21.4 client. Also added **drop-reason logging** (every drop now reports its cause
  + whether the operator was driving) and reliable **death detection** (2b2t custom death
  messages via ZenithProxy's "Player Death" block).
- **UI opportunities to consider in the review:** the Overview/KPIs, the cartography map
  UX, the metrics timelines, mobile responsiveness, and surfacing the queue/drop reality
  (priority-queue status, drop reasons, session-limit ETA) more clearly to the operator.

---

*This overview reflects the codebase as reviewed. When in doubt, `config.js`, `lib/parsers.js`,
`dashboard/server.js`, and `dashboard/public/app.js` are the source of truth. Verify against
the code before asserting behavior.*
