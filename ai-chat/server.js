const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || '.';

// ----- Configuration (variables d'environnement) -----
const SITE_NAME = process.env.SITE_NAME || 'Mon IA';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  "Tu es un assistant amical et serviable qui répond en français de façon claire et concise.";

const FREE_LIMIT = parseInt(process.env.PLAN_FREE_LIMIT || '30', 10);   // messages / mois (gratuit)
const PRO_LIMIT  = parseInt(process.env.PLAN_PRO_LIMIT  || '1000', 10); // messages / mois (pro)
const PRO_LABEL  = process.env.PRO_PRICE_LABEL || '5 €/mois';

// Stripe (optionnel : sans ça, le site marche en "gratuit seulement")
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_ENABLED = !!(STRIPE_SECRET && STRIPE_PRICE_ID);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', true);

// IMPORTANT : le webhook Stripe a besoin du corps brut -> avant express.json()
app.post('/billing/webhook', express.raw({ type: 'application/json' }), handleWebhook);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));
app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: DATA_DIR }),
  secret: process.env.SESSION_SECRET || 'change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }
}));

// Variables dispo dans toutes les vues
app.use((req, res, next) => {
  res.locals.siteName = SITE_NAME;
  res.locals.me = req.session.userId
    ? db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)
    : null;
  res.locals.proLabel = PRO_LABEL;
  res.locals.freeLimit = FREE_LIMIT;
  res.locals.proLimit = PRO_LIMIT;
  res.locals.stripeEnabled = STRIPE_ENABLED;
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

// ----- Quota -----
const MONTH = 30 * 24 * 3600 * 1000;
function ensurePeriod(u) {
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
  res.redirect('/chat');
});

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/chat');
  res.render('login', { error: null, email: '' });
});
app.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim();
  const password = req.body.password || '';
  const u = db.prepare('SELECT * FROM users WHERE email_lower = ?').get(email.toLowerCase());
  if (!u || !(await bcrypt.compare(password, u.password))) return res.render('login', { error: "E-mail ou mot de passe incorrect.", email });
  req.session.userId = u.id;
  res.redirect('/chat');
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

  // Construit le contexte : derniers messages + le nouveau
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

// Réinitialiser la conversation
app.post('/api/clear', requireAuth, (req, res) => {
  db.prepare('DELETE FROM messages WHERE user_id = ?').run(req.session.userId);
  res.json({ ok: true });
});

// ===================== STRIPE (abonnement) =====================
app.post('/billing/checkout', requireAuth, async (req, res) => {
  if (!STRIPE_ENABLED) return res.redirect('/account');
  const u = res.locals.me;
  const origin = (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
  const body = new URLSearchParams();
  body.append('mode', 'subscription');
  body.append('line_items[0][price]', STRIPE_PRICE_ID);
  body.append('line_items[0][quantity]', '1');
  body.append('success_url', origin + '/billing/success');
  body.append('cancel_url', origin + '/account');
  body.append('client_reference_id', String(u.id));
  body.append('customer_email', u.email);
  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + STRIPE_SECRET, 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const j = await r.json();
    if (j.url) return res.redirect(j.url);
    console.error('Stripe checkout error', j);
    res.redirect('/account');
  } catch (e) { console.error(e); res.redirect('/account'); }
});

app.get('/billing/success', requireAuth, (req, res) => res.render('success'));

function handleWebhook(req, res) {
  if (!STRIPE_WEBHOOK_SECRET) return res.status(200).end();
  const sig = req.headers['stripe-signature'] || '';
  const raw = req.body; // Buffer (express.raw)
  try {
    const parts = Object.fromEntries(sig.split(',').map(kv => kv.split('=')));
    const signed = parts.t + '.' + raw.toString('utf8');
    const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(signed, 'utf8').digest('hex');
    if (!parts.v1 || parts.v1.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(parts.v1), Buffer.from(expected))) {
      return res.status(400).send('bad signature');
    }
    const event = JSON.parse(raw.toString('utf8'));
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const uid = parseInt(s.client_reference_id, 10);
      if (uid) db.prepare('UPDATE users SET plan = ?, stripe_customer = ?, msg_used = 0, period_start = ? WHERE id = ?')
        .run('pro', s.customer || '', Date.now(), uid);
    } else if (event.type === 'customer.subscription.deleted') {
      const cust = event.data.object.customer;
      if (cust) db.prepare("UPDATE users SET plan = 'free' WHERE stripe_customer = ?").run(cust);
    }
    res.status(200).json({ received: true });
  } catch (e) { console.error('webhook', e); res.status(400).send('error'); }
}

app.use((req, res) => res.status(404).render('404'));
app.listen(PORT, () => console.log(`✅ ${SITE_NAME} en ligne sur le port ${PORT}`));
