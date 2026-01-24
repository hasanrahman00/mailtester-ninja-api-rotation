const { test, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');

class InMemoryCollection {
  constructor() {
    this.docs = [];
  }

  reset() {
    this.docs = [];
  }

  clone(doc) {
    return JSON.parse(JSON.stringify(doc));
  }

  matches(doc, filter = {}) {
    return Object.entries(filter).every(([key, value]) => doc[key] === value);
  }

  applyProjection(doc, projection) {
    if (!projection) {
      return doc;
    }
    const projected = {};
    for (const [key, include] of Object.entries(projection)) {
      if (include) {
        projected[key] = doc[key];
      }
    }
    return projected;
  }

  find(query = {}, options = {}) {
    return {
      toArray: async () => this.docs
        .filter((doc) => this.matches(doc, query))
        .map((doc) => this.applyProjection(this.clone(doc), options.projection))
    };
  }

  async findOne(filter = {}) {
    const doc = this.docs.find((item) => this.matches(item, filter));
    return doc ? this.clone(doc) : null;
  }

  async insertOne(doc) {
    this.docs.push(this.clone(doc));
  }

  applySet(doc, fields = {}) {
    for (const [key, value] of Object.entries(fields)) {
      doc[key] = value;
    }
  }

  applyUnset(doc, fields = {}) {
    for (const key of Object.keys(fields)) {
      delete doc[key];
    }
  }

  async updateOne(filter, update) {
    const doc = this.docs.find((item) => this.matches(item, filter));
    if (!doc) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    if (update.$set) {
      this.applySet(doc, update.$set);
    }
    if (update.$unset) {
      this.applyUnset(doc, update.$unset);
    }
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async updateMany(filter, update) {
    let modified = 0;
    for (const doc of this.docs) {
      if (this.matches(doc, filter)) {
        if (update.$set) {
          this.applySet(doc, update.$set);
        }
        if (update.$unset) {
          this.applyUnset(doc, update.$unset);
        }
        modified += 1;
      }
    }
    return { modifiedCount: modified };
  }

  async deleteOne(filter) {
    const index = this.docs.findIndex((doc) => this.matches(doc, filter));
    if (index >= 0) {
      this.docs.splice(index, 1);
    }
  }

  async findOneAndUpdate(filter, update) {
    const doc = this.docs.find((item) => this.matches(item, filter));
    if (!doc) {
      return { value: null };
    }
    if (update.$set) {
      this.applySet(doc, update.$set);
    }
    if (update.$unset) {
      this.applyUnset(doc, update.$unset);
    }
    return { value: this.clone(doc) };
  }
}

const collection = new InMemoryCollection();
const mongoClientStub = {
  async connectMongo() {
    // no-op for in-memory stub
  },
  async disconnectMongo() {
    // no-op
  },
  getKeysCollection() {
    return collection;
  }
};

const mongoClientPath = require.resolve('../src/mongoClient');
delete require.cache[mongoClientPath];
require.cache[mongoClientPath] = {
  id: mongoClientPath,
  filename: mongoClientPath,
  loaded: true,
  exports: mongoClientStub
};

const keyManager = require('../src/keyManager');

before(async () => {
  await mongoClientStub.connectMongo();
});

afterEach(() => {
  collection.reset();
});

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('registerKey stores avg interval and lastUsed metadata', async () => {
  await keyManager.registerKey('sub_pro_test', 'pro');
  const status = await keyManager.getAllKeysStatus();
  assert.equal(status.length, 1);
  const [doc] = status;
  assert.equal(doc.subscriptionId, 'sub_pro_test');
  assert.equal(doc.avgRequestIntervalMs, 860);
  assert.equal(doc.lastUsed, 0);
});

test('getAvailableKey enforces average interval spacing for a single key', async () => {
  await keyManager.registerKey('single_key', 'pro');
  const first = await keyManager.getAvailableKey();
  assert.ok(first, 'should retrieve a key on first request');
  const immediate = await keyManager.getAvailableKey();
  assert.equal(immediate, null, 'should not return the same key before interval elapses');
  await wait(first.avgRequestIntervalMs + 10);
  const second = await keyManager.getAvailableKey();
  assert.ok(second, 'key should be available after waiting');
  assert.equal(second.subscriptionId, first.subscriptionId);
});

test('faster plans become available sooner than slower plans', async () => {
  await keyManager.registerKey('ultimate_fast', 'ultimate');
  await keyManager.registerKey('pro_slow', 'pro');
  const first = await keyManager.getAvailableKey();
  const second = await keyManager.getAvailableKey();
  assert.ok(first && second, 'both keys should be served initially');
  const uniqueIds = new Set([first.subscriptionId, second.subscriptionId].filter(Boolean));
  assert.equal(uniqueIds.size, 2, 'two distinct keys should be issued');
  const ultimateMeta = first.plan === 'ultimate' ? first : second;
  await wait(ultimateMeta.avgRequestIntervalMs + 10);
  const third = await keyManager.getAvailableKey();
  assert.ok(third, 'a key should be available after the ultimate interval');
  assert.equal(third.plan, 'ultimate', 'ultimate plan should recycle sooner than pro');
});
