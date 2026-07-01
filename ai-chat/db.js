const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Choisit un dossier de données VRAIMENT accessible en écriture.
// Si DATA_DIR (ex: /data) n'est pas montable/écrivable, on bascule sur ./data
// pour que le site fonctionne quand même (sans volume = données non persistantes).
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
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  role TEXT,
  content TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msg_user ON messages(user_id, id);
`);

module.exports = { db, DATA_DIR };
