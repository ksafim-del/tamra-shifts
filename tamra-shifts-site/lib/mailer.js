'use strict';
// Minimal, optional email sender. If SMTP env vars aren't configured, sendMail
// is a safe no-op (logs to console) so the rest of the app never depends on it.
// Uses 'nodemailer' (installed at deploy time on Render; not available in this
// sandbox, so this path cannot be exercised by local tests — kept intentionally
// small and defensive).

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function sendMail({ to, subject, text }) {
  if (!isConfigured()) {
    console.log('[mailer] SMTP not configured, skipping email. Would have sent:', { to, subject });
    return { sent: false, reason: 'not_configured' };
  }
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to, subject, text,
    });
    return { sent: true };
  } catch (err) {
    console.error('[mailer] send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendMail, isConfigured };
