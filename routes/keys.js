/**
 * keys.js (router)
 *
 * Defines REST endpoints for interacting with MailTester subscription keys.
 * Routes include:
 *   - GET /key/available - obtain an available key within rate limits
 *   - GET /status - list status and counters for all keys
 *   - POST /keys - register or update a key
 *   - DELETE /keys/:id - remove a key
 *
 * Each handler delegates core logic to the keyManager and provides
 * comprehensive error handling and consistent JSON responses.
 */

const express = require('express');
const keyManager = require('../src/keyManager');
const { keyQueue, keyQueueEvents } = require('../src/keyQueue');
const logger = require('../src/logger');

const router = express.Router();
const DEFAULT_PRO_INTERVAL_MS = 860;
const DEFAULT_ULTIMATE_INTERVAL_MS = 170;

function resolveIntervalMs(rawValue, fallback) {
  const numeric = Number(rawValue);
  if (Number.isFinite(numeric) && numeric > 0) {
    return Math.floor(numeric);
  }
  return fallback;
}

function getDefaultWaitMs() {
  const proInterval = resolveIntervalMs(
    process.env.MAILTESTER_PRO_INTERVAL_MS,
    DEFAULT_PRO_INTERVAL_MS
  );
  const ultimateInterval = resolveIntervalMs(
    process.env.MAILTESTER_ULTIMATE_INTERVAL_MS,
    DEFAULT_ULTIMATE_INTERVAL_MS
  );
  return Math.min(proInterval, ultimateInterval);
}

/**
 * GET /key/available
 *
 * Returns a single reserved MailTester key within rate limits. If none are
 * currently available the client receives a wait hint.
 */
router.get('/key/available', async (_req, res) => {
  try {
    const key = await keyManager.getAvailableKey();
    if (!key) {
      return res.json({ status: 'wait', waitMs: getDefaultWaitMs() });
    }
    return res.json({ status: 'ok', key });
  } catch (err) {
    logger.error({ msg: 'Error in /key/available', error: err?.message || err });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /key/available/queued
 *
 * Enqueues the caller to wait for the next available key.
 */
router.get('/key/available/queued', async (_req, res) => {
  try {
    const timeoutMs = Number(process.env.KEY_QUEUE_REQUEST_TIMEOUT_MS || 0);
    const waitTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;

    const job = await keyQueue.add('key-request', {}, { removeOnComplete: true, removeOnFail: true });
    const key = await job.waitUntilFinished(keyQueueEvents, waitTimeout);
    return res.json({ status: 'ok', key });
  } catch (err) {
    const message = err?.message || String(err);
    if (message.includes('QUEUE_TIMEOUT') || message.toLowerCase().includes('timed out')) {
      return res.status(429).json({ status: 'wait', waitMs: getDefaultWaitMs() });
    }
    logger.error({ msg: 'Error in /key/available/queued', error: message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /status
 *
 * Returns the status and usage metrics for all keys in the system.
 */
router.get('/status', async (req, res) => {
  try {
    const status = await keyManager.getAllKeysStatus();
    return res.json(status);
  } catch (err) {
    logger.error({ msg: 'Error in /status', error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/limits', async (_req, res) => {
  try {
    const limits = await keyManager.getKeyLimits();
    return res.json(limits);
  } catch (err) {
    logger.error({ msg: 'Error in /limits', error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /keys
 *
 * Registers a new key or updates an existing one.  The request body must
 * include a `subscriptionId` and a valid `plan` ("pro" or "ultimate").
 */
router.post('/keys', async (req, res) => {
  // Accept either "subscriptionId" or "id" to support multiple naming conventions.
  const { subscriptionId, id, plan } = req.body || {};
  const subId = (subscriptionId || id || '').trim();
  if (!subId) {
    return res.status(400).json({ error: 'subscriptionId or id is required' });
  }
  const normalizedPlan = String(plan || '').toLowerCase();
  if (!['pro', 'ultimate'].includes(normalizedPlan)) {
    return res.status(400).json({ error: 'plan must be "pro" or "ultimate"' });
  }
  try {
    await keyManager.registerKey(subId, normalizedPlan);
    return res.status(201).json({ message: `Key ${subId} registered` });
  } catch (err) {
    logger.error({ msg: 'Error in POST /keys', error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /keys/:id
 *
 * Deletes a key by subscription ID.  Returns a 200 status even if the key did
 * not previously exist.
 */
router.delete('/keys/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: 'id parameter is required' });
  }
  try {
    await keyManager.deleteKey(id);
    return res.json({ message: `Key ${id} deleted` });
  } catch (err) {
    logger.error({ msg: 'Error in DELETE /keys/:id', error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
