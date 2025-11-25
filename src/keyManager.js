/**
 * keyManager.js
 *
 * This module encapsulates all business logic related to MailTester
 * subscription keys.  It exposes functions to initialise keys from the
 * environment (or a JSON file), register new keys, delete keys, retrieve
 * status for all keys, and select an available key respecting rate limits and
 * daily quotas.
 *
 * Key metadata is stored in MongoDB (collection: `keys`).  Each document
 * contains the plan, counters, and rate limits for a subscription ID.  All
 * operations funnel through this module to keep the data model consistent.
 */
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const mongoClient = require('./mongoClient');

const WINDOW_MS = 30_000;
const DAY_MS = 86_400_000;

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
 * subscription IDs are supplied they are inserted into MongoDB with a default
 * plan of "ultimate".  Existing keys are left untouched.  This helper is
 * typically called once on server startup.
 */
async function initializeKeysFromEnv() {
  try {
    await removeLegacyTokenFields();
  } catch (err) {
    logger.warn({ msg: 'Failed to remove legacy token fields', error: err.message });
  }
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

async function getKeysCollection() {
  await mongoClient.connectMongo();
  return mongoClient.getKeysCollection();
}

async function removeLegacyTokenFields() {
  const collection = await getKeysCollection();
  await collection.updateMany(
    { $or: [{ token: { $exists: true } }, { lastRefresh: { $exists: true } }] },
    { $unset: { token: '', lastRefresh: '' } }
  );
}

async function registerKey(subscriptionId, plan) {
  if (!subscriptionId) {
    throw new Error('subscriptionId is required');
  }
  const normalizedPlan = String(plan || 'ultimate').toLowerCase();
  const limits = getRateLimits(normalizedPlan);
  const now = Date.now();
  const collection = await getKeysCollection();
  const existing = await collection.findOne({ subscriptionId });
  if (!existing) {
    const doc = {
      subscriptionId,
      plan: normalizedPlan,
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
    await collection.insertOne(doc);
    logger.info({ msg: 'Registered new key', subscriptionId, plan: doc.plan });
  } else {
    const updates = {
      plan: normalizedPlan,
      rateLimit30s: limits.rateLimit30s,
      dailyLimit: limits.dailyLimit,
      avgRequestIntervalMs: limits.avgRequestIntervalMs
    };
    await collection.updateOne(
      { subscriptionId },
      { $set: updates, $unset: { token: '', lastRefresh: '' } }
    );
    logger.info({ msg: 'Updated existing key', subscriptionId, plan: updates.plan });
  }
}

/**
 * Delete a key and remove it from the set.  Nonexistent keys are ignored.
 *
 * @param {string} subscriptionId 
 */
async function deleteKey(subscriptionId) {
  const collection = await getKeysCollection();
  await collection.deleteOne({ subscriptionId });
  logger.info({ msg: 'Deleted key', subscriptionId });
}

/**
 * Retrieve status objects for all known keys.
 *
 * Each object includes the subscriptionId and the stored metadata.
 */
async function getAllKeysStatus() {
  const collection = await getKeysCollection();
  const docs = await collection.find().toArray();
  return docs.map(({ _id, token, lastRefresh, ...rest }) => rest);
}

/**
 * Determine the next available key.  Keys that are banned or exhausted or
 * outside their 30-second window are ignored.  The candidate with the lowest
 * `usedInWindow` counter is selected.  The selected key's counters are
 * incremented atomically using MongoDB compare-and-set semantics to mitigate race conditions.
 *
 * @returns {Promise<null|{subscriptionId: string, plan: string}>}
 */
async function getAvailableKey() {
  const collection = await getKeysCollection();
  const maxAttempts = 3;
  for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex += 1) {
    const docs = await collection.find().toArray();
    if (!docs.length) {
      return null;
    }

    const now = Date.now();
    const candidates = [];
    for (const doc of docs) {
      if (doc.status !== 'active') {
        continue;
      }
      const windowExpired = now - doc.windowStart >= WINDOW_MS;
      const dayExpired = now - doc.dayStart >= DAY_MS;
      const windowCount = windowExpired ? 0 : doc.usedInWindow || 0;
      const dayCount = dayExpired ? 0 : doc.usedDaily || 0;

      if (!dayExpired && dayCount >= doc.dailyLimit) {
        await collection.updateOne({ subscriptionId: doc.subscriptionId }, { $set: { status: 'exhausted' } });
        continue;
      }
      if (!windowExpired && windowCount >= doc.rateLimit30s) {
        continue;
      }

      candidates.push({
        doc,
        windowExpired,
        dayExpired,
        windowCount,
        dayCount
      });
    }

    if (!candidates.length) {
      return null;
    }

    candidates.sort((a, b) => a.windowCount - b.windowCount);

    for (const candidate of candidates) {
      const { doc } = candidate;
      const attemptTime = Date.now();
      const nextWindowStart = candidate.windowExpired ? attemptTime : doc.windowStart;
      const nextDayStart = candidate.dayExpired ? attemptTime : doc.dayStart;
      const newWindowCount = (candidate.windowExpired ? 0 : candidate.windowCount) + 1;
      const newDayCount = (candidate.dayExpired ? 0 : candidate.dayCount) + 1;
      const willExhaust = !candidate.dayExpired && newDayCount >= doc.dailyLimit;

      const filter = {
        subscriptionId: doc.subscriptionId,
        usedInWindow: doc.usedInWindow,
        windowStart: doc.windowStart,
        usedDaily: doc.usedDaily,
        dayStart: doc.dayStart,
        status: doc.status
      };

      const update = {
        $set: {
          usedInWindow: newWindowCount,
          windowStart: nextWindowStart,
          usedDaily: newDayCount,
          dayStart: nextDayStart,
          lastUsed: attemptTime,
          status: willExhaust ? 'exhausted' : 'active'
        }
      };

      const result = await collection.findOneAndUpdate(filter, update, { returnDocument: 'after' });
      const updatedDoc = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
      if (updatedDoc) {
        return {
          subscriptionId: updatedDoc.subscriptionId,
          plan: updatedDoc.plan
        };
      }
    }

    if (attemptIndex < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  return null;
}


/**
 * Reset the per-30-second window counter for all keys whose window has
 * elapsed.  This helper is idempotent and safe to call at a fixed interval.
 */
async function resetWindowsForAll() {
  const collection = await getKeysCollection();
  const now = Date.now();
  const docs = await collection.find().toArray();
  for (const doc of docs) {
    if (now - doc.windowStart >= WINDOW_MS) {
      await collection.updateOne(
        { subscriptionId: doc.subscriptionId },
        { $set: { usedInWindow: 0, windowStart: now } }
      );
    }
  }
}

/**
 * Reset the daily usage counter for all keys that have reached the end of
 * their 24-hour window.  This will also reactivate keys that were previously
 * exhausted.  Banned keys remain banned.
 */
async function resetDailyForAll() {
  const collection = await getKeysCollection();
  const now = Date.now();
  const docs = await collection.find().toArray();
  for (const doc of docs) {
    if (now - doc.dayStart >= DAY_MS) {
      const updates = { usedDaily: 0, dayStart: now };
      if (doc.status === 'exhausted') {
        updates.status = 'active';
      }
      await collection.updateOne({ subscriptionId: doc.subscriptionId }, { $set: updates });
    }
  }
}

module.exports = {
  initializeKeysFromEnv,
  registerKey,
  deleteKey,
  getAllKeysStatus,
  getAvailableKey,
  resetWindowsForAll,
  resetDailyForAll
};
