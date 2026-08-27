'use strict';
const crypto = require('node:crypto');

const COOKIE_NAME = 'tamra_session';
const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function sign(payloadObj, secret) {
  const payload = b64url(JSON.stringify(payloadObj));
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verify(token, secret) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig || '');
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let obj;
  try { obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!obj || typeof obj.exp !== 'number' || Date.now() > obj.exp) return null;
  return obj;
}

function makeSessionCookie(session, secret, secure) {
  const token = sign(Object.assign({}, session, { exp: Date.now() + THIRTY_DAYS_MS }), secret);
  const parts = [
    COOKIE_NAME + '=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.floor(THIRTY_DAYS_MS / 1000),
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(secure) {
  const parts = [COOKIE_NAME + '=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(function (part) {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function sessionFromRequest(req, secret) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  return verify(token, secret);
}

module.exports = { COOKIE_NAME, makeSessionCookie, clearSessionCookie, sessionFromRequest, parseCookies, sign, verify };
