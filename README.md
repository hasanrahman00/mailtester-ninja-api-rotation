# MailTester Key Manager Microservice

This project implements a **MailTester Ninja API key manager** as a Node.js microservice. It centralises storage for any number of MailTester subscription IDs (keys), enforces MailTester rate limits, and exposes a REST API so that other services can obtain an available key on demand.

The service runs continuously, performing scheduled maintenance jobs (window resets, daily resets, health checks, and `.env` synchronisation) while responding to HTTP traffic. Key metadata now lives in **MongoDB**, **Express** powers the HTTP server, and **node-cron** orchestrates recurring work.

## Features

- **Multiple key support:** register as many MailTester subscriptions as you like and load-balance requests automatically.
- **Rate limiting:** enforces per-30-second and per-day limits for both Pro and Ultimate plans directly in MongoDB.
- **Usage tracking & persistence:** stores counters, statuses, and plan metadata in MongoDB for durability.
- **`.env` watcher + health checker:** keeps runtime keys in sync with the `.env` file and removes dead keys automatically.
- **BullMQ-powered queue:** buffers bursts of `/key/available` requests in Redis so callers wait their turn instead of being rejected while keys cool down.
- **REST API:** obtain an available key, inspect status, add/remove keys, and push validation telemetry for analytics.
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

   **Preloading keys** (set *one* input source, checked in the order shown):

   1. `MAILTESTER_KEYS_JSON` – JSON array of `{ id, plan }` objects.
   2. `MAILTESTER_KEYS_JSON_PATH` – path to the JSON file described above.
   3. `MAILTESTER_KEYS_WITH_PLAN` – comma separated `id:plan` entries.
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

Enqueues the caller inside a BullMQ queue, then returns the next available MailTester key while atomically incrementing its usage counters in MongoDB. If you configure an HTTP timeout and it elapses while every key is still cooling down, the route responds with `429 { status: "wait" }`; otherwise the connection remains open until a key frees up.

```json
{
   "subscriptionId": "sub_abc123",
   "plan": "ultimate"
}
```

Use the returned `subscriptionId` directly when calling `https://happy.mailtester.ninja/ninja`.

### `GET /status`

Lists every key along with current counters, plan, status, rate limits, and timestamps as stored in MongoDB.

### `POST /keys`

Registers or updates a key. Body must include `subscriptionId` (or `id`) and `plan` (`pro` or `ultimate`). Re-registering adjusts plan + rate limits without resetting counters.

### `DELETE /keys/:id`

Removes a key document from MongoDB and stops it from being served.

### `POST /results`

Records an email validation outcome that a downstream service observed directly from MailTester. This lets you keep centralised usage metrics even when MailTester is called without proxying through this service.

```json
{
   "subscriptionId": "sub_abc123",
   "email": "user@example.com",
   "code": "ok",
   "message": "Mailbox is accepting mail",
   "durationMs": 742,
   "metadata": {
      "source": "email-enricher"
   }
}
```

Responds with `202` when the result is accepted. If the subscription ID is unknown you receive `404`.

### `GET /stats`

Returns aggregated validation metrics grouped per subscription along with a global summary:

```json
{
   "summary": {
      "total": 1250,
      "byCode": {
         "ok": 1100,
         "catch_all": 120,
         "unknown": 30
      }
   },
   "keys": [
      {
         "subscriptionId": "sub_abc123",
         "plan": "ultimate",
         "total": 800,
         "byCode": {
            "ok": 750,
            "catch_all": 40,
            "unknown": 10
         },
         "lastResult": {
            "email": "user@example.com",
            "code": "ok",
            "timestamp": 1700000000000
         }
      }
   ]
}
```

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
| `routes/keys.js` | Express router implementing `/key/available`, `/status`, `/results`, `/stats`, `/keys` (POST) and `/keys/:id` (DELETE). |
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
| `validationStats` | Aggregated telemetry: totals, per-code counts, and the last reported result. |

Counters reset automatically via schedulers, and exhausted keys flip back to `active` after the next daily reset.

## Example usage

```js
const axios = require('axios');

async function run() {
  const { data } = await axios.get('http://localhost:3000/key/available');
   const response = await axios.get(`https://happy.mailtester.ninja/ninja?email=test@example.com&key=${data.subscriptionId}`);
  console.log(response.data);
}

run().catch(console.error);
```

The microservice enforces limits and balances across all configured subscriptions so downstream code can focus on MailTester requests.

## License

MIT