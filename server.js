/**
 * server.js
 *
 * Single entrypoint for the microservice.
 * - Loads .env from the current project directory
 * - Boots Express routes and healthcheck
 * - Connects to MongoDB, preloads keys, starts cron
 * - Handles graceful shutdown
 */

const path = require('path');

// ✅ Load .env that sits next to this file (project root)
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const express = require('express');
const logger = require('./src/logger');
const mongoClient = require('./src/mongoClient');
const keyManager = require('./src/keyManager');
const scheduler = require('./src/scheduler');
const envWatcher = require('./src/envWatcher');
const keyHealthChecker = require('./src/keyHealthChecker');
const { shutdownKeyQueue } = require('./src/keyQueue');
const keysRoutes = require('./routes/keys');

const app = express();
app.use(express.json());

// Routes
app.use(keysRoutes);

// Basic health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

async function start() {
  let stopEnvWatcher = async () => {};
  let stopHealthChecker = async () => {};
  try {
    // Connect to MongoDB
    await mongoClient.connectMongo();

    // Preload keys from env / JSON file
    await keyManager.initializeKeysFromEnv();

    // Start watching the .env file to keep keys in sync
    stopEnvWatcher = await envWatcher.startWatching(path.resolve(__dirname, '.env'));

    // Start the 24-hour key health checker
    stopHealthChecker = keyHealthChecker.startScheduler(path.resolve(__dirname, '.env'));

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
          await mongoClient.disconnectMongo();
        } catch (err) {
          logger.error({ msg: 'Error during Mongo disconnect', error: err.message });
        }
        try {
          await stopEnvWatcher();
        } catch (err) {
          logger.error({ msg: 'Error stopping env watcher', error: err.message });
        }
        try {
          await stopHealthChecker();
        } catch (err) {
          logger.error({ msg: 'Error stopping key health checker', error: err.message });
        }
        try {
          await shutdownKeyQueue();
        } catch (err) {
          logger.error({ msg: 'Error shutting down key queue', error: err.message });
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
