'use strict';
// SQLite adapter (node:sqlite, built-in, no deps) — used for local dev/testing
// and can also back small production deployments with a persistent disk.
const { DatabaseSync } = require('node:sqlite');

function makeSqliteAdapter(filename) {
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  function toSqliteSql(sql) {
    // store.js writes queries with `?` placeholders already — nothing to convert.
    return sql;
  }

  return {
    dialect: 'sqlite',
    async exec(sql) { db.exec(sql); },
    async run(sql, params) {
      const stmt = db.prepare(toSqliteSql(sql));
      return stmt.run(...(params || []));
    },
    async get(sql, params) {
      const stmt = db.prepare(toSqliteSql(sql));
      return stmt.get(...(params || [])) || null;
    },
    async all(sql, params) {
      const stmt = db.prepare(toSqliteSql(sql));
      return stmt.all(...(params || []));
    },
    async close() { db.close(); },
  };
}

module.exports = { makeSqliteAdapter };
