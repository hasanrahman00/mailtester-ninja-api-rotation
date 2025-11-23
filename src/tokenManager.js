const axios = require('axios');
const logger = require('./logger');
const mongoClient = require('./mongoClient');

async function fetchAndStoreToken(subscriptionId) {
  if (!subscriptionId) {
    throw new Error('subscriptionId is required for token generation');
  }

  await mongoClient.connectMongo();
  const collection = mongoClient.getKeysCollection();
  const url = `https://token.mailtester.ninja/token?key=${encodeURIComponent(subscriptionId)}`;

  try {
    const response = await axios.get(url, { timeout: 10000 });
    if (response.status === 200 && response.data && response.data.token) {
      const token = String(response.data.token);
      await collection.updateOne(
        { subscriptionId },
        { $set: { token, lastRefresh: Date.now(), status: 'active' } }
      );
      logger.info({ msg: 'Fetched token from MailTester', subscriptionId });
      return token;
    }

    logger.warn({
      msg: 'Unexpected token response from MailTester',
      subscriptionId,
      status: response.status
    });
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401 || status === 403) {
      await collection.updateOne(
        { subscriptionId },
        { $set: { status: 'banned', lastRefresh: Date.now() } }
      );
      logger.warn({ msg: 'Token generation banned key', subscriptionId, status });
    } else {
      logger.error({ msg: 'Token generation error', subscriptionId, error: err.message });
    }
  }

  return null;
}

module.exports = { fetchAndStoreToken };
