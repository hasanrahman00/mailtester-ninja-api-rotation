/**
 * scheduler.js
 *
 * Defines periodic maintenance tasks using node-cron.  Three jobs are
 * configured:
 *
 *   1. Every 30 seconds - resets the per-30-second usage counter for
 *      each key when its window has elapsed.  This allows keys to be
 *      reused in subsequent windows and is essential for enforcing rate
 *      limits.
 *
 *   2. Every minute - resets the daily usage counter (and re-activates
 *      keys marked as exhausted) when 24 hours have passed since the
 *      previous reset.  Running this check frequently ensures keys
 *      become available as soon as their daily quota resets.
 *
 *   3. Every hour - initiates a token refresh for each key if its
 *      configured refresh interval (via REFRESH_INTERVAL_HOURS) has
 *      expired.  The actual refresh call is delegated to keyManager.
 *
 * Each scheduled callback is wrapped in a try/catch to log unexpected
 * errors without crashing the scheduler.  Schedulers are started once
 * at service start-up by calling startSchedulers().
 */

const cron = require('node-cron');
const keyManager = require('./keyManager');
const logger = require('./logger');

/**
 * Configure and start periodic cron jobs.  Schedules three jobs:
 *
 * 1. Reset per-30-second counters every 30 seconds.
 * 2. Reset daily counters once per minute (checks elapsed time per key).
 * 3. Refresh tokens once per hour (checks per-key refresh interval).
 */
function startSchedulers() {
  // Reset window counters every 30s
  cron.schedule('*/30 * * * * *', async () => {
    try {
      await keyManager.resetWindowsForAll();
    } catch (err) {
      logger.error({ msg: 'Error in window reset scheduler', error: err.message });
    }
  });

  // Reset daily counters every minute
  cron.schedule('* * * * *', async () => {
    try {
      await keyManager.resetDailyForAll();
    } catch (err) {
      logger.error({ msg: 'Error in daily reset scheduler', error: err.message });
    }
  });

  // Refresh tokens every hour (per-key logic handles refresh interval)
  cron.schedule('0 * * * *', async () => {
    try {
      await keyManager.refreshTokensForAll();
    } catch (err) {
      logger.error({ msg: 'Error in token refresh scheduler', error: err.message });
    }
  });

  logger.info({ msg: 'Cron schedulers started' });
}

module.exports = { startSchedulers };
