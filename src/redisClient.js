/**
 * redisClient.js
 *
 * This module encapsulates the configuration and lifecycle of a Redis client
 * using the official `redis` package (v4).  It reads connection details
 * from environment variables (`REDIS_URL` and `REDIS_PASSWORD`) and
 * establishes TLS automatically when the URL uses the `rediss://` scheme.
 *
 * The client is configured by parsing the connection string manually to
 * construct a socket configuration.  node-redis does not always apply TLS
 * correctly when the URL property alone is specified, especially on
 * non-standard ports.  By deriving the host, port and TLS options from
 * `REDIS_URL` we ensure consistent behaviour across environments.
 *
 * Logging is handled via winston and will record connection events,
 * reconnections and errors.  Consumers should call `connectRedis()` once
 * during startup before executing any commands against the client.
 */
const { createClient } = require('redis');
const logger = require('./logger');
const redisUrl = process.env.REDIS_URL || '';
const redisPassword = process.env.REDIS_PASSWORD || undefined;

// Build connection configuration from the provided URL.  node-redis does not
// always correctly apply TLS settings when using only the `url` property,
// especially on non-standard ports.  Instead we parse the URL manually and
// construct a socket configuration.  The username and password from the URL
// take precedence unless REDIS_PASSWORD is set.
let client;
try {
  if (redisUrl) {
    const parsed = new URL(redisUrl);
    const socket = {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : undefined
    };
    if (parsed.protocol === 'rediss:') {
      socket.tls = true;
      socket.rejectUnauthorized = false;
    }
    // Use username and password from URL if present
    const username = parsed.username || undefined;
    const urlPassword = parsed.password || undefined;
    client = createClient({
      socket,
      username,
      // REDIS_PASSWORD overrides password from the URL if provided
      password: redisPassword || urlPassword
    });
  } else {
    // Fallback to default connection (localhost)
    client = createClient();
  }
} catch (err) {
  // If URL parsing fails fall back to default
  client = createClient({ url: redisUrl, password: redisPassword });
}

client.on('connect', () => {
  logger.info({ msg: 'Redis connecting', url: redisUrl });
});

client.on('ready', () => {
  logger.info({ msg: 'Redis ready' });
});

client.on('error', (err) => {
  // Include the error object in logs to aid troubleshooting.  Some errors do not
  // populate the `.message` property (e.g. connection refused) so fall back
  // to the entire error object.
  logger.error({ msg: 'Redis error', error: err && err.message ? err.message : err });
});

client.on('reconnecting', () => {
  logger.warn({ msg: 'Redis reconnecting' });
});

async function connectRedis() {
  if (!client.isOpen) {
    try {
      await client.connect();
    } catch (err) {
      logger.error({ msg: 'Failed to connect to Redis', error: err.message });
      throw err;
    }
  }
}

module.exports = {
  client,
  connectRedis
};
