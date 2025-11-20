/**
 * keyManager.js
 *
 * This module encapsulates all business logic related to MailTester
 * subscription keys.  It exposes functions to initialise keys from the
 * environment (or a JSON file), register new keys, delete keys, retrieve
 * status for all keys, select an available key respecting rate limits and
 * daily quotas, and refresh authentication tokens.
 *
 * The key data model is stored in Redis using a hash per subscription ID
 * under the pattern `mailtester:key:{subscriptionId}`.  Additional helper
 * fields (e.g. rate limits and counters) live alongside the plan and token.
 *
 * Environment-driven initialisation supports multiple formats:
 *
 *   - MAILTESTER_KEYS_JSON: a JSON array of objects { id, plan }
 *   - MAILTESTER_KEYS_WITH_PLAN: comma-separated list of `id:plan` pairs
 *   - MAILTESTER_KEYS: comma-separated list of IDs with a single default plan
 *   - MAILTESTER_KEYS_JSON_PATH: file path to a JSON file containing the
 *       array described above
 *
 * When multiple formats are provided the precedence order is:
 * JSON (either inline or file) -> CSV mapping -> plain list.
 */
const axios = require('axios');
const redis = require('./redisClient');
const logger = require('./logger');
const fs = require('fs');
const path = require('path');

// Internal helper: compute rate limits based on plan
function getRateLimits(plan) {
  const normalized = String(plan || '').toLowerCase();
  if (normalized === 'pro') {
    const rateLimit30s = 35;
    const dailyLimit = 100000;
    const avgRequestIntervalMs = Math.floor((30 * 1000) / rateLimit30s);
    return { rateLimit30s, dailyLimit, avgRequestIntervalMs };
  }
  // default to ultimate
  const rateLimit30s = 170;
  const dailyLimit = 500000;
  const avgRequestIntervalMs = Math.floor((30 * 1000) / rateLimit30s);
  return { rateLimit30s, dailyLimit, avgRequestIntervalMs };
}

/**
 * Initialise keys defined in the MAILTESTER_KEYS environment variable.  If
 * subscription IDs are supplied they are inserted into Redis with a default
 * plan of "ultimate".  Existing keys are left untouched.  This helper is
 * typically called once on server startup.
 */
async function initializeKeysFromEnv() {
  // Optionally load keys from an external JSON file.  If
  // MAILTESTER_KEYS_JSON_PATH is defined, the file at that path should
  // contain a JSON array of objects with the shape { id: string, plan: string }.
  // Example keys.json:
  //   [
  //     { "id": "sub_abc123", "plan": "ultimate" },
  //     { "id": "sub_def456", "plan": "pro" }
  //   ]
  const jsonPath = process.env.MAILTESTER_KEYS_JSON_PATH;
  if (jsonPath) {
    try {
      const filePath = path.resolve(process.cwd(), jsonPath);
      const fileContents = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(fileContents);
      if (Array.isArray(parsed)) {
        const jsonEnv = JSON.stringify(parsed);
        // Set MAILTESTER_KEYS_JSON env variable so the JSON logic below handles it
        process.env.MAILTESTER_KEYS_JSON = jsonEnv;
      } else {
        logger.warn({ msg: 'MAILTESTER_KEYS_JSON_PATH file does not contain an array', path: filePath });
      }
    } catch (err) {
      logger.error({ msg: 'Failed to read MAILTESTER_KEYS_JSON_PATH', path: jsonPath, error: err.message });
    }
  }
  // Support three ways of loading keys and plans from the environment, in order
  // of precedence:
  // 1. MAILTESTER_KEYS_JSON: JSON array of { id, plan }
  //    Example: '[{"id":"sub_aaa","plan":"pro"},{"id":"sub_bbb","plan":"ultimate"}]'
  // 2. MAILTESTER_KEYS_WITH_PLAN: comma-separated list of id:plan pairs
  //    Example: 'sub_aaa:ultimate,sub_bbb:pro'
  // 3. MAILTESTER_KEYS: comma-separated list of IDs, using MAILTESTER_DEFAULT_PLAN for the plan
  const rawJson = process.env.MAILTESTER_KEYS_JSON || '';
  const rawCsvMap = process.env.MAILTESTER_KEYS_WITH_PLAN || '';
  const rawList = process.env.MAILTESTER_KEYS || '';
  const defaultPlan = String(process.env.MAILTESTER_DEFAULT_PLAN || 'ultimate').toLowerCase();

  // normalise plan values
  function normalizePlan(plan) {
    const p = String(plan || '').toLowerCase();
    return p === 'pro' ? 'pro' : 'ultimate';
  }

  // 1) JSON input takes highest priority
  if (rawJson.trim()) {
    try {
      const arr = JSON.parse(rawJson);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          const id = String(item?.id || '').trim();
          if (!id) continue;
          const plan = normalizePlan(item?.plan || defaultPlan);
          try {
            // registerKey handles both new and existing keys; it updates plan and limits
            await registerKey(id, plan);
            logger.info({ msg: 'Preloaded/updated key (JSON)', subscriptionId: id, plan });
          } catch (err) {
            logger.error({ msg: 'Failed to preload key (JSON)', subscriptionId: id, error: err.message });
          }
        }
        return;
      }
    } catch (err) {
      logger.error({ msg: 'Failed to parse MAILTESTER_KEYS_JSON; falling back', error: err.message });
    }
  }

  // 2) CSV map: id:plan,id:plan,...
  if (rawCsvMap.trim()) {
    const entries = rawCsvMap.split(',').map((pair) => pair.trim()).filter(Boolean);
    for (const entry of entries) {
      const [idRaw, planRaw] = entry.split(':');
      const id = String(idRaw || '').trim();
      if (!id) continue;
      const plan = normalizePlan(planRaw || defaultPlan);
      try {
        await registerKey(id, plan);
        logger.info({ msg: 'Preloaded/updated key (CSV)', subscriptionId: id, plan });
      } catch (err) {
        logger.error({ msg: 'Failed to preload key (CSV)', subscriptionId: id, error: err.message });
      }
    }
    return;
  }

  // 3) Plain list + default plan
  if (rawList.trim()) {
    const ids = rawList.split(',').map((id) => id.trim()).filter(Boolean);
    for (const id of ids) {
      try {
        await registerKey(id, defaultPlan);
        logger.info({ msg: 'Preloaded/updated key', subscriptionId: id, plan: defaultPlan });
      } catch (err) {
        logger.error({ msg: 'Failed to preload key', subscriptionId: id, error: err.message });
      }
    }
  }
}

/**
 * Register or update a key in Redis.  When registering a new key the
 * appropriate rate limits are computed from the plan.  Updating an existing
 * key will adjust its plan and limits without resetting usage counters.
 *
 * @param {string} subscriptionId The MailTester subscription ID
 * @param {string} plan Either "pro" or "ultimate"
 */
async function registerKey(subscriptionId, plan) {
  if (!subscriptionId) {
    throw new Error('subscriptionId is required');
  }
  const limits = getRateLimits(plan);
  const key = `mailtester:key:${subscriptionId}`;
  const now = Date.now();
  const exists = await redis.client.exists(key);
  if (!exists) {
    // brand new key
    const data = {
      plan: plan.toLowerCase(),
      token: '',
      lastRefresh: now,
      usedInWindow: 0,
      windowStart: now,
      usedDaily: 0,
      dayStart: now,
      status: 'active',
      rateLimit30s: limits.rateLimit30s,
      dailyLimit: limits.dailyLimit,
      avgRequestIntervalMs: limits.avgRequestIntervalMs,
      lastUsed: 0
    };
    await redis.client.hSet(key, data);
    await redis.client.sAdd('mailtester:keys', subscriptionId);
    logger.info({ msg: 'Registered new key', subscriptionId, plan: data.plan });
  } else {
    // update plan and limits but keep counters
    const updates = {
      plan: plan.toLowerCase(),
      rateLimit30s: limits.rateLimit30s,
      dailyLimit: limits.dailyLimit,
      avgRequestIntervalMs: limits.avgRequestIntervalMs
    };
    await redis.client.hSet(key, updates);
    logger.info({ msg: 'Updated existing key', subscriptionId, plan: updates.plan });
  }
}

/**
 * Delete a key and remove it from the set.  Nonexistent keys are ignored.
 *
 * @param {string} subscriptionId 
 */
async function deleteKey(subscriptionId) {
  const key = `mailtester:key:${subscriptionId}`;
  await redis.client.del(key);
  await redis.client.sRem('mailtester:keys', subscriptionId);
  logger.info({ msg: 'Deleted key', subscriptionId });
}

/**
 * Retrieve status objects for all known keys.
 *
 * Each object includes the subscriptionId and the contents of the Redis hash.
 */
async function getAllKeysStatus() {
  const ids = await redis.client.sMembers('mailtester:keys');
  const result = [];
  for (const id of ids) {
    const data = await redis.client.hGetAll(`mailtester:key:${id}`);
    if (!data || Object.keys(data).length === 0) {
      continue;
    }
    const parsed = {};
    for (const [field, value] of Object.entries(data)) {
      // Convert numeric fields to numbers when possible
      if (['usedInWindow', 'windowStart', 'usedDaily', 'dayStart', 'rateLimit30s', 'dailyLimit', 'avgRequestIntervalMs', 'lastRefresh', 'lastUsed'].includes(field)) {
        parsed[field] = Number(value);
      } else {
        parsed[field] = value;
      }
    }
    result.push({ subscriptionId: id, ...parsed });
  }
  return result;
}

/**
 * Determine the next available key.  Keys that are banned or exhausted or
 * outside their 30-second window are ignored.  The candidate with the lowest
 * `usedInWindow` counter is selected.  The selected key's counters are
 * incremented atomically using Redis transactions to mitigate race conditions.
 *
 * @returns {Promise<null|{subscriptionId: string, token: string, plan: string}>}
 */
async function getAvailableKey() {
  const ids = await redis.client.sMembers('mailtester:keys');
  const candidates = [];
  for (const id of ids) {
    const key = `mailtester:key:${id}`;
    const data = await redis.client.hGetAll(key);
    if (!data || Object.keys(data).length === 0) {
      continue;
    }
    const status = data.status;
    if (status !== 'active') {
      continue;
    }
    const usedInWindow = Number(data.usedInWindow || '0');
    const windowStart = Number(data.windowStart || '0');
    const usedDaily = Number(data.usedDaily || '0');
    const dayStart = Number(data.dayStart || '0');
    const rateLimit30s = Number(data.rateLimit30s || '0');
    const dailyLimit = Number(data.dailyLimit || '0');
    const now = Date.now();
    // skip if this key's window hasn't reset and it's full
    if (now - windowStart < 30000 && usedInWindow >= rateLimit30s) {
      continue;
    }
    // skip if this key has hit its daily limit
    if (now - dayStart < 86400000 && usedDaily >= dailyLimit) {
      // mark exhausted so future queries skip faster
      await redis.client.hSet(key, 'status', 'exhausted');
      continue;
    }
    candidates.push({ id, usedInWindow, data });
  }
  if (candidates.length === 0) {
    return null;
  }
  // pick candidate with lowest usedInWindow
  candidates.sort((a, b) => a.usedInWindow - b.usedInWindow);
  const chosen = candidates[0];
  const keyName = `mailtester:key:${chosen.id}`;
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Watch the hash for changes
    try {
      await redis.client.watch(keyName);
      const current = await redis.client.hGetAll(keyName);
      if (!current || Object.keys(current).length === 0) {
        await redis.client.unwatch();
        return null;
      }
      const now = Date.now();
      const usedInWindow = Number(current.usedInWindow || '0');
      const windowStart = Number(current.windowStart || '0');
      const usedDaily = Number(current.usedDaily || '0');
      const dayStart = Number(current.dayStart || '0');
      const rateLimit30s = Number(current.rateLimit30s || '0');
      const dailyLimit = Number(current.dailyLimit || '0');
      const status = current.status;
      // ensure still eligible
      if (status !== 'active') {
        await redis.client.unwatch();
        return null;
      }
      if (now - windowStart < 30000 && usedInWindow >= rateLimit30s) {
        await redis.client.unwatch();
        return null;
      }
      if (now - dayStart < 86400000 && usedDaily >= dailyLimit) {
        await redis.client.hSet(keyName, 'status', 'exhausted');
        await redis.client.unwatch();
        return null;
      }
      const multi = redis.client.multi();
      // reset window if expired
      if (now - windowStart >= 30000) {
        multi.hSet(keyName, { usedInWindow: 0, windowStart: now });
      }
      // reset daily if expired
      if (now - dayStart >= 86400000) {
        multi.hSet(keyName, { usedDaily: 0, dayStart: now, status: 'active' });
      }
      multi.hIncrBy(keyName, 'usedInWindow', 1);
      multi.hIncrBy(keyName, 'usedDaily', 1);
      multi.hSet(keyName, 'lastUsed', now);
      const results = await multi.exec();
      if (results === null) {
        // someone changed it; retry
        continue;
      }
      const newUsedDaily = usedDaily + 1;
      if (now - dayStart < 86400000 && newUsedDaily >= dailyLimit) {
        await redis.client.hSet(keyName, 'status', 'exhausted');
      }
      return {
        subscriptionId: chosen.id,
        token: current.token,
        plan: current.plan
      };
    } catch (err) {
      logger.error({ msg: 'Error selecting key', error: err.message });
      await redis.client.unwatch();
      return null;
    }
  }
  return null;
}

/**
 * Refresh a single key's token by calling the MailTester Ninja token endpoint.
 * If the call fails with a 4xx error the key is marked as banned.  On
 * success the `token` and `lastRefresh` fields are updated.
 *
 * @param {string} subscriptionId
 */
async function refreshToken(subscriptionId) {
  const keyName = `mailtester:key:${subscriptionId}`;
  try {
    const url = `https://token.mailtester.ninja/token?key=${encodeURIComponent(subscriptionId)}`;
    const response = await axios.get(url, { timeout: 10000 });
    if (response.status === 200 && response.data && response.data.token) {
      const token = String(response.data.token);
      await redis.client.hSet(keyName, { token, lastRefresh: Date.now() });
      logger.info({ msg: 'Refreshed token', subscriptionId });
      return token;
    }
    logger.warn({ msg: 'Unexpected token refresh response', subscriptionId, status: response.status });
    return null;
  } catch (err) {
    // If the service returns 401/403 the key is invalid or banned
    if (err.response && (err.response.status === 401 || err.response.status === 403)) {
      await redis.client.hSet(keyName, 'status', 'banned');
      logger.warn({ msg: 'Key banned during token refresh', subscriptionId, status: err.response.status });
    } else {
      logger.error({ msg: 'Token refresh error', subscriptionId, error: err.message });
    }
    return null;
  }
}

/**
 * Iterate all keys and refresh tokens as needed.  A token is refreshed when
 * the elapsed time since its last refresh is greater than the configured
 * REFRESH_INTERVAL_HOURS environment variable (defaults to 24h).  This
 * function is called periodically by the scheduler.
 */
async function refreshTokensForAll() {
  const refreshHours = parseInt(process.env.REFRESH_INTERVAL_HOURS || '24', 10);
  const intervalMs = refreshHours * 60 * 60 * 1000;
  const ids = await redis.client.sMembers('mailtester:keys');
  const now = Date.now();
  for (const id of ids) {
    const keyName = `mailtester:key:${id}`;
    const lastRefresh = Number(await redis.client.hGet(keyName, 'lastRefresh') || '0');
    const status = await redis.client.hGet(keyName, 'status');
    if (status === 'banned') {
      continue;
    }
    if (now - lastRefresh >= intervalMs) {
      await refreshToken(id);
    }
  }
}

/**
 * Reset the per-30-second window counter for all keys whose window has
 * elapsed.  This helper is idempotent and safe to call at a fixed interval.
 */
async function resetWindowsForAll() {
  const ids = await redis.client.sMembers('mailtester:keys');
  const now = Date.now();
  for (const id of ids) {
    const keyName = `mailtester:key:${id}`;
    const windowStart = Number(await redis.client.hGet(keyName, 'windowStart') || '0');
    if (now - windowStart >= 30000) {
      await redis.client.hSet(keyName, { usedInWindow: 0, windowStart: now });
    }
  }
}

/**
 * Reset the daily usage counter for all keys that have reached the end of
 * their 24-hour window.  This will also reactivate keys that were previously
 * exhausted.  Banned keys remain banned.
 */
async function resetDailyForAll() {
  const ids = await redis.client.sMembers('mailtester:keys');
  const now = Date.now();
  for (const id of ids) {
    const keyName = `mailtester:key:${id}`;
    const dayStart = Number(await redis.client.hGet(keyName, 'dayStart') || '0');
    const status = await redis.client.hGet(keyName, 'status');
    if (now - dayStart >= 86400000) {
      const updates = { usedDaily: 0, dayStart: now };
      // reactivate exhausted keys
      if (status === 'exhausted') {
        updates.status = 'active';
      }
      await redis.client.hSet(keyName, updates);
    }
  }
}

module.exports = {
  initializeKeysFromEnv,
  registerKey,
  deleteKey,
  getAllKeysStatus,
  getAvailableKey,
  refreshToken,
  refreshTokensForAll,
  resetWindowsForAll,
  resetDailyForAll
};
