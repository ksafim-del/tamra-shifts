'use strict';
const assert = require('node:assert');
const test = require('node:test');
const push = require('./push.js');

// Requiring push.js itself must never touch the real 'web-push' package (it isn't installed in
// this sandbox — same reasoning as mailer.js) — only the real send path does, and that's never
// reached by these tests: isConfigured() gates it, and broadcastToAll's `opts.sendOne` override
// lets us exercise the broadcast/pruning logic below without a real VAPID setup or network call.

function fakeStore(rows) {
  const state = { rows: rows.slice() };
  return {
    async listPushSubscriptions() { return state.rows.slice(); },
    async deletePushSubscription(endpoint) { state.rows = state.rows.filter((r) => r.endpoint !== endpoint); },
    _rows: () => state.rows,
  };
}

function withVapidEnv(fn) {
  const prev = {
    pub: process.env.PUSH_VAPID_PUBLIC_KEY, priv: process.env.PUSH_VAPID_PRIVATE_KEY, sub: process.env.PUSH_VAPID_SUBJECT,
  };
  process.env.PUSH_VAPID_PUBLIC_KEY = 'test-public';
  process.env.PUSH_VAPID_PRIVATE_KEY = 'test-private';
  process.env.PUSH_VAPID_SUBJECT = 'mailto:test@example.com';
  return Promise.resolve(fn()).finally(() => {
    if (prev.pub === undefined) delete process.env.PUSH_VAPID_PUBLIC_KEY; else process.env.PUSH_VAPID_PUBLIC_KEY = prev.pub;
    if (prev.priv === undefined) delete process.env.PUSH_VAPID_PRIVATE_KEY; else process.env.PUSH_VAPID_PRIVATE_KEY = prev.priv;
    if (prev.sub === undefined) delete process.env.PUSH_VAPID_SUBJECT; else process.env.PUSH_VAPID_SUBJECT = prev.sub;
  });
}

test('isConfigured() is false when the VAPID env vars are unset, true once all three are set', () => {
  const prev = { pub: process.env.PUSH_VAPID_PUBLIC_KEY, priv: process.env.PUSH_VAPID_PRIVATE_KEY, sub: process.env.PUSH_VAPID_SUBJECT };
  delete process.env.PUSH_VAPID_PUBLIC_KEY; delete process.env.PUSH_VAPID_PRIVATE_KEY; delete process.env.PUSH_VAPID_SUBJECT;
  assert.strictEqual(push.isConfigured(), false);
  assert.strictEqual(push.getPublicKey(), null);
  process.env.PUSH_VAPID_PUBLIC_KEY = 'a'; process.env.PUSH_VAPID_PRIVATE_KEY = 'b'; process.env.PUSH_VAPID_SUBJECT = 'mailto:x@y.com';
  assert.strictEqual(push.isConfigured(), true);
  assert.strictEqual(push.getPublicKey(), 'a');
  if (prev.pub === undefined) delete process.env.PUSH_VAPID_PUBLIC_KEY; else process.env.PUSH_VAPID_PUBLIC_KEY = prev.pub;
  if (prev.priv === undefined) delete process.env.PUSH_VAPID_PRIVATE_KEY; else process.env.PUSH_VAPID_PRIVATE_KEY = prev.priv;
  if (prev.sub === undefined) delete process.env.PUSH_VAPID_SUBJECT; else process.env.PUSH_VAPID_SUBJECT = prev.sub;
});

test('broadcastToAll is a safe no-op (does not query the store) when VAPID is not configured', async () => {
  const prev = { pub: process.env.PUSH_VAPID_PUBLIC_KEY, priv: process.env.PUSH_VAPID_PRIVATE_KEY, sub: process.env.PUSH_VAPID_SUBJECT };
  delete process.env.PUSH_VAPID_PUBLIC_KEY; delete process.env.PUSH_VAPID_PRIVATE_KEY; delete process.env.PUSH_VAPID_SUBJECT;
  let queried = false;
  const store = { async listPushSubscriptions() { queried = true; return []; } };
  const result = await push.broadcastToAll(store, { title: 't', body: 'b' });
  assert.strictEqual(queried, false, 'must not even look at subscriptions when unconfigured');
  assert.deepStrictEqual(result, { attempted: 0, sent: 0, pruned: 0, reason: 'not_configured' });
  if (prev.pub === undefined) delete process.env.PUSH_VAPID_PUBLIC_KEY; else process.env.PUSH_VAPID_PUBLIC_KEY = prev.pub;
  if (prev.priv === undefined) delete process.env.PUSH_VAPID_PRIVATE_KEY; else process.env.PUSH_VAPID_PRIVATE_KEY = prev.priv;
  if (prev.sub === undefined) delete process.env.PUSH_VAPID_SUBJECT; else process.env.PUSH_VAPID_SUBJECT = prev.sub;
});

test('broadcastToAll sends to every stored subscription and counts successes', () => withVapidEnv(async () => {
  const store = fakeStore([
    { endpoint: 'e1', p256dh: 'p1', auth: 'a1' },
    { endpoint: 'e2', p256dh: 'p2', auth: 'a2' },
    { endpoint: 'e3', p256dh: 'p3', auth: 'a3' },
  ]);
  const sentTo = [];
  const sendOne = async (subscription, payload) => { sentTo.push(subscription.endpoint); assert.deepStrictEqual(payload, { title: 't', body: 'b' }); };
  const result = await push.broadcastToAll(store, { title: 't', body: 'b' }, { sendOne });
  assert.deepStrictEqual(sentTo.sort(), ['e1', 'e2', 'e3']);
  assert.deepStrictEqual(result, { attempted: 3, sent: 3, pruned: 0 });
  assert.strictEqual(store._rows().length, 3, 'nothing pruned on success');
}));

test('broadcastToAll prunes a subscription the push service reports gone (404/410), keeps the rest', () => withVapidEnv(async () => {
  const store = fakeStore([
    { endpoint: 'alive', p256dh: 'p1', auth: 'a1' },
    { endpoint: 'gone-404', p256dh: 'p2', auth: 'a2' },
    { endpoint: 'gone-410', p256dh: 'p3', auth: 'a3' },
  ]);
  const sendOne = async (subscription) => {
    if (subscription.endpoint === 'gone-404') { const e = new Error('not found'); e.statusCode = 404; throw e; }
    if (subscription.endpoint === 'gone-410') { const e = new Error('gone'); e.statusCode = 410; throw e; }
  };
  const result = await push.broadcastToAll(store, { title: 't', body: 'b' }, { sendOne });
  assert.deepStrictEqual(result, { attempted: 3, sent: 1, pruned: 2 });
  assert.deepStrictEqual(store._rows().map((r) => r.endpoint), ['alive'], 'only the still-alive subscription remains');
}));

test('broadcastToAll does not prune on a transient failure (e.g. a 500 from the push service)', () => withVapidEnv(async () => {
  const store = fakeStore([{ endpoint: 'flaky', p256dh: 'p1', auth: 'a1' }]);
  const sendOne = async () => { const e = new Error('server error'); e.statusCode = 500; throw e; };
  const result = await push.broadcastToAll(store, { title: 't', body: 'b' }, { sendOne });
  assert.deepStrictEqual(result, { attempted: 1, sent: 0, pruned: 0 });
  assert.strictEqual(store._rows().length, 1, 'a transient failure must not delete the subscription');
}));

test('broadcastToAll on an empty subscription list is a cheap no-op', () => withVapidEnv(async () => {
  const store = fakeStore([]);
  let sendCalled = false;
  const result = await push.broadcastToAll(store, { title: 't', body: 'b' }, { sendOne: async () => { sendCalled = true; } });
  assert.strictEqual(sendCalled, false);
  assert.deepStrictEqual(result, { attempted: 0, sent: 0, pruned: 0 });
}));
