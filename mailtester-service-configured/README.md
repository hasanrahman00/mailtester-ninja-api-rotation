# MailTester Key Manager Microservice

This project implements a **MailTester Ninja API key manager** as a Node.js microservice.  It centralises storage of one or more MailTester subscription IDs (also referred to as _keys_), enforces the MailTester rate limits, refreshes authentication tokens automatically and exposes a small REST API so that other services can obtain an available key on demand.

The microservice is designed to run continuously, performing scheduled maintenance jobs (token refreshes, window resets and daily resets) while responding to HTTP requests.  It uses **Redis** as the backing store, **Express** for the HTTP server and **node‑cron** for scheduled tasks.  All configuration is supplied via a `.env` file.

## Features

- **Multiple key support:** manage any number of MailTester subscription IDs and balance requests across them.
- **Rate limiting:** enforces per‑30‑second and per‑day limits for both Pro and Ultimate plans.
- **Automatic token refresh:** fetches a new MailTester token every 24 hours (configurable via `REFRESH_INTERVAL_HOURS`).
- **Usage tracking:** stores counters in Redis and resets them automatically on a 30 second and 24 hour cadence.
- **REST API:** provides endpoints to obtain an available key, inspect status and add/remove keys at runtime.
- **Graceful shutdown:** cleans up open connections and cron jobs when the process exits.
- **Structured logging:** uses [winston](https://github.com/winstonjs/winston) to log important events and errors.

## Project structure

```
mailtester-service/
├── package.json           # project metadata and dependencies
├── .env.example           # sample environment configuration
├── apiServer.js           # entry point and Express server
├── redisClient.js         # Redis connection helper
├── keyManager.js          # key management and business logic
├── scheduler.js           # cron job definitions
├── logger.js              # winston logger configuration
├── routes/
│   └── keys.js            # HTTP route definitions
├── README.md              # this file

```

## Getting started

1. **Clone or download** this repository and move into the `mailtester-service` directory.
2. **Install dependencies** using npm:

   ```bash
   npm install
   ```

3. **Configure environment variables:** copy `.env.example` to `.env` and provide values for your environment.  At a minimum you need to set:

   - `REDIS_URL`: the connection string for your Redis instance.  **Choose the
     scheme and port carefully:** Redis Cloud exposes two endpoints: one for
     plain TCP and another for TLS.  Use `redis://` with the non‑TLS port
     (usually `10180`) or `rediss://` with the TLS port (usually `10181`).
     If the wrong scheme/port combination is used you will see SSL errors
     such as “wrong version number”.
   - `REDIS_PASSWORD`: the password for Redis (if not embedded in the URL).  If
     your URL contains the password you can leave this blank.
  - **Preloading MailTester keys:** There are three environment variables that you can use to preload your subscription IDs and their plans on startup.  Only set **one** of these; the loader checks them in order of precedence:

     1. `MAILTESTER_KEYS_JSON` – JSON array of objects with `id` and `plan` fields.  Example:

       ```
       MAILTESTER_KEYS_JSON=[{"id":"sub_aaa111","plan":"pro"},{"id":"sub_bbb222","plan":"ultimate"}]
       ```

        This format allows explicit control over the plan for each key.

     In addition to specifying the JSON inline, you can point to a file containing
     the JSON array by using `MAILTESTER_KEYS_JSON_PATH`.  For example, if
     `keys.json` contains:

     ```json
     [
       { "id": "sub_aaa111", "plan": "pro" },
       { "id": "sub_bbb222", "plan": "ultimate" }
     ]
     ```

     you can set:

     ```ini
     MAILTESTER_KEYS_JSON_PATH=./keys.json
     ```

     The file path is resolved relative to the project root.  This is a
     convenient way to manage large lists of keys.

    2. `MAILTESTER_KEYS_WITH_PLAN` – comma‑separated list of `id:plan` pairs.  Example:

       ```
       MAILTESTER_KEYS_WITH_PLAN=sub_aaa111:ultimate,sub_bbb222:pro
       ```

       A concise mapping of keys to plans.

    3. `MAILTESTER_KEYS` – comma‑separated list of IDs.  When using this format you must also set `MAILTESTER_DEFAULT_PLAN` to either `pro` or `ultimate`.  All listed keys will use the same plan.  Example:

       ```
       MAILTESTER_KEYS=sub_aaa111,sub_bbb222
       MAILTESTER_DEFAULT_PLAN=ultimate
       ```

       This is the simplest option when all keys share the same plan.

    The environment loader will use the first non‑empty variable in the order shown above.

4. **Start the microservice:**

   ```bash
   npm start
   ```

The server listens on `PORT` (defaults to `3000`) and connects to Redis on start.  It preloads any keys defined via `MAILTESTER_KEYS_JSON`, `MAILTESTER_KEYS_WITH_PLAN` or `MAILTESTER_KEYS` into Redis and applies the appropriate rate limits based on each key's plan.

If you prefer not to preload keys via environment variables, you can add them at runtime using the API (see below).  When using `MAILTESTER_KEYS` you must also set `MAILTESTER_DEFAULT_PLAN` to specify the plan for all keys in the list.

### Development and hot reload

During development you can use `npm run dev` to automatically restart the server when files change.  This command relies on `nodemon` (included as a development dependency) to monitor file changes and restart the Node.js process.  You may need to install `nodemon` globally if it is not already available:

```bash
npm install -g nodemon
```

## API

All endpoints return JSON and live under the root path.  If any operation fails the server responds with an appropriate HTTP status and a JSON body containing an error message.

### `GET /key/available`

Retrieves an available MailTester key and increments its usage counters.  If all keys are currently at their limits the service responds with `429 Too Many Requests` and instructs the client to retry later.

**Response (`200 OK`):**

```json
{
  "subscriptionId": "sub_abc123",
  "token": "Mk5ETL…",
  "plan": "ultimate"
}
```

**Response (`429 Too Many Requests`):**

```json
{
  "status": "wait",
  "retryIn": 3000,
  "message": "All keys busy"
}
```

### `GET /status`

Returns an array containing the current status and usage metrics for every key registered in Redis.  Useful for monitoring and debugging.

**Response (`200 OK`):**

```json
[
  {
    "subscriptionId": "sub_abc123",
    "plan": "pro",
    "status": "active",
    "usedInWindow": 10,
    "windowStart": 1734316980000,
    "usedDaily": 500,
    "dayStart": 1734310000000,
    "rateLimit30s": 35,
    "dailyLimit": 100000,
    "avgRequestIntervalMs": 850,
    "lastRefresh": 1734317000000,
    "lastUsed": 1734317032000
  },
  ...
]
```

### `POST /keys`

Registers a new key at runtime.  The request body must contain a `subscriptionId` and `plan` field.  Accepted plans are `pro` or `ultimate`.  Attempting to register an existing key will simply update its plan and limits.

**Request body:**

```json
{
  "subscriptionId": "sub_new123",
  "plan": "pro"
}
```

**Response (`201 Created`):**

```json
{ "message": "Key sub_new123 registered" }
```

### `DELETE /keys/:id`

Removes a key by subscription ID.  This deletes the corresponding hash and removes the entry from the internal set.

**Response (`200 OK`):**

```json
{ "message": "Key sub_abc123 deleted" }
```

## Scheduler tasks

The microservice runs three periodic tasks:

1. **Token refresh** (every `REFRESH_INTERVAL_HOURS` hours): fetches a new token from MailTester for each key whose last refresh is older than the configured interval.  An HTTP request is made to `https://token.mailtester.ninja/token?key=YOUR_KEY` and the returned token is stored in Redis.
2. **Window reset** (every 30 seconds): resets each key's `usedInWindow` counter when its 30 second window has elapsed.
3. **Daily reset** (once a day): resets the daily usage counter and reactivates any keys that were marked as exhausted.

The scheduler is started automatically when the application runs in a non‑test environment.  See `scheduler.js` for details.

## Architecture and modules

This microservice follows a modular structure to keep concerns separated and
maintainable.  Each file has a specific role:

| Module            | Purpose |
|-------------------|---------|
| `apiServer.js`    | Entry point that bootstraps the Express app, connects to Redis, initialises keys from the environment or JSON file and starts scheduled tasks.  Exposes the REST API and handles graceful shutdown on process signals. |
| `redisClient.js`  | Encapsulates configuration of the Redis client.  Parses the `REDIS_URL` to determine host, port and TLS settings, applies the password and logs connection events. |
| `keyManager.js`   | Core business logic for managing MailTester keys.  Computes rate limits based on plan, registers/updates/deletes keys, selects an available key while respecting per‑window and per‑day quotas, refreshes tokens and resets usage counters.  Supports multiple environment formats for preloading keys including a JSON file. |
| `scheduler.js`    | Defines cron jobs for resetting window and daily counters and refreshing tokens.  Starts the jobs when invoked by the server. |
| `routes/keys.js`  | Defines REST API endpoints for obtaining an available key (`/key/available`), listing key status (`/status`), adding a key (`POST /keys`) and deleting a key (`DELETE /keys/:id`).  Delegates all business logic to `keyManager` and provides consistent error handling. |
| `logger.js`       | Configures the winston logger to emit structured logs to STDOUT.  Used throughout the project for consistent logging. |
| `.env.example`    | Template environment configuration.  Copy this to `.env` and adjust values to match your Redis instance and key preloading preferences.  Supports inline JSON, CSV mapping and plain lists, as well as loading keys from an external JSON file via `MAILTESTER_KEYS_JSON_PATH`. |
| `package.json`    | Contains project metadata, dependencies and NPM scripts.  Use `npm start` to run the service and `npm run dev` to start with hot reload. |

### Module orchestration

On startup the following sequence occurs (see `apiServer.js` for implementation):

1. `.env` variables are loaded via `dotenv`.
2. A Redis client is created and connected (`redisClient.js`).
3. The `keyManager` initialises all keys from the configured environment variables or JSON file.  New keys are registered with the appropriate rate limits; existing keys are updated with the correct limits and plan if needed.
4. The `scheduler` starts cron jobs to periodically reset counters and refresh tokens.
5. The Express server begins listening on the configured port, exposing the API routes defined in `routes/keys.js`.

If any of these steps fail (e.g. Redis connection errors), the process logs the error and exits.  During shutdown (SIGINT/SIGTERM) the HTTP server is closed and the Redis client is cleanly disconnected.

### Configuring Redis

To connect to Redis Cloud or another Redis deployment, set the `REDIS_URL` environment variable to the full connection string.  This should include the username (usually `default`), password and host:port.  Choose the scheme according to your port:

* `redis://` – connect without TLS (plain TCP).  Typically used with port `10180` in Redis Cloud.
* `rediss://` – connect with TLS.  Typically used with port `10181`.  On Windows development machines the TLS connection uses `rejectUnauthorized: false` to allow self‑signed certificates.

If the password is embedded in the URL you can leave `REDIS_PASSWORD` empty.  Otherwise specify the password separately.  If your Redis Cloud instance is protected by an IP allowlist ensure that your machine’s IP is added.


## Key data model

Each key is stored as a Redis hash under the pattern `mailtester:key:{subscriptionId}` with the following fields:

| Field                | Description                                          | Example             |
|----------------------|------------------------------------------------------|---------------------|
| `plan`               | Subscription plan (`pro` or `ultimate`)             | `ultimate`          |
| `token`              | Current MailTester token                            | `Mk5ETL…`           |
| `lastRefresh`        | Unix timestamp (ms) when token was last refreshed   | `1734317000000`     |
| `usedInWindow`       | Number of requests in the current 30 s window       | `120`               |
| `windowStart`        | Timestamp when the current 30 s window began        | `1734316980000`     |
| `usedDaily`          | Requests made during the current day                | `4200`              |
| `dayStart`           | Timestamp when the current daily counter began      | `1734310000000`     |
| `status`             | `active`, `exhausted` or `banned`                   | `active`            |
| `rateLimit30s`       | Maximum calls allowed per 30 s window               | `170`               |
| `dailyLimit`         | Maximum calls allowed per day                       | `500000`            |
| `avgRequestIntervalMs`| Recommended delay between calls (ms)               | `170`               |
| `lastUsed`           | Timestamp of the last API call (optional)           | `1734317032000`     |

When the usage counters exceed their limits the key's `status` is automatically updated.  Exhausted keys are ignored until the next daily reset; banned keys must be deleted manually or reactivated by changing their status in Redis.

## Example usage

An external application can request an available key and use it to call the MailTester Ninja API.  An example worker script is provided in `exampleWorker.js`:

```js
const axios = require('axios');

async function run() {
  // Obtain a key from the microservice
  const { data } = await axios.get('http://localhost:3000/key/available');
  const { token } = data;

  // Use the token to call MailTester Ninja
  const response = await axios.get(`https://happy.mailtester.ninja/ninja?email=test@example.com&token=${token}`);
  console.log(response.data);
}

run().catch((err) => console.error(err));
```

This worker fetches a key via the microservice, then uses that key to check an email address with MailTester Ninja.  The microservice takes care of all token rotation and rate limit enforcement.

## Contributing

Contributions are welcome!  Feel free to open an issue or submit a pull request with improvements or bug fixes.  When making changes please ensure the test suite passes (`npm test`) and add new tests where appropriate.

## License

This project is licensed under the MIT License.  See the `LICENSE` file for details.