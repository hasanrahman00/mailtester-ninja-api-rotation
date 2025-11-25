const { Queue, Worker, QueueEvents } = require('bullmq');
const { createRedisConnection } = require('./redis');
const keyManager = require('./keyManager');
const logger = require('./logger');

const QUEUE_NAME = 'key-requests';
const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_MAX_WAIT_MS = 0; // 0 = wait indefinitely
const DEFAULT_CONCURRENCY = 5;

const keyQueue = new Queue(QUEUE_NAME, {
  connection: createRedisConnection()
});

const keyQueueEvents = new QueueEvents(QUEUE_NAME, {
  connection: createRedisConnection()
});

keyQueueEvents.on('error', (err) => {
  logger.error({ msg: 'QueueEvents error', error: err.message });
});

keyQueueEvents.waitUntilReady().catch((err) => {
  logger.error({ msg: 'QueueEvents failed to start', error: err.message });
});

const worker = new Worker(
  QUEUE_NAME,
  async () => {
    const backoffMs = Number(process.env.KEY_QUEUE_BACKOFF_MS || DEFAULT_BACKOFF_MS);
    const maxWaitMs = Number(process.env.KEY_QUEUE_MAX_WAIT_MS || DEFAULT_MAX_WAIT_MS);
    const enforceDeadline = Number.isFinite(maxWaitMs) && maxWaitMs > 0;
    const deadline = enforceDeadline ? Date.now() + maxWaitMs : Infinity;

    while (Date.now() <= deadline) {
      const key = await keyManager.getAvailableKey();
      if (key) {
        return key;
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }

    throw new Error('QUEUE_TIMEOUT');
  },
  {
    connection: createRedisConnection(),
    concurrency: Number(process.env.KEY_QUEUE_CONCURRENCY || DEFAULT_CONCURRENCY)
  }
);

worker.on('error', (err) => {
  logger.error({ msg: 'BullMQ worker error', error: err.message });
});

worker.on('failed', (job, err) => {
  logger.warn({ msg: 'Key queue job failed', jobId: job?.id, error: err.message });
});

async function shutdownKeyQueue() {
  try {
    await worker.close();
  } catch (err) {
    logger.error({ msg: 'Error closing worker', error: err.message });
  }
  try {
    await keyQueue.close();
  } catch (err) {
    logger.error({ msg: 'Error closing queue', error: err.message });
  }
  try {
    await keyQueueEvents.close();
  } catch (err) {
    logger.error({ msg: 'Error closing queue events', error: err.message });
  }
}

module.exports = {
  keyQueue,
  keyQueueEvents,
  shutdownKeyQueue
};
