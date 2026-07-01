const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const path = require('path');
const { db, DATA_DIR } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ----- Configuration (variables d'environnement) -----
const SITE_NAME = process.env.SITE_NAME || 'Mon IA';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  "Tu es un assistant amical et serviable qui répond en français de façon claire et concise.";

const FREE_LIMIT = parseInt(process.env.PLAN_FREE_LIMIT || '30', 10);   // messages / mois (gratuit)
const PRO_LIMIT  = parseInt(process.env.PLAN_PRO_LIMIT  || '1000', 10); // messages / mois (pro)

// Pro via Discord (plus de paiement par carte)
const DISCORD_HANDLE = process.env.DISCORD_HANDLE || '@lvtm';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use(session({
  name: 'aichat.sid',
  store: new SQLiteStore({ db: 'sessions_ai.db', dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }
}));

// Variables dispo dans toutes les vues
app.use((req, res, next) => {
  try {
    const me = req.session.userId
      ? db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)
      : null;
    res.locals.me = me;
    res.locals.isAdmin = !!(me && ADMIN_EMAIL && me.email_lower === ADMIN_EMAIL);
  } catch (e) {
    console.error('LOCALS ERROR:', e);
    res.locals.me = null;
    res.locals.isAdmin = false;
  }
  res.locals.siteName = SITE_NAME;
  res.locals.freeLimit = FREE_LIMIT;
  res.locals.proLimit = PRO_LIMIT;
  res.locals.discordHandle = DISCORD_HANDLE;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  if (!res.locals.me) { // session périmée (ex: vieux cookie) -> on nettoie
    return req.session.destroy(() => res.redirect('/login'));
  }
  next();
}
function requireAdmin(req, res, next) {
  if (!res.locals.isAdmin) return res.status(403).send('Accès refusé');
  next();
}

// ----- Quota -----
const MONTH = 30 * 24 * 3600 * 1000;
function ensurePeriod(u) {
  if (!u) return;
  const now = Date.now();
  if (!u.period_start || now - u.period_start >= MONTH) {
    db.prepare('UPDATE users SET msg_used = 0, period_start = ? WHERE id = ?').run(now, u.id);
    u.msg_used = 0; u.period_start = now;
  }
}
function limitFor(plan) { return plan === 'pro' ? PRO_LIMIT : FREE_LIMIT; }

// ===================== PAGES =====================
app.get('/', (req, res) => res.render('landing'));

app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/chat');
  res.render('register', { error: null, email: '' });
});
app.post('/register', async (req, res) => {
  try {
    const email = (req.body.email || '').trim();
    const password = req.body.password || '';
    const el = email.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.render('register', { error: "E-mail invalide.", email });
    if (password.length < 6) return res.render('register', { error: "Mot de passe : 6 caractères minimum.", email });
    if (db.prepare('SELECT 1 FROM users WHERE email_lower = ?').get(el)) return res.render('register', { error: "Cet e-mail est déjà utilisé.", email });
    const hash = await bcrypt.hash(password, 10);
    const info = db.prepare('INSERT INTO users (email, email_lower, password, created_at, period_start) VALUES (?,?,?,?,?)')
      .run(email, el, hash, Date.now(), Date.now());
    req.session.userId = info.lastInsertRowid;
    req.session.save(() => res.redirect('/chat'));
  } catch (e) {
    console.error('REGISTER ERROR:', e);
    res.render('register', { error: "Erreur serveur, réessaie dans un instant.", email: req.body.email || '' });
  }
});

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/chat');
  res.render('login', { error: null, email: '' });
});
app.post('/login', async (req, res) => {
  try {
    const email = (req.body.email || '').trim();
    const password = req.body.password || '';
    const u = db.prepare('SELECT * FROM users WHERE email_lower = ?').get(email.toLowerCase());
    if (!u || !(await bcrypt.compare(password, u.password))) return res.render('login', { error: "E-mail ou mot de passe incorrect.", email });
    req.session.userId = u.id;
    req.session.save(() => res.redirect('/chat'));
  } catch (e) {
    console.error('LOGIN ERROR:', e);
    res.render('login', { error: "Erreur serveur, réessaie dans un instant.", email: req.body.email || '' });
  }
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/chat', requireAuth, (req, res) => {
  const u = res.locals.me;
  ensurePeriod(u);
  const history = db.prepare('SELECT role, content FROM messages WHERE user_id = ? ORDER BY id ASC LIMIT 200').all(u.id);
  res.render('chat', { history, used: u.msg_used, limit: limitFor(u.plan) });
});

app.get('/account', requireAuth, (req, res) => {
  const u = res.locals.me;
  ensurePeriod(u);
  res.render('account', { used: u.msg_used, limit: limitFor(u.plan), plan: u.plan });
});

// ===================== API CHAT =====================
app.post('/api/chat', requireAuth, async (req, res) => {
  const u = res.locals.me;
  ensurePeriod(u);
  const limit = limitFor(u.plan);
  if (u.msg_used >= limit) {
    return res.status(402).json({ error: 'quota', message: "Tu as atteint ta limite de messages ce mois-ci." });
  }
  const text = (req.body.message || '').toString().slice(0, 4000).trim();
  if (!text) return res.status(400).json({ error: 'empty' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'config', message: "L'IA n'est pas configurée (clé API manquante)." });

  const past = db.prepare('SELECT role, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(u.id).reverse();
  const messages = past.map(m => ({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: text });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM_PROMPT, messages })
    });
    if (!r.ok) {
      const errTxt = await r.text();
      console.error('Anthropic error', r.status, errTxt);
      return res.status(502).json({ error: 'ai', message: "L'IA n'a pas pu répondre, réessaie." });
    }
    const data = await r.json();
    const reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || '…';

    const now = Date.now();
    db.prepare('INSERT INTO messages (user_id, role, content, created_at) VALUES (?,?,?,?)').run(u.id, 'user', text, now);
    db.prepare('INSERT INTO messages (user_id, role, content, created_at) VALUES (?,?,?,?)').run(u.id, 'assistant', reply, now + 1);
    db.prepare('UPDATE users SET msg_used = msg_used + 1 WHERE id = ?').run(u.id);

    res.json({ reply, used: u.msg_used + 1, limit });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'ai', message: "Erreur de connexion à l'IA." });
  }
});

app.post('/api/clear', requireAuth, (req, res) => {
  db.prepare('DELETE FROM messages WHERE user_id = ?').run(req.session.userId);
  res.json({ ok: true });
});

// ===================== ADMIN (gérer le Pro à la main) =====================
app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, email, plan, msg_used, created_at FROM users ORDER BY id DESC').all();
  res.render('admin', { users, proLimit: PRO_LIMIT, freeLimit: FREE_LIMIT });
});
app.post('/admin/setplan', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.body.userId, 10);
  const plan = req.body.plan === 'pro' ? 'pro' : 'free';
  if (id) db.prepare('UPDATE users SET plan = ?, msg_used = 0, period_start = ? WHERE id = ?').run(plan, Date.now(), id);
  res.redirect('/admin');
});

// ===================== DIAGNOSTIC =====================
app.get('/health', (req, res) => {
  const info = { ok: true, dataDir: DATA_DIR, node: process.version, hasApiKey: !!ANTHROPIC_API_KEY };
  try {
    db.prepare('CREATE TABLE IF NOT EXISTS _health (x INTEGER)').run();
    db.prepare('INSERT INTO _health (x) VALUES (1)').run();
    db.prepare('DELETE FROM _health').run();
    info.dbWrite = 'OK';
    info.users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  } catch (e) { info.ok = false; info.dbWrite = 'ERREUR: ' + e.message; }
  res.json(info);
});

app.use((req, res) => res.status(404).render('404'));

// Gestionnaire d'erreurs : AFFICHE l'erreur (pour diagnostic)
app.use((err, req, res, next) => {
  console.error('ERREUR SERVEUR:', err);
  res.status(500).type('html').send(
    '<div style="font-family:monospace;background:#0a0a0f;color:#fca5a5;padding:24px;min-height:100vh">' +
    '<h2 style="color:#fff">⚠️ Erreur serveur</h2>' +
    '<p style="color:#9a9aa8">Fais une capture de ce message et envoie-la.</p>' +
    '<pre style="white-space:pre-wrap;background:#14141b;border:1px solid #23232e;padding:16px;border-radius:10px">' +
    String(err && (err.stack || err.message || err)).replace(/[<>]/g, '') +
    '</pre></div>'
  );
});
app.listen(PORT, () => console.log(`✅ ${SITE_NAME} en ligne sur le port ${PORT} (data: ${DATA_DIR})`));
