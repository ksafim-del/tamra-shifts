'use strict';
// Entry point for Render's weekly Cron Job. Runs as a one-off process against
// the SAME database as the web service (via DATABASE_URL) and generates next
// week's schedule if it doesn't already exist — completely independent of any
// browser or Claude session, which is the whole point: it just works, every
// Thursday, forever.
const path = require('node:path');
const { makeStore, initSchema } = require('../lib/store.js');
const actions = require('../lib/actions.js');
const S = require('../lib/schedule.js');

async function main() {
  let db;
  if (process.env.DATABASE_URL) {
    const { makePgAdapter } = require('../lib/db-pg.js');
    db = makePgAdapter(process.env.DATABASE_URL);
  } else {
    const { makeSqliteAdapter } = require('../lib/db-sqlite.js');
    db = makeSqliteAdapter(path.join(__dirname, '..', 'data', 'tamra.db'));
  }
  await initSchema(db);
  const store = makeStore(db);
  const weekStart = S.nextGenerationWeek();
  const result = await actions.generateWeek(store, weekStart);
  console.log('[cron] generate-week', weekStart, result.skipped ? 'skipped (already generated)' : 'generated, understaffed=' + result.week.understaffed.length);
  await db.close();
}

main().catch((err) => { console.error('[cron] failed:', err); process.exit(1); });
