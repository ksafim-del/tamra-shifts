'use strict';
// Postgres adapter — used in production on Render. Requires the 'pg' package,
// which is installed by Render's build step (not available in this sandbox,
// so this file cannot be exercised by the local test suite; keep it minimal
// and close to the well-documented `pg` API to limit risk).
function makeSqlToPositional(sql) {
  // store.js writes all queries with `?` placeholders (SQLite style).
  // Postgres needs $1, $2, ... — convert positionally, left to right.
  let i = 0;
  return sql.replace(/\?/g, () => '$' + (++i));
}

function makePgAdapter(connectionString) {
  const { Pool } = require('pg'); // lazy require: only touched when DATABASE_URL is set
  const pool = new Pool({
    connectionString,
    ssl: connectionString && connectionString.includes('render.com') ? { rejectUnauthorized: false } : undefined,
  });

  return {
    dialect: 'postgres',
    async exec(sql) { await pool.query(sql); },
    async run(sql, params) {
      const res = await pool.query(makeSqlToPositional(sql), params || []);
      return { changes: res.rowCount };
    },
    async get(sql, params) {
      const res = await pool.query(makeSqlToPositional(sql), params || []);
      return res.rows[0] || null;
    },
    async all(sql, params) {
      const res = await pool.query(makeSqlToPositional(sql), params || []);
      return res.rows;
    },
    async close() { await pool.end(); },
  };
}

module.exports = { makePgAdapter };
