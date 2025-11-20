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
const logger = require('../src/logger');

const router = express.Router();

/**
 * GET /key/available
 *
 * Returns an available MailTester key within rate limits.  If no key is
 * currently available the client receives an HTTP 429 response with a JSON
 * body instructing it to wait a short while before retrying.
 */
router.get('/key/available', async (req, res) => {
  try {
    const key = await keyManager.getAvailableKey();
    if (!key) {
      // no key available
      return res.status(429).json({ status: 'wait', retryIn: 3000, message: 'All keys busy' });
    }
    return res.json(key);
  } catch (err) {
    logger.error({ msg: 'Error in /key/available', error: err.message });
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
