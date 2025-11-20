/**
 * server.js
 *
 * Single entrypoint for the microservice.
 * - Loads .env from the current project directory
 * - Boots Express routes and healthcheck
 * - Connects to Redis, preloads keys, starts cron
 * - Handles graceful shutdown
 */

const path = require('path');

// ✅ Load .env that sits next to this file (project root)
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const express = require('express');
const logger = require('./src/logger');
const redisClient = require('./src/redisClient');
const keyManager = require('./src/keyManager');
const scheduler = require('./src/scheduler');
const keysRoutes = require('./routes/keys');

const app = express();
app.use(express.json());

// Routes
app.use(keysRoutes);

// Basic health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

async function start() {
  try {
    // Connect to Redis
    await redisClient.connectRedis();

    // Preload keys from env / JSON file
    await keyManager.initializeKeysFromEnv();

    // Start cron jobs
    scheduler.startSchedulers();

    const port = Number(process.env.PORT) || 3000;
    const server = app.listen(port, () => {
      logger.info({ msg: `MailTester Key Manager listening on port ${port}` });
    });

    // Graceful shutdown
    const shutdown = async () => {
      logger.info({ msg: 'Shutting down server...' });
      server.close(async () => {
        try {
          await redisClient.client.quit();
        } catch (err) {
          logger.error({ msg: 'Error during Redis quit', error: err.message });
        }
        process.exit(0);
      });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (err) {
    logger.error({ msg: 'Error during startup', error: err.message });
    process.exit(1);
  }
}

// Auto-start unless running under tests
if (process.env.NODE_ENV !== 'test') {
  start().catch((err) => {
    logger.error({ msg: 'Unhandled startup error', error: err.message });
  });
}

module.exports = app;
