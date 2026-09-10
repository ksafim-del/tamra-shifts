'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { makeSqliteAdapter } = require('./lib/db-sqlite.js');
const { initSchema, makeStore } = require('./lib/store.js');
const { createServer } = require('./lib/server.js');

async function main() {
  const isProd = process.env.NODE_ENV === 'production';
  const port = Number(process.env.PORT || 3000);
  const sessionSecret = process.env.SESSION_SECRET || 'dev-secret-change-me-in-production';
  if (isProd && sessionSecret === 'dev-secret-change-me-in-production') {
    console.warn('[WARN] SESSION_SECRET is not set in production — please set it in Render env vars.');
  }
  const cronSecret = process.env.CRON_SECRET || null;

  let db;
  if (process.env.DATABASE_URL) {
    const { makePgAdapter } = require('./lib/db-pg.js');
    db = makePgAdapter(process.env.DATABASE_URL);
    console.log('[db] using Postgres');
  } else {
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    db = makeSqliteAdapter(path.join(dataDir, 'tamra.db'));
    console.log('[db] using local SQLite at', path.join(dataDir, 'tamra.db'));
  }
  await initSchema(db);
  const store = makeStore(db);

  const server = createServer(store, {
    sessionSecret,
    secureCookies: isProd,
    cronSecret,
  });
  server.listen(port, () => {
    console.log('תמרה משמרות — listening on port ' + port);
  });
}

main().catch((err) => { console.error(err); process.exit(1); });
