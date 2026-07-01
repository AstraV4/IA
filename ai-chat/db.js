const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

function resolveDataDir() {
  const want = process.env.DATA_DIR || '.';
  try {
    fs.mkdirSync(want, { recursive: true });
    fs.accessSync(want, fs.constants.W_OK);
    return want;
  } catch (e) {
    const fb = path.join(__dirname, 'data');
    try { fs.mkdirSync(fb, { recursive: true }); } catch (_) {}
    console.warn('[ATTENTION] DATA_DIR "' + want + '" inaccessible en écriture -> utilisation de ' + fb +
      ' (pense à monter un Volume sur ' + want + ' pour garder les données).');
    return fb;
  }
}

const DATA_DIR = resolveDataDir();
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
  period_start INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  title TEXT,
  created_at INTEGER,
  updated_at INTEGER
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

// --- Migration : ajouter conversation_id aux anciens messages ---
function hasCol(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
if (!hasCol('messages', 'conversation_id')) {
  db.exec('ALTER TABLE messages ADD COLUMN conversation_id INTEGER');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id)');

// Ranger les anciens messages (sans conversation) dans une conversation par utilisateur
const orphans = db.prepare('SELECT DISTINCT user_id FROM messages WHERE conversation_id IS NULL AND user_id IS NOT NULL').all();
for (const o of orphans) {
  const now = Date.now();
  const info = db.prepare('INSERT INTO conversations (user_id, title, created_at, updated_at) VALUES (?,?,?,?)')
    .run(o.user_id, 'Conversation', now, now);
  db.prepare('UPDATE messages SET conversation_id = ? WHERE user_id = ? AND conversation_id IS NULL')
    .run(info.lastInsertRowid, o.user_id);
}

module.exports = { db, DATA_DIR };
