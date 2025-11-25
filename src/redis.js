const IORedis = require('ioredis');

function buildRedisOptions() {
  if (process.env.REDIS_URL) {
    return process.env.REDIS_URL;
  }
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined
  };
}

function createRedisConnection() {
  const options = buildRedisOptions();
  return new IORedis(options, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false
  });
}

module.exports = {
  createRedisConnection
};
