const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');

const GEN_DIR = path.join(DATA_DIR, 'generated');
fs.mkdirSync(GEN_DIR, { recursive: true });

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

// E-mail (Resend) — si RESEND_API_KEY est vide, la vérification est désactivée (le site marche comme avant)
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || (SITE_NAME + ' <onboarding@resend.dev>');
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const MAIL_ENABLED = !!RESEND_API_KEY;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '12mb' }));
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
  res.locals.mailEnabled = MAIL_ENABLED;
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

// Vérifie que le domaine de l'e-mail peut recevoir du courrier (enregistrements MX).
// Bloque les fautes de frappe (gmial.com) et les domaines bidons, sans envoyer d'e-mail.
async function emailDomainOk(email) {
  const domain = (email.split('@')[1] || '').toLowerCase().trim();
  if (!domain || domain.indexOf('.') === -1) return false;
  try {
    const mx = await dns.resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch (e) {
    // Domaine inexistant / sans mail -> on refuse. Erreur réseau -> on laisse passer (ne pas bloquer à tort).
    if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) return false;
    return true;
  }
}

// ----- Envoi d'e-mails (Resend) -----
function baseUrl(req) { return APP_URL || (req.protocol + '://' + req.get('host')); }
async function sendMail(to, subject, html) {
  if (!RESEND_API_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html })
    });
    if (!r.ok) { console.error('MAIL error', r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.error('MAIL exception', e); return false; }
}
function mailLayout(title, inner) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;background:#f5f3ec;padding:28px">' +
    '<div style="max-width:460px;margin:auto;background:#fffdf8;border:1px solid #e5e1d5;border-radius:16px;padding:28px">' +
    '<div style="font-size:20px;font-weight:700;color:#24211c">\u2726 ' + SITE_NAME + '</div>' +
    '<h2 style="color:#24211c;font-size:18px;margin:16px 0 10px">' + title + '</h2>' + inner +
    '<p style="color:#8b857a;font-size:12px;margin-top:24px">Si tu n\'es pas \u00e0 l\'origine de cette demande, ignore cet e-mail.</p>' +
    '</div></div>';
}
function mailButton(url, label) {
  return '<a href="' + url + '" style="display:inline-block;background:#c15f3c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;margin:10px 0">' + label + '</a>' +
    '<p style="color:#8b857a;font-size:12px;word-break:break-all">Ou copie ce lien :<br>' + url + '</p>';
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }

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
    if (!(await emailDomainOk(email))) return res.render('register', { error: "Ce domaine e-mail semble ne pas exister. Vérifie l'orthographe (ex : gmail.com).", email });
    if (db.prepare('SELECT 1 FROM users WHERE email_lower = ?').get(el)) return res.render('register', { error: "Cet e-mail est déjà utilisé.", email });
    const hash = await bcrypt.hash(password, 10);
    const now = Date.now();
    if (MAIL_ENABLED) {
      const token = newToken();
      db.prepare('INSERT INTO users (email, email_lower, password, created_at, period_start, verified, verify_token) VALUES (?,?,?,?,?,0,?)')
        .run(email, el, hash, now, now, token);
      const link = baseUrl(req) + '/verify?token=' + token;
      await sendMail(email, 'Confirme ton adresse e-mail',
        mailLayout('Bienvenue \u{1F44B}', '<p style="color:#3c4149;font-size:14px;line-height:1.6">Merci de t\'\u00eatre inscrit \u00e0 ' + SITE_NAME + ' ! Clique sur le bouton pour activer ton compte.</p>' + mailButton(link, 'Confirmer mon adresse')));
      return res.render('verify-sent', { email });
    }
    const info = db.prepare('INSERT INTO users (email, email_lower, password, created_at, period_start, verified) VALUES (?,?,?,?,?,1)')
      .run(email, el, hash, now, now);
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
    if (MAIL_ENABLED && !u.verified) {
      return res.render('login', { error: null, email, notice: "Ton compte n'est pas encore confirmé. Regarde ta boîte mail (et les spams).", resendEmail: email });
    }
    req.session.userId = u.id;
    req.session.save(() => res.redirect('/chat'));
  } catch (e) {
    console.error('LOGIN ERROR:', e);
    res.render('login', { error: "Erreur serveur, réessaie dans un instant.", email: req.body.email || '' });
  }
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
// --- Vérification de l'adresse e-mail ---
app.get('/verify', (req, res) => {
  const token = (req.query.token || '').toString();
  const u = token ? db.prepare('SELECT * FROM users WHERE verify_token = ?').get(token) : null;
  if (!u) return res.render('login', { error: null, email: '', notice: "Lien de confirmation invalide ou déjà utilisé. Essaie de te connecter." });
  db.prepare('UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?').run(u.id);
  req.session.userId = u.id;
  req.session.save(() => res.redirect('/chat'));
});
app.get('/resend-verify', async (req, res) => {
  const email = (req.query.email || '').toString().trim();
  try {
    const u = email ? db.prepare('SELECT * FROM users WHERE email_lower = ?').get(email.toLowerCase()) : null;
    if (u && !u.verified && MAIL_ENABLED) {
      let token = u.verify_token;
      if (!token) { token = newToken(); db.prepare('UPDATE users SET verify_token = ? WHERE id = ?').run(token, u.id); }
      const link = baseUrl(req) + '/verify?token=' + token;
      await sendMail(u.email, 'Confirme ton adresse e-mail',
        mailLayout('Confirme ton compte', '<p style="color:#3c4149;font-size:14px;line-height:1.6">Clique pour activer ton compte ' + SITE_NAME + '.</p>' + mailButton(link, 'Confirmer mon adresse')));
    }
  } catch (e) { console.error('RESEND', e); }
  res.render('verify-sent', { email });
});

// --- Mot de passe oublié (par e-mail) ---
app.get('/forgot', (req, res) => res.render('forgot', { sent: false }));
app.post('/forgot', async (req, res) => {
  const email = (req.body.email || '').trim();
  try {
    const u = email ? db.prepare('SELECT * FROM users WHERE email_lower = ?').get(email.toLowerCase()) : null;
    if (u && MAIL_ENABLED) {
      const token = newToken();
      const exp = Date.now() + 3600 * 1000; // 1 heure
      db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?').run(token, exp, u.id);
      const link = baseUrl(req) + '/reset?token=' + token;
      await sendMail(u.email, 'Réinitialise ton mot de passe',
        mailLayout('Mot de passe oublié', '<p style="color:#3c4149;font-size:14px;line-height:1.6">Clique pour choisir un nouveau mot de passe. Ce lien expire dans 1 heure.</p>' + mailButton(link, 'Choisir un nouveau mot de passe')));
    }
  } catch (e) { console.error('FORGOT', e); }
  res.render('forgot', { sent: true }); // message identique que l'e-mail existe ou non (sécurité)
});
app.get('/reset', (req, res) => {
  const token = (req.query.token || '').toString();
  const u = token ? db.prepare('SELECT id, reset_expires FROM users WHERE reset_token = ?').get(token) : null;
  if (!u || !u.reset_expires || u.reset_expires < Date.now()) return res.render('reset', { token: null, error: "Ce lien est invalide ou expiré. Refais une demande." });
  res.render('reset', { token, error: null });
});
app.post('/reset', async (req, res) => {
  const token = (req.body.token || '').toString();
  const nw = req.body.password || '';
  const u = token ? db.prepare('SELECT * FROM users WHERE reset_token = ?').get(token) : null;
  if (!u || !u.reset_expires || u.reset_expires < Date.now()) return res.render('reset', { token: null, error: "Ce lien est invalide ou expiré. Refais une demande." });
  if (nw.length < 6) return res.render('reset', { token, error: "Mot de passe : 6 caractères minimum." });
  const hash = await bcrypt.hash(nw, 10);
  db.prepare('UPDATE users SET password = ?, reset_token = NULL, reset_expires = NULL, verified = 1 WHERE id = ?').run(hash, u.id);
  res.render('login', { error: null, email: u.email, notice: "Mot de passe modifié ✅ Tu peux maintenant te connecter." });
});

app.get('/chat', requireAuth, (req, res) => {
  const u = res.locals.me;
  ensurePeriod(u);
  const conversations = db.prepare('SELECT id, title, updated_at, pinned FROM conversations WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC').all(u.id);
  let currentId = parseInt(req.query.c, 10) || (conversations[0] && conversations[0].id) || null;
  if (currentId && !conversations.some(c => c.id === currentId)) currentId = conversations[0] ? conversations[0].id : null;
  const history = currentId
    ? db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 500').all(currentId)
    : [];
  res.render('chat', { conversations, currentId, history, used: u.msg_used, limit: limitFor(u.plan) });
});

// --- API conversations ---
app.get('/api/conversations', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id, title, updated_at, pinned FROM conversations WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC').all(req.session.userId));
});
app.get('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const c = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!c) return res.status(404).json({ error: 'notfound' });
  res.json(db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 500').all(c.id));
});
app.post('/api/conversations/:id/rename', requireAuth, (req, res) => {
  const title = (req.body.title || '').toString().trim().slice(0, 60) || 'Conversation';
  const c = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (c) db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(title, c.id);
  res.json({ ok: true, title });
});
app.post('/api/conversations/:id/delete', requireAuth, (req, res) => {
  const c = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (c) {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(c.id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id);
  }
  res.json({ ok: true });
});

app.post('/api/conversations/:id/pin', requireAuth, (req, res) => {
  const c = db.prepare('SELECT id, pinned FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!c) return res.status(404).json({ error: 'notfound' });
  const pinned = c.pinned ? 0 : 1;
  db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(pinned, c.id);
  res.json({ ok: true, pinned });
});

// --- Rubrique Correction (page séparée, n'apparaît PAS dans le chat) ---
app.get('/correction', requireAuth, (req, res) => {
  const u = res.locals.me;
  ensurePeriod(u);
  res.render('correction', { used: u.msg_used, limit: limitFor(u.plan) });
});
app.post('/api/correct', requireAuth, async (req, res) => {
  const u = res.locals.me;
  ensurePeriod(u);
  const limit = limitFor(u.plan);
  if (u.msg_used >= limit) return res.status(402).json({ message: "Tu as atteint ta limite de messages ce mois-ci." });
  const text = (req.body.text || '').toString().slice(0, 8000).trim();
  if (!text) return res.status(400).json({ message: "Écris un texte à corriger." });
  const sys = "Tu es un correcteur de français professionnel. On te donne un texte : tu dois le CORRIGER, pas répondre à son contenu. Corrige l'orthographe, la grammaire, la conjugaison, la ponctuation, la typographie, et améliore la formulation pour que ce soit clair et naturel, SANS changer le sens ni le ton. Réponds en Markdown, exactement dans ce format :\n\n## ✅ Texte corrigé\n\n(le texte entièrement corrigé)\n\n## ✍️ Principales corrections\n\n- (liste courte et simple des fautes ou reformulations ; si tout était déjà correct, écris « Rien à signaler, ton texte était déjà correct 👍 »)";
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 3000, system: sys, messages: [{ role: 'user', content: text }] })
    });
    const data = await r.json();
    if (!r.ok) { console.error('CORRECT API', data); return res.status(500).json({ message: "Erreur de l'IA. Réessaie." }); }
    let reply = '';
    if (Array.isArray(data.content)) reply = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (!reply) reply = "Désolé, je n'ai pas pu corriger ce texte.";
    db.prepare('UPDATE users SET msg_used = msg_used + 1 WHERE id = ?').run(u.id);
    res.json({ reply, used: u.msg_used + 1, limit });
  } catch (e) { console.error('CORRECT', e); res.status(500).json({ message: "Erreur de connexion à l'IA." }); }
});

app.get('/account', requireAuth, (req, res) => {
  const u = res.locals.me;
  ensurePeriod(u);
  res.render('account', { used: u.msg_used, limit: limitFor(u.plan), plan: u.plan, pw: req.query.pw || null });
});

app.post('/account/password', requireAuth, async (req, res) => {
  try {
    const u = res.locals.me;
    const cur = req.body.current || '';
    const nw = req.body.newpw || '';
    if (nw.length < 6) return res.redirect('/account?pw=short');
    if (!(await bcrypt.compare(cur, u.password))) return res.redirect('/account?pw=bad');
    const hash = await bcrypt.hash(nw, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, u.id);
    res.redirect('/account?pw=ok');
  } catch (e) { console.error('PW CHANGE', e); res.redirect('/account?pw=err'); }
});

app.post('/account/delete', requireAuth, (req, res) => {
  const id = req.session.userId;
  db.prepare('DELETE FROM messages WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM conversations WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  req.session.destroy(() => res.redirect('/'));
});

// ===================== API CHAT =====================
// Assombrit une couleur hex (f entre 0 et 1)
function darken(hex, f) {
  const n = parseInt(hex, 16); let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.round(r * (1 - f)); g = Math.round(g * (1 - f)); b = Math.round(b * (1 - f));
  return ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase();
}

// Récupère une photo d'illustration (banque libre Openverse) -> "image/jpeg;base64,..." ou null
async function fetchImage(query) {
  if (!query) return null;
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 6000);
    const r = await fetch('https://api.openverse.org/v1/images/?q=' + encodeURIComponent(query) + '&page_size=5&mature=false', { headers: { 'User-Agent': 'aichat/1.0' }, signal: ctrl.signal });
    clearTimeout(to);
    if (!r.ok) return null;
    const j = await r.json();
    const items = (j.results || []).filter(x => x.url);
    for (const item of items.slice(0, 3)) {
      try {
        const c2 = new AbortController(); const t2 = setTimeout(() => c2.abort(), 6000);
        const ir = await fetch(item.url, { signal: c2.signal });
        clearTimeout(t2);
        if (!ir.ok) continue;
        const ct = (ir.headers.get('content-type') || '').toLowerCase();
        if (!/image\/(jpe?g|png)/.test(ct)) continue;
        const buf = Buffer.from(await ir.arrayBuffer());
        if (buf.length < 1500 || buf.length > 5 * 1024 * 1024) continue;
        const mime = ct.includes('png') ? 'image/png' : 'image/jpeg';
        return mime + ';base64,' + buf.toString('base64');
      } catch (e) { /* image suivante */ }
    }
    return null;
  } catch (e) { return null; }
}

// Construit un .pptx façon "Canva" (2 colonnes, photos, couleur de marque) à partir de la spec
async function buildPptx(spec) {
  const pptxgen = require('pptxgenjs');
  const pres = new pptxgen();
  pres.layout = 'LAYOUT_WIDE';
  const ACC = (spec && typeof spec.accent === 'string' && /^[0-9a-fA-F]{6}$/.test(spec.accent)) ? spec.accent.toUpperCase() : 'C15F3C';
  const ACCD = darken(ACC, 0.30);
  const DARK = '1F2328', BODY = '3C4149', MUT = '9AA0A6', LIGHTBG = 'F5F5F6', PLACE = 'E7E4DE', SOFT = '6B7280';
  const title = (spec && spec.title ? spec.title : 'Présentation').toString();
  const subtitle = (spec && spec.subtitle ? spec.subtitle : '').toString();
  const session = (spec && spec.session ? spec.session : '').toString();
  const presenter = (spec && spec.presenter ? spec.presenter : '').toString();
  const presenterRole = (spec && spec.presenter_role ? spec.presenter_role : '').toString();
  const slides = (spec && Array.isArray(spec.slides)) ? spec.slides : [];
  const shadow = { type: 'outer', blur: 10, offset: 3, angle: 90, color: '000000', opacity: 0.22 };

  // Photos en parallèle
  const [titleImg, slideImgs] = await Promise.all([
    fetchImage(spec && spec.image_query),
    Promise.all(slides.map(sl => fetchImage(sl && sl.image_query)))
  ]);

  // ---------- Slide de titre ----------
  const t = pres.addSlide();
  t.background = { color: ACC };
  t.addShape('rect', { x: 1.2, y: 0.35, w: 10.9, h: 0.1, fill: { color: 'FFFFFF' } });
  t.addShape('rect', { x: 1.2, y: 7.05, w: 10.9, h: 0.1, fill: { color: 'FFFFFF' } });
  if (titleImg) t.addImage({ data: titleImg, x: 7.35, y: 1.0, w: 5.3, h: 5.0, sizing: { type: 'cover', w: 5.3, h: 5.0 }, shadow });
  else { t.addShape('roundRect', { x: 7.35, y: 1.0, w: 5.3, h: 5.0, rectRadius: 0.2, fill: { color: ACCD } }); t.addText('\u2726', { x: 7.35, y: 2.6, w: 5.3, h: 1.2, fontSize: 60, color: 'FFFFFF', align: 'center' }); }
  t.addShape('rect', { x: 0.9, y: 1.7, w: 1.4, h: 0.14, fill: { color: 'FFFFFF' } });
  t.addText(title, { x: 0.9, y: 2.0, w: 6.1, h: 2.2, fontSize: 40, bold: true, color: 'FFFFFF', valign: 'top' });
  if (subtitle) t.addText(subtitle, { x: 0.9, y: 4.35, w: 6.0, h: 1.2, fontSize: 15, color: 'FFFFFF' });
  if (session) t.addText(session.toUpperCase(), { x: 0.9, y: 6.2, w: 6, h: 0.4, fontSize: 12, bold: true, color: 'FFFFFF', charSpacing: 3 });
  if (presenter) { t.addText(presenter, { x: 6.6, y: 6.15, w: 6.0, h: 0.35, fontSize: 15, bold: true, color: 'FFFFFF', align: 'right' }); if (presenterRole) t.addText(presenterRole, { x: 6.6, y: 6.5, w: 6.0, h: 0.3, fontSize: 12, color: 'FFFFFF', align: 'right' }); }

  // ---------- Slides de contenu ----------
  slides.forEach((sl, i) => {
    const img = slideImgs[i];
    const hasImg = !!img;
    const c = pres.addSlide();
    c.background = { color: LIGHTBG };
    const CX = 0.9;
    const CW = hasImg ? 6.2 : 11.4;
    let y = 0.7;

    const label = (sl && sl.label ? sl.label : '').toString();
    if (label) { c.addText(label.toUpperCase(), { x: CX, y, w: CW, h: 0.35, fontSize: 12, bold: true, color: MUT, charSpacing: 2 }); y += 0.48; }
    c.addShape('rect', { x: CX + 0.02, y, w: 0.6, h: 0.09, fill: { color: ACC } }); y += 0.24;
    c.addText((sl && sl.title ? sl.title : '').toString(), { x: CX - 0.02, y, w: CW, h: 0.9, fontSize: 28, bold: true, color: DARK }); y += 0.95;

    const lead = (sl && sl.lead ? sl.lead : '').toString();
    if (lead) { c.addText(lead, { x: CX, y, w: CW, h: 0.5, fontSize: 16, bold: true, color: DARK }); y += 0.58; }
    const subtext = (sl && sl.subtext ? sl.subtext : '').toString();
    if (subtext) { c.addText(subtext, { x: CX, y, w: CW, h: 0.4, fontSize: 13, italic: true, color: SOFT }); y += 0.5; }
    const body = (sl && sl.body ? sl.body : '').toString();
    if (body) { const lines = Math.max(1, Math.ceil(body.length / (hasImg ? 50 : 95))); const h = lines * 0.29 + 0.08; c.addText(body, { x: CX, y, w: CW, h, fontSize: 14, color: BODY, lineSpacingMultiple: 1.15 }); y += h + 0.22; }

    const bullets = (sl && Array.isArray(sl.bullets)) ? sl.bullets : [];
    if (bullets.length) { const arr = bullets.map(b => ({ text: String(b), options: { bullet: { code: '2022', indent: 18 }, fontSize: 15, color: BODY, paraSpaceAfter: 10 } })); const h = bullets.length * 0.44 + 0.1; c.addText(arr, { x: CX + 0.05, y, w: CW - 0.05, h, valign: 'top', lineSpacingMultiple: 1.1 }); y += h + 0.12; }

    const badges = (sl && Array.isArray(sl.badges)) ? sl.badges : [];
    if (badges.length) { badges.forEach(bd => { const bw = 1.55, bh = 0.5; c.addShape('roundRect', { x: CX, y, w: bw, h: bh, rectRadius: 0.06, fill: { color: ACC } }); c.addText((bd && bd.label ? bd.label : '').toString(), { x: CX, y, w: bw, h: bh, align: 'center', valign: 'middle', bold: true, color: 'FFFFFF', fontSize: 13 }); c.addText((bd && bd.text ? bd.text : '').toString(), { x: CX + bw + 0.22, y, w: CW - bw - 0.22, h: bh, valign: 'middle', fontSize: 14, color: BODY }); y += bh + 0.16; }); }

    const stats = (sl && Array.isArray(sl.stats)) ? sl.stats : [];
    if (stats.length) { const n = Math.min(stats.length, 3); const gap = 0.3; const sw = (CW - gap * (n - 1)) / n; stats.slice(0, n).forEach((st, idx) => { const sx = CX + idx * (sw + gap); c.addText((st && st.value ? st.value : '').toString(), { x: sx, y, w: sw, h: 0.7, fontSize: 34, bold: true, color: ACC }); c.addText((st && st.label ? st.label : '').toString(), { x: sx, y: y + 0.74, w: sw, h: 0.6, fontSize: 12, color: BODY }); }); y += 1.5; }

    if (hasImg) c.addImage({ data: img, x: 7.55, y: 1.05, w: 5.05, h: 5.3, sizing: { type: 'cover', w: 5.05, h: 5.3 }, shadow });

    c.addShape('rect', { x: 0.9, y: 7.02, w: 0.18, h: 0.18, fill: { color: ACC } });
    c.addText(title, { x: 1.2, y: 6.98, w: 8, h: 0.3, fontSize: 10, color: MUT });
    c.addText(String(i + 1), { x: 12.3, y: 6.96, w: 0.5, h: 0.3, fontSize: 12, bold: true, color: DARK, align: 'right' });
  });

  const token = crypto.randomBytes(6).toString('hex');
  const fileName = 'presentation-' + token + '.pptx';
  await pres.writeFile({ fileName: path.join(GEN_DIR, fileName) });
  return { title, url: '/download/' + fileName };
}

app.post('/api/chat', requireAuth, async (req, res) => {
  const u = res.locals.me;
  ensurePeriod(u);
  const limit = limitFor(u.plan);
  if (u.msg_used >= limit) {
    return res.status(402).json({ error: 'quota', message: "Tu as atteint ta limite de messages ce mois-ci." });
  }
  const text = (req.body.message || '').toString().slice(0, 8000).trim();
  const mode = (req.body.mode || '').toString();
  const file = req.body.file || null; // { kind:'image'|'pdf'|'text', media_type, data, text, name }
  const IMG = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  let fileKind = null;
  if (file && file.kind === 'image' && IMG.includes(file.media_type) && file.data) fileKind = 'image';
  else if (file && file.kind === 'pdf' && file.data) fileKind = 'pdf';
  else if (file && file.kind === 'text' && typeof file.text === 'string') fileKind = 'text';
  if (!text && !fileKind) return res.status(400).json({ error: 'empty' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'config', message: "L'IA n'est pas configurée (clé API manquante)." });

  // Conversation courante (ou nouvelle si aucune)
  const nowConv = Date.now();
  let convId = parseInt(req.body.conversation_id, 10) || null;
  let conv = convId ? db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(convId, u.id) : null;
  if (!conv) {
    const title = (text || 'Nouvelle conversation').slice(0, 40);
    const info = db.prepare('INSERT INTO conversations (user_id, title, created_at, updated_at) VALUES (?,?,?,?)').run(u.id, title, nowConv, nowConv);
    convId = info.lastInsertRowid; conv = { id: convId, title };
  }

  const past = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 20').all(convId).reverse();
  const messages = past.map(m => ({ role: m.role, content: m.content }));
  const blocks = [];
  let textForAI = text;
  if (fileKind === 'image') {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: file.media_type, data: file.data } });
  } else if (fileKind === 'pdf') {
    blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } });
  } else if (fileKind === 'text') {
    const nm = (file.name || 'fichier').slice(0, 120);
    textForAI = 'Fichier joint "' + nm + '" :\n\n' + file.text.slice(0, 100000) + (text ? '\n\n' + text : '');
  }
  let userContent;
  if (blocks.length) {
    blocks.push({ type: 'text', text: textForAI || "Peux-tu m'aider avec ce fichier ?" });
    userContent = blocks;
  } else {
    userContent = textForAI;
  }
  messages.push({ role: 'user', content: userContent });

  const tools = [{
    name: 'create_presentation',
    description: "Génère un vrai fichier PowerPoint (.pptx) au design professionnel façon Canva. Utilise cet outil UNIQUEMENT quand l'utilisateur veut créer/faire/générer une présentation, un diaporama, un PowerPoint ou des slides (sinon réponds normalement). VARIE la structure des slides pour un rendu pro et qualitatif : n'utilise pas partout de simples puces. Selon la slide, combine : une phrase d'accroche (lead), une ligne secondaire (subtext), un court paragraphe (body), des puces (bullets), des badges de catégories (badges), ou des chiffres clés (stats). Choisis une couleur de marque (accent) cohérente avec le sujet, un sous-titre, et pour CHAQUE slide un label de section + des mots-clés d'image EN ANGLAIS. Contenu riche mais lisible (évite de tout mettre sur une slide). 6 à 10 slides.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Titre de la présentation' },
        subtitle: { type: 'string', description: 'Sous-titre / accroche (slide de titre)' },
        accent: { type: 'string', description: 'Couleur de marque en hexa SANS # (ex: C0392B). Cohérente avec le sujet.' },
        image_query: { type: 'string', description: "Mots-clés EN ANGLAIS pour la photo de titre" },
        session: { type: 'string', description: 'Petit texte en bas à gauche de la slide de titre (ex: "Session 2027")' },
        presenter: { type: 'string', description: "Nom de l'auteur (optionnel, slide de titre)" },
        presenter_role: { type: 'string', description: "Rôle de l'auteur (optionnel)" },
        slides: {
          type: 'array',
          description: 'Slides de contenu (la slide de titre est ajoutée automatiquement). Varie les mises en page.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Label de section en majuscules' },
              title: { type: 'string', description: 'Titre de la slide' },
              lead: { type: 'string', description: "Phrase d'accroche mise en avant (optionnel)" },
              subtext: { type: 'string', description: 'Ligne secondaire en gris italique (optionnel)' },
              body: { type: 'string', description: 'Court paragraphe explicatif (optionnel, 1-3 phrases)' },
              bullets: { type: 'array', items: { type: 'string' }, description: 'Puces courtes (optionnel)' },
              badges: { type: 'array', description: 'Catégories façon étiquettes (optionnel)', items: { type: 'object', properties: { label: { type: 'string', description: 'Texte court de l\'étiquette (ex: B2B)' }, text: { type: 'string', description: 'Description à droite de l\'étiquette' } }, required: ['label', 'text'] } },
              stats: { type: 'array', description: 'Chiffres clés (optionnel)', items: { type: 'object', properties: { value: { type: 'string', description: 'Le chiffre (ex: "2 Md€")' }, label: { type: 'string', description: 'Ce que représente le chiffre' } }, required: ['value', 'label'] } },
              image_query: { type: 'string', description: "Mots-clés EN ANGLAIS pour la photo de cette slide" }
            },
            required: ['title']
          }
        }
      },
      required: ['title', 'slides']
    }
  }];

  let systemToUse = SYSTEM_PROMPT;
  if (mode === 'correct') {
    systemToUse = "Tu es un correcteur de français professionnel. On te donne un texte : tu dois le CORRIGER, pas répondre à son contenu. Corrige l'orthographe, la grammaire, la conjugaison, la ponctuation, la typographie, et améliore la formulation pour que ce soit clair et naturel, SANS changer le sens ni le ton. Réponds en Markdown, exactement dans ce format :\n\n## ✅ Texte corrigé\n\n(le texte entièrement corrigé)\n\n## ✍️ Principales corrections\n\n- (liste courte et simple des fautes ou reformulations importantes ; si tout était déjà correct, écris « Rien à signaler, ton texte était déjà correct 👍 »)";
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 3000, system: systemToUse, messages, tools })
    });
    if (!r.ok) {
      const errTxt = await r.text();
      console.error('Anthropic error', r.status, errTxt);
      return res.status(502).json({ error: 'ai', message: "L'IA n'a pas pu répondre, réessaie." });
    }
    const data = await r.json();
    const now = Date.now();
    let marker = '';
    if (fileKind === 'image') marker = '🖼️ [image]';
    else if (fileKind === 'pdf') marker = '📄 [' + (file.name || 'PDF') + ']';
    else if (fileKind === 'text') marker = '📎 [' + (file.name || 'fichier') + ']';
    const storedUser = marker ? (text ? text + '\n' + marker : marker) : text;

    // L'IA a-t-elle décidé de créer une présentation ?
    const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'create_presentation');
    if (toolUse) {
      const pres = await buildPptx(toolUse.input || {});
      const pre = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      const reply = (pre ? pre + '\n\n' : '') + 'Voilà ✨ Ta présentation « ' + pres.title + ' » est prête ! Clique sur le bouton pour la télécharger.\n\nTu peux me demander d\'ajouter des slides, d\'en enlever ou de changer le contenu.';
      db.prepare('INSERT INTO messages (user_id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)').run(u.id, convId, 'user', storedUser, now);
      db.prepare('INSERT INTO messages (user_id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)').run(u.id, convId, 'assistant', reply + '\n📊 [' + pres.title + ']', now + 1);
      db.prepare('UPDATE users SET msg_used = msg_used + 1 WHERE id = ?').run(u.id);
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
      return res.json({ reply, download: { url: pres.url, title: pres.title }, used: u.msg_used + 1, limit, conversation_id: convId, title: conv.title });
    }

    // Réponse texte normale
    const reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || '…';
    db.prepare('INSERT INTO messages (user_id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)').run(u.id, convId, 'user', storedUser, now);
    db.prepare('INSERT INTO messages (user_id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)').run(u.id, convId, 'assistant', reply, now + 1);
    db.prepare('UPDATE users SET msg_used = msg_used + 1 WHERE id = ?').run(u.id);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
    res.json({ reply, used: u.msg_used + 1, limit, conversation_id: convId, title: conv.title });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: 'ai', message: "Erreur de connexion à l'IA." });
  }
});

app.get('/download/:name', requireAuth, (req, res) => {
  const name = req.params.name;
  if (!/^[\w.-]+\.(pptx|docx|pdf)$/.test(name)) return res.status(400).end();
  const fp = path.join(GEN_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).end();
  res.download(fp);
});

// ===================== ADMIN (gérer le Pro à la main) =====================
function computeStats() {
  const now = Date.now();
  const dayMs = 86400000;
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const todayTs = startOfToday.getTime();
  const g = (sql, ...a) => { try { return db.prepare(sql).get(...a).n; } catch (e) { return 0; } };
  const users = g('SELECT COUNT(*) n FROM users');
  const pro = g("SELECT COUNT(*) n FROM users WHERE plan='pro'");
  const verified = g('SELECT COUNT(*) n FROM users WHERE verified=1');
  const convs = g('SELECT COUNT(*) n FROM conversations');
  const msgsTotal = g('SELECT COUNT(*) n FROM messages');
  const questions = g("SELECT COUNT(*) n FROM messages WHERE role='user'");
  const msgsToday = g('SELECT COUNT(*) n FROM messages WHERE created_at >= ?', todayTs);
  const msgs7 = g('SELECT COUNT(*) n FROM messages WHERE created_at >= ?', now - 7 * dayMs);
  const newUsers7 = g('SELECT COUNT(*) n FROM users WHERE created_at >= ?', now - 7 * dayMs);
  const active7 = g('SELECT COUNT(DISTINCT user_id) n FROM messages WHERE created_at >= ?', now - 7 * dayMs);
  // Messages par jour (7 derniers jours)
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(startOfToday.getTime() - i * dayMs);
    const s = d.getTime(), e = s + dayMs;
    const n = g('SELECT COUNT(*) n FROM messages WHERE created_at >= ? AND created_at < ?', s, e);
    days.push({ label: ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'][d.getDay()], n });
  }
  const maxDay = Math.max(1, ...days.map(d => d.n));
  return { model: MODEL, users, pro, verified, convs, msgsTotal, questions, msgsToday, msgs7, newUsers7, active7, days, maxDay };
}

app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, email, plan, msg_used, created_at FROM users ORDER BY id DESC').all();
  res.render('admin', { users, proLimit: PRO_LIMIT, freeLimit: FREE_LIMIT, notice: null, stats: computeStats() });
});
app.post('/admin/resetpw', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.body.userId, 10);
  const target = db.prepare('SELECT id, email FROM users WHERE id = ?').get(id);
  let notice = null;
  if (target) {
    const temp = crypto.randomBytes(4).toString('hex'); // 8 caractères
    const hash = await bcrypt.hash(temp, 10);
    db.prepare('UPDATE users SET password = ?, verified = 1 WHERE id = ?').run(hash, id);
    notice = { email: target.email, temp };
  }
  const users = db.prepare('SELECT id, email, plan, msg_used, created_at FROM users ORDER BY id DESC').all();
  res.render('admin', { users, proLimit: PRO_LIMIT, freeLimit: FREE_LIMIT, notice, stats: computeStats() });
});
app.post('/admin/setplan', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.body.userId, 10);
  const plan = req.body.plan === 'pro' ? 'pro' : 'free';
  if (id) db.prepare('UPDATE users SET plan = ?, msg_used = 0, period_start = ? WHERE id = ?').run(plan, Date.now(), id);
  res.redirect('/admin');
});

// ===================== DIAGNOSTIC =====================
app.get('/health', (req, res) => {
  const info = { ok: true, model: MODEL, dataDir: DATA_DIR, node: process.version, hasApiKey: !!ANTHROPIC_API_KEY, mailEnabled: MAIL_ENABLED };
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
