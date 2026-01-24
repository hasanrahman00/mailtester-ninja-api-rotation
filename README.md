# MailTester Key Manager Microservice

This project implements a **MailTester Ninja API key manager** as a Node.js microservice. It centralises storage for any number of MailTester subscription IDs (keys), enforces MailTester rate limits, and exposes a REST API so that other services can obtain an available key on demand.

The service runs continuously, performing scheduled maintenance jobs (window resets, daily resets, health checks, and `.env` synchronisation) while responding to HTTP traffic. Key metadata now lives in **MongoDB**, **Express** powers the HTTP server, and **node-cron** orchestrates recurring work.

## Features

- **Multiple key support:** register as many MailTester subscriptions as you like and load-balance requests automatically.
- **Rate limiting:** enforces per-30-second, per-day, and per-request spacing limits (default spacing 860 ms for Pro, 170 ms for Ultimate; override via `MAILTESTER_PRO_INTERVAL_MS` / `MAILTESTER_ULTIMATE_INTERVAL_MS`).
- **Usage tracking & persistence:** stores counters, statuses, and plan metadata in MongoDB for durability.
- **`.env` watcher + health checker:** keeps runtime keys in sync with the `.env` file and removes dead keys automatically.
- **BullMQ-powered queue:** buffers bursts of `/key/available` requests in Redis so callers wait their turn instead of being rejected while keys cool down.
- **REST API:** obtain an available key, inspect status, add/remove keys, and push validation telemetry for analytics.
- **Client-facing rate metadata:** `/key/available`, `/status`, and `/limits` expose `avgRequestIntervalMs`, `lastUsed`, and `nextRequestAllowedAt` so callers know exactly when a key may be reused.
- **Structured logging & graceful shutdown:** consistent JSON logging with clean teardown of schedulers, watchers, and DB connections.

## Project structure

```
mailtester-ninja-api-rotation/
├── server.js                 # Entrypoint (Express app + boot logic)
├── package.json
├── routes/
│   └── keys.js               # REST routes
└── src/
    ├── keyManager.js        # Business logic + Mongo persistence
   ├── keyQueue.js          # BullMQ queue + worker
   ├── redis.js             # Redis connection helper
    ├── mongoClient.js       # MongoDB connection helper
    ├── scheduler.js         # node-cron jobs
    ├── envWatcher.js        # Watches .env and syncs keys
    ├── keyHealthChecker.js  # Daily health validation job
    └── logger.js            # Winston configuration
```

## Getting started

1. **Install dependencies**

   ```powershell
   npm install
   ```

2. **Configure environment variables** (create `.env` if needed). Minimum settings:

   - `MONGODB_URI` – MongoDB connection string (Atlas or self-hosted).
   - `MONGODB_DB_NAME` – optional, defaults to `mailtester`.
   - `PORT` – HTTP port (defaults to `3000`).
   - `REDIS_URL` – Redis connection string used by BullMQ (e.g. `redis://user:pass@host:port`). If omitted, set `REDIS_HOST`, `REDIS_PORT`, and optional `REDIS_PASSWORD`.

   **Queue tuning (optional):**

   - `KEY_QUEUE_CONCURRENCY` – how many jobs BullMQ processes in parallel (default `5`).
   - `KEY_QUEUE_BACKOFF_MS` – delay between retries while waiting for a free key (default `1000`).
   - `KEY_QUEUE_MAX_WAIT_MS` – max time (ms) a worker retries before giving up; set `0`/unset (default) to wait indefinitely.
   - `KEY_QUEUE_REQUEST_TIMEOUT_MS` – optional HTTP wait timeout (ms). Leave unset/`0` to keep the connection open until a key is available.

   **MailTester spacing overrides (optional):**

   - `MAILTESTER_PRO_INTERVAL_MS` – override the default 860 ms spacing for Pro keys.
   - `MAILTESTER_ULTIMATE_INTERVAL_MS` – override the default 170 ms spacing for Ultimate keys.

   **Preloading keys** (set *one* input source, checked in the order shown):

   1. `MAILTESTER_KEYS_JSON` – JSON array of `{ id, plan }` objects.
   2. `MAILTESTER_KEYS_JSON_PATH` – path to the JSON file described above.
   3. `MAILTESTER_KEYS_WITH_PLAN` – comma separated `id:plan` entries (e.g. `sub_pro_id:pro,sub_unlimited_id:ultimate`).
   4. `MAILTESTER_KEYS` – comma separated IDs; requires `MAILTESTER_DEFAULT_PLAN`.

   Plans accept `pro` or `ultimate` (case-insensitive). The `.env` watcher replays the same parsing logic to keep MongoDB updated at runtime.

3. **Run the service**

   ```powershell
   npm start
   ```

   For hot reload in development use `npm run dev` (via `nodemon`).

## API

All endpoints return JSON and live at the root path.

### `GET /key/available`

Returns a single reserved MailTester key while atomically incrementing its usage counters in MongoDB. If no key is currently available, the route responds with `status: "wait"` and a `waitMs` hint (the smaller of the Pro/Ultimate average interval settings).

```json
{
   "status": "ok",
   "key": {
      "subscriptionId": "sub_abc123",
      "plan": "ultimate",
      "avgRequestIntervalMs": 170,
      "lastUsed": 1700000000000,
      "nextRequestAllowedAt": 1700000000170
   }
}
```

```json
{
   "status": "wait",
   "waitMs": 170
}
```

Clients should respect `avgRequestIntervalMs` and `nextRequestAllowedAt` before reusing a key.

Use the returned `subscriptionId` directly when calling `https://happy.mailtester.ninja/ninja`.

### `GET /key/available/queued`

Enqueues the caller inside a BullMQ queue and waits for the next available key. If `KEY_QUEUE_REQUEST_TIMEOUT_MS` is set and the wait exceeds the timeout, the route responds with `429 { "status": "wait", "waitMs": <hint> }`.

### `GET /status`

Lists every key along with current counters, plan, status, rate limits, and timestamps as stored in MongoDB.

### `GET /limits`

Returns only the rate-limit metadata for each key (`plan`, `rateLimit30s`, `dailyLimit`, `avgRequestIntervalMs`, `lastUsed`, `nextRequestAllowedAt`) so that external services can plan their request cadence without fetching the full status payload.

### `POST /keys`

Registers or updates a key. Body must include `subscriptionId` (or `id`) and `plan` (`pro` or `ultimate`). Re-registering adjusts plan + rate limits without resetting counters.

### `DELETE /keys/:id`

Removes a key document from MongoDB and stops it from being served.

## Scheduler & background jobs

- **Window reset** (`*/30 * * * * *`): clears 30-second counters when the window elapses.
- **Daily reset** (`* * * * *`): clears daily counters + reactivates exhausted keys once their 24-hour window passes.
- **`.env` watcher:** keeps MongoDB keys aligned with the `.env` definitions.
- **Key health checker** (`0 0 * * *` UTC): validates each key via the MailTester API, deletes failures, and removes them from `.env`.

All background work logs successes/errors and continues on failure to maintain availability.

## Architecture overview

| Module | Responsibility |
| --- | --- |
| `server.js` | Loads `.env`, connects to MongoDB, initialises keys, starts schedulers + watchers, wires Express routes, and manages graceful shutdown. |
| `src/mongoClient.js` | Wraps the official MongoDB driver, exposing `connectMongo()`, `disconnectMongo()`, and helpers to fetch collections. |
| `src/keyManager.js` | Central business logic for keys: env initialisation, CRUD helpers, rate-limit enforcement, counters, and MongoDB operations. |
| `src/envWatcher.js` | Watches the `.env` file, re-parses key definitions, registers new keys, and deletes keys removed from `.env`. |
| `src/keyHealthChecker.js` | Nightly cron that pings MailTester, deletes invalid keys from MongoDB, and cleans matching entries out of `.env`. |
| `src/scheduler.js` | Registers cron jobs for window resets and daily resets. |
| `routes/keys.js` | Express router implementing `/key/available`, `/status`, `/keys` (POST) and `/keys/:id` (DELETE). |
| `src/keyQueue.js` | BullMQ queue + worker that buffers `/key/available` calls and retries until a key is free. |
| `src/redis.js` | Factory for BullMQ Redis connections (URL or host/port/password inputs). |
| `src/logger.js` | Winston logger shared across the service. |

## Key data model (MongoDB `keys` collection)

| Field | Description |
| --- | --- |
| `subscriptionId` | MailTester subscription ID (unique). |
| `plan` | `pro` or `ultimate`. |
| `status` | `active`, `exhausted`, or `banned`. |
| `usedInWindow`, `windowStart` | 30-second rate limiting counters. |
| `usedDaily`, `dayStart` | Daily quota counters. |
| `rateLimit30s`, `dailyLimit`, `avgRequestIntervalMs` | Derived limits based on plan. |
| `lastUsed` | Timestamp of the most recent successful selection. |

Counters reset automatically via schedulers, and exhausted keys flip back to `active` after the next daily reset.

## Example usage

```js
const axios = require('axios');

async function run() {
  const { data } = await axios.get('http://localhost:3000/key/available');
    if (data.status !== 'ok') {
       throw new Error(`No key available. Wait ${data.waitMs}ms`);
    }
    const response = await axios.get(
       `https://happy.mailtester.ninja/ninja?email=test@example.com&key=${data.key.subscriptionId}`
    );
  console.log(response.data);
}

run().catch(console.error);
```

The microservice enforces limits and balances across all configured subscriptions so downstream code can focus on MailTester requests.

## Docker & GitHub Actions deployment

This repository includes a production-ready container image (`Dockerfile`) and an automated deploy pipeline (`.github/workflows/deploy.yml`). Deployments run on every push to `main` (and on manual triggers via **Run workflow**) and perform the following steps:

- Build the Node.js service image with `docker buildx`.
- Push the image to GitHub Container Registry (GHCR) under `ghcr.io/<owner>/<repo>` with both `latest` and commit SHA tags.
- Copy `deploy/docker-compose.yml` to your VPS and run `docker compose pull && docker compose up -d` to refresh the running container.

### 1. Prepare the VPS

- Install Docker Engine and the Compose plugin (`sudo apt install docker.io docker-compose-plugin`).
- Create directories for configuration:
   - `/etc/mailtester/.env` — copy your production `.env` here.
   - `/opt/mailtester/keys.json` — populated automatically from `deploy/keys.json` in the repo on every deploy.
   - `/opt/mailtester` — deployment root used by the workflow.
- Ensure the deploy user (set in `VPS_USER`) can run Docker (add to the `docker` group or configure `sudo` without password).

### 2. Configure GitHub Secrets

Add the following repository secrets before enabling the workflow:

- `VPS_HOST` — server IP or hostname (e.g. `158.220.114.211`).
- `VPS_USER` — SSH user with access to Docker.
- `VPS_SSH_KEY` — **private** SSH key authorised on the VPS (use `ssh-keygen -t ed25519`). Store the entire PEM string.
- `GHCR_PAT` — personal access token with at least `read:packages` scope (so the VPS can `docker login ghcr.io`).
- Optional: `VPS_PORT` if SSH runs on a non-default port (the workflow defaults to `22`).

### 3. First-time deployment

1. Commit + push the Docker setup or run **Actions → Build and Deploy → Run workflow**.
2. The workflow creates `/opt/mailtester/docker-compose.yml` on the VPS. Review/edit if you need different host paths/ports.
3. Ensure `/etc/mailtester/.env` exists *before* the first pipeline run; the container fails to boot if `.env` is missing. The pipeline copies `deploy/keys.json` into `/opt/mailtester/keys.json` automatically.
4. Verify the service with `docker compose ps` and `curl http://<host>:8000/health` (port 8000 is mapped to the container's internal port 3000).

On subsequent pushes to `main`, GitHub Actions will build a new image, push to GHCR, and redeploy automatically. To roll back, run `docker compose up -d` on the VPS with a previous tag (e.g. `ghcr.io/<owner>/<repo>:<old-sha>`).

To rotate MailTester keys, edit `deploy/keys.json`, commit, and push. The workflow syncs that file to `/opt/mailtester/keys.json` on the VPS during each deploy.

## License

MIT

Production endpoints:
- https://api.daddy-leads.com/mailtester/health
- https://api.daddy-leads.com/mailtester/key/available
- https://api.daddy-leads.com/mailtester/status