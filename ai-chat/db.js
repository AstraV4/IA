const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '.';
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  email_lower TEXT UNIQUE,
  password TEXT,
  created_at INTEGER,
  plan TEXT DEFAULT 'free',
  msg_used INTEGER DEFAULT 0,
  period_start INTEGER DEFAULT 0,
  stripe_customer TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  role TEXT,
  content TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msg_user ON messages(user_id, id);
`);

module.exports = db;
