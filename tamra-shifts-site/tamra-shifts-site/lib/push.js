'use strict';
// Web Push notifications — broadcasts a short alert to every phone that has enabled
// notifications for the installed app (see public/app.js's push-subscribe flow and
// public/sw.js's 'push' handler). Same "optional, safe no-op if unconfigured" shape as
// mailer.js: if the three PUSH_VAPID_* env vars aren't set, every call here just logs and
// returns instead of touching anything. Uses the 'web-push' package (installed at deploy
// time on Render, same as 'nodemailer'; not available in this sandbox, so the actual send
// path can't be exercised by the local test suite — kept minimal and defensive, and the
// broadcast/pruning logic below is exercised in tests via an injectable `sendOne`).

function isConfigured() {
  return !!(process.env.PUSH_VAPID_PUBLIC_KEY && process.env.PUSH_VAPID_PRIVATE_KEY && process.env.PUSH_VAPID_SUBJECT);
}

// The public key is safe to hand to the browser (it's the "applicationServerKey" for
// PushManager.subscribe) — exposed via /api/bootstrap so the client never needs its own copy.
function getPublicKey() {
  return process.env.PUSH_VAPID_PUBLIC_KEY || null;
}

let vapidConfigured = false;
function webpush() {
  const wp = require('web-push'); // lazy require: only touched when actually sending
  if (!vapidConfigured) {
    wp.setVapidDetails(process.env.PUSH_VAPID_SUBJECT, process.env.PUSH_VAPID_PUBLIC_KEY, process.env.PUSH_VAPID_PRIVATE_KEY);
    vapidConfigured = true;
  }
  return wp;
}

// subscription: { endpoint, keys: { p256dh, auth } } — the shape PushManager.subscribe()
// returns (via .toJSON()) and the shape 'web-push' expects.
async function sendToSubscription(subscription, payload) {
  await webpush().sendNotification(subscription, JSON.stringify(payload));
}

// Sends `payload` (a plain object — public/sw.js's 'push' handler expects
// { title, body, tag?, url? }) to every stored subscription. A subscription the push
// service reports as gone (404/410 — the user uninstalled the app, cleared data, or
// revoked the permission) is deleted so it stops being retried forever. `opts.sendOne`
// lets tests exercise this broadcast/pruning logic without the real 'web-push' package.
async function broadcastToAll(store, payload, opts) {
  opts = opts || {};
  if (!isConfigured()) {
    console.log('[push] VAPID not configured, skipping broadcast:', payload && payload.title);
    return { attempted: 0, sent: 0, pruned: 0, reason: 'not_configured' };
  }
  const send = opts.sendOne || sendToSubscription;
  const rows = await store.listPushSubscriptions();
  if (!rows.length) return { attempted: 0, sent: 0, pruned: 0 };
  let sent = 0, pruned = 0;
  await Promise.all(rows.map(async (row) => {
    const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    try {
      await send(subscription, payload);
      sent++;
    } catch (err) {
      const status = err && (err.statusCode || err.status);
      if (status === 404 || status === 410) {
        await store.deletePushSubscription(row.endpoint);
        pruned++;
      } else {
        console.error('[push] send failed:', err && err.message);
      }
    }
  }));
  return { attempted: rows.length, sent, pruned };
}

module.exports = { isConfigured, getPublicKey, sendToSubscription, broadcastToAll };
