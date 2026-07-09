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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.AI_MODEL || 'claude-haiku-4-5';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  "Tu es un assistant amical et serviable qui répond en français de façon claire et concise.";

const FREE_LIMIT = parseInt(process.env.PLAN_FREE_LIMIT || '150', 10);   // messages / mois (gratuit)
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

// Quatre styles visuels bien distincts (couleurs, coins arrondis ou carrés, police, ombres)
const PPTX_THEMES = {
  canva: { bg: 'F5F5F6', card: 'FFFFFF', line: 'E5E7EB', dark: '1F2328', body: '3C4149', mut: '9AA0A6', soft: '6B7280', radius: 0.08, shadow: true, font: 'Arial' },
  dark: { bg: '16161D', card: '212129', line: '32323C', dark: 'F5F5F7', body: 'C9C9D2', mut: '8B8B96', soft: 'A6A6B0', radius: 0.08, shadow: false, font: 'Arial' },
  sharp: { bg: 'FFFFFF', card: 'F7F7F7', line: 'D6D6D6', dark: '111111', body: '333333', mut: '8A8A8A', soft: '5C5C5C', radius: 0, shadow: false, font: 'Georgia' },
  bold: { bg: 'FFFFFF', card: 'FFFFFF', line: 'ECECEC', dark: '0A0A0A', body: '2B2B2B', mut: '9A9A9A', soft: '5C5C5C', radius: 0.18, shadow: true, font: 'Verdana' }
};

// Lit un .pptx envoyé par l'utilisateur et en extrait le texte, slide par slide
async function extractPptxText(buffer) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)));
  const slides = [];
  for (const name of names) {
    const xml = await zip.files[name].async('string');
    const texts = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&quot;/g, '"'));
    slides.push(texts.join(' ').trim());
  }
  return slides;
}

function xmlDecode(s) { return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'").replace(/&quot;/g, '"'); }
function xmlEncode(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;').replace(/"/g, '&quot;'); }
function pptxParagraphs(xml) { return xml.match(/<a:p>[\s\S]*?<\/a:p>/g) || []; }
function pptxParagraphText(pXml) { return [...pXml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => xmlDecode(m[1])).join('').trim(); }

// Extrait tous les paragraphes de texte non-vides d'un .pptx joint, dans l'ordre (pour un remplissage fidèle du modèle)
async function extractPptxParagraphs(buffer) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)));
  const items = [];
  for (let i = 0; i < names.length; i++) {
    const xml = await zip.files[names[i]].async('string');
    for (const p of pptxParagraphs(xml)) {
      const t = pptxParagraphText(p);
      if (t) items.push({ slide: i + 1, text: t });
    }
  }
  return items;
}

// Reconstruit le .pptx d'origine en remplaçant le texte par CORRESPONDANCE EXACTE (original -> nouveau texte),
// pas par position : si l'IA oublie une entrée, seul CE texte reste inchangé (pas d'effet domino sur tout le fichier).
async function fillPptxTemplateByMap(buffer, mappings) {
  const JSZip = require('jszip');
  const norm = s => String(s).replace(/\s+/g, ' ').trim();
  const map = new Map();
  (Array.isArray(mappings) ? mappings : []).forEach(m => {
    if (m && typeof m.original === 'string' && typeof m.replacement === 'string') {
      map.set(norm(m.original), m.replacement);
    }
  });
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => (parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10)));
  let replacedCount = 0, totalCount = 0;
  for (const name of names) {
    let xml = await zip.files[name].async('string');
    xml = xml.replace(/<a:p>[\s\S]*?<\/a:p>/g, (pBlock) => {
      const original = pptxParagraphText(pBlock);
      if (!original) return pBlock;
      totalCount++;
      const key = norm(original);
      if (!map.has(key)) return pBlock; // pas de correspondance fournie -> texte d'origine conservé
      const newText = map.get(key);
      replacedCount++;
      let usedFirst = false;
      return pBlock.replace(/<a:t>([^<]*)<\/a:t>/g, () => {
        if (!usedFirst) { usedFirst = true; return '<a:t>' + xmlEncode(newText) + '</a:t>'; }
        return '<a:t></a:t>';
      });
    });
    zip.file(name, xml);
  }
  const outBuf = await zip.generateAsync({ type: 'nodebuffer' });
  return { buffer: outBuf, replacedCount, totalCount };
}

// Génère une image via l'API OpenAI (gpt-image-2). Si une image de référence est fournie
// (ex: un logo envoyé par l'utilisateur), on utilise l'endpoint "edits" pour l'intégrer au résultat.
async function generateImageOpenAI({ prompt, quality, size, refData, refMediaType }) {
  if (!OPENAI_API_KEY) throw new Error('no_api_key');
  const q = ['low', 'medium', 'high'].includes(quality) ? quality : 'medium';
  const sz = ['1024x1024', '1024x1536', '1536x1024'].includes(size) ? size : '1024x1024';
  let r;
  if (refData) {
    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('prompt', prompt);
    form.append('quality', q);
    form.append('size', sz);
    const ext = (refMediaType || '').includes('png') ? 'png' : 'jpg';
    form.append('image', new Blob([Buffer.from(refData, 'base64')], { type: refMediaType || 'image/png' }), 'reference.' + ext);
    r = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + OPENAI_API_KEY },
      body: form
    });
  } else {
    r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + OPENAI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-image-2', prompt, quality: q, size: sz, n: 1 })
    });
  }
  if (!r.ok) {
    const errText = await r.text();
    console.error('OpenAI image error', r.status, errText);
    throw new Error('openai_image_failed');
  }
  const data = await r.json();
  const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
  if (!b64) throw new Error('openai_image_empty');
  return Buffer.from(b64, 'base64');
}

// Place l'image générée (texte et design déjà composés par l'IA) dans un unique slide PowerPoint,
// en un seul objet image déplaçable/redimensionnable/remplaçable (import possible dans Canva)
// Flyer soigné : fond généré par IA + titre/sous-titre/infos en texte éditable + logo en élément séparé
// (chaque élément reste déplaçable/redimensionnable indépendamment dans PowerPoint/Canva)
async function buildFlyerPptx({ imageBuffer, title, kicker, subtitle, details, accent, logoBuffer, logoMediaType }) {
  const pptxgen = require('pptxgenjs');
  const pres = new pptxgen();
  const W = 8.5, H = 12.75; // portrait 2:3, format affiche
  pres.defineLayout({ name: 'FLYER', width: W, height: H });
  pres.layout = 'FLYER';
  const ACC = (typeof accent === 'string' && /^[0-9a-fA-F]{6}$/.test(accent)) ? accent.toUpperCase() : 'C15F3C';
  const ACCD = darken(ACC, 0.55); // teinte foncée de la couleur de marque (pour un dégradé coloré, pas juste gris/noir)
  const s = pres.addSlide();
  s.background = { color: '0B0B0F' };
  const imgB64 = 'data:image/png;base64,' + imageBuffer.toString('base64');
  s.addImage({ data: imgB64, x: 0, y: 0, w: W, h: H, sizing: { type: 'cover', w: W, h: H } });

  // Dégradé progressif teinté (mélange noir + couleur de marque) plutôt qu'un gris plat
  const gradTop = H * 0.56, gradH = H * 0.44, steps = 18;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const opacity = Math.round(t * 82);
    s.addShape('rect', { x: 0, y: gradTop + (gradH / steps) * i, w: W, h: (gradH / steps) + 0.02, fill: { color: ACCD, transparency: 100 - opacity } });
  }

  // Ruban en forme de bannière (pas un simple rectangle) pour le kicker
  s.addShape('chevron', { x: 0, y: 0.5, w: 2.9, h: 0.55, fill: { color: ACC }, line: { type: 'none' } });
  s.addText((kicker || 'ÉVÉNEMENT').toString().toUpperCase(), { x: 0.15, y: 0.5, w: 2.35, h: 0.55, align: 'center', valign: 'middle', fontSize: 13, bold: true, color: 'FFFFFF', charSpacing: 1.5, fontFace: 'Montserrat' });

  // Logo (si fourni) : élément à part entière, déplaçable/redimensionnable indépendamment du fond
  if (logoBuffer) {
    const ext = (logoMediaType || '').includes('png') ? 'png' : 'jpeg';
    const logoUri = 'data:' + (logoMediaType || 'image/png') + ';base64,' + logoBuffer.toString('base64');
    s.addImage({ data: logoUri, x: W - 1.9, y: 0.5, w: 1.35, h: 1.35, sizing: { type: 'contain', w: 1.35, h: 1.35 } });
  }

  const textShadow = { type: 'outer', color: '000000', opacity: 0.55, blur: 6, offset: 3, angle: 90 };
  let y = H * 0.62;
  s.addShape('rect', { x: 0.55, y, w: 1.0, h: 0.1, fill: { color: ACC } });
  y += 0.28;
  s.addText((title || 'Titre').toString(), { x: 0.5, y, w: W - 1, h: 1.3, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: 'Montserrat', shadow: textShadow });
  y += 1.35;
  if (subtitle) { s.addText(String(subtitle), { x: 0.5, y, w: W - 1, h: 0.55, fontSize: 16.5, color: 'F2F2F2', italic: true, fontFace: 'Montserrat', shadow: textShadow }); y += 0.65; }

  // Infos pratiques en pilules colorées
  const lines = Array.isArray(details) ? details.filter(Boolean) : [];
  if (lines.length) {
    const rowH = 0.48;
    lines.forEach(l => {
      s.addShape('roundRect', { x: 0.5, y: y + 0.02, w: 0.36, h: 0.36, rectRadius: 0.18, fill: { color: ACC } });
      s.addText('✓', { x: 0.5, y: y + 0.02, w: 0.36, h: 0.36, align: 'center', valign: 'middle', fontSize: 13, bold: true, color: 'FFFFFF' });
      s.addText(String(l), { x: 0.98, y, w: W - 1.5, h: rowH, fontSize: 14.5, color: 'FFFFFF', valign: 'middle', fontFace: 'Montserrat' });
      y += rowH + 0.1;
    });
  }

  const token = crypto.randomBytes(6).toString('hex');
  const fileName = 'flyer-' + token + '.pptx';
  await pres.writeFile({ fileName: path.join(GEN_DIR, fileName) });
  return { url: '/download/' + fileName, fileName };
}

// Place une image déjà entièrement composée (texte inclus, façon poster fini) dans un pptx : un seul objet déplaçable/redimensionnable
async function wrapImageInPptx(imageBuffer, pxWidth, pxHeight) {
  const pptxgen = require('pptxgenjs');
  const pres = new pptxgen();
  const W = 10;
  const H = Math.round((W * ((pxHeight || 1536) / (pxWidth || 1024))) * 100) / 100;
  pres.defineLayout({ name: 'FLYER', width: W, height: H });
  pres.layout = 'FLYER';
  const s = pres.addSlide();
  const imgB64 = 'data:image/png;base64,' + imageBuffer.toString('base64');
  s.addImage({ data: imgB64, x: 0, y: 0, w: W, h: H });
  const token = crypto.randomBytes(6).toString('hex');
  const fileName = 'flyer-' + token + '.pptx';
  await pres.writeFile({ fileName: path.join(GEN_DIR, fileName) });
  return { url: '/download/' + fileName, fileName };
}

// Construit un .pptx façon "Canva" (2 colonnes, photos, couleur de marque) à partir de la spec
async function buildPptx(spec) {
  const pptxgen = require('pptxgenjs');
  const pres = new pptxgen();
  pres.layout = 'LAYOUT_WIDE';
  const ACC = (spec && typeof spec.accent === 'string' && /^[0-9a-fA-F]{6}$/.test(spec.accent)) ? spec.accent.toUpperCase() : 'C15F3C';
  const ACCD = darken(ACC, 0.30);
  const TH = PPTX_THEMES[spec && spec.theme] || PPTX_THEMES.canva;
  const DARK = TH.dark, BODY = TH.body, MUT = TH.mut, LIGHTBG = TH.bg, SOFT = TH.soft;
  const CARD = TH.card, LINE = TH.line, RADIUS = TH.radius, FONT = TH.font;
  const CARD_STYLES = ['square', 'circle', 'bar', 'minimal'];
  const CARD_STYLE = CARD_STYLES.includes(spec && spec.card_style) ? spec.card_style : CARD_STYLES[Math.floor(Math.random() * CARD_STYLES.length)];
  pres.theme = { headFontFace: FONT, bodyFontFace: FONT };
  const title = (spec && spec.title ? spec.title : 'Présentation').toString();
  const subtitle = (spec && spec.subtitle ? spec.subtitle : '').toString();
  const session = (spec && spec.session ? spec.session : '').toString();
  const presenter = (spec && spec.presenter ? spec.presenter : '').toString();
  const presenterRole = (spec && spec.presenter_role ? spec.presenter_role : '').toString();
  const slides = (spec && Array.isArray(spec.slides)) ? spec.slides : [];
  const shadow = TH.shadow ? { type: 'outer', blur: 10, offset: 3, angle: 90, color: '000000', opacity: 0.22 } : undefined;

  // Photos en parallèle (inutile si la slide a déjà un panneau couleur, un chiffre clé, ou une slide spéciale)
  const [titleImg, slideImgs] = await Promise.all([
    fetchImage(spec && spec.image_query),
    Promise.all(slides.map(sl => (sl && (sl.panel || sl.callout || sl.divider || sl.quote)) ? Promise.resolve(null) : fetchImage(sl && sl.image_query)))
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
    // ---------- Slide "divider" : page de transition pleine couleur (ouvre une nouvelle partie) ----------
    if (sl && sl.divider) {
      const d = pres.addSlide();
      d.background = { color: ACC };
      d.addShape('roundRect', { x: 5.65, y: 1.3, w: 1.2, h: 1.2, rectRadius: 0.18, fill: { color: 'FFFFFF' } });
      d.addText((sl.icon || '\u2726').toString(), { x: 5.65, y: 1.3, w: 1.2, h: 1.2, align: 'center', valign: 'middle', fontSize: 40, color: ACC });
      d.addText((sl.title || '').toString().toUpperCase(), { x: 1, y: 2.95, w: 10.9, h: 1.1, align: 'center', fontSize: 32, bold: true, color: 'FFFFFF' });
      if (sl.subtext) d.addText(sl.subtext, { x: 2, y: 4.05, w: 8.9, h: 0.6, align: 'center', fontSize: 14, color: 'FFFFFF' });
      return;
    }
    // ---------- Slide "quote" : accroche/citation forte pleine couleur ----------
    if (sl && sl.quote) {
      const q = pres.addSlide();
      q.background = { color: ACC };
      q.addShape('roundRect', { x: 0.9, y: 0.7, w: 0.9, h: 0.9, rectRadius: 0.16, fill: { color: 'FFFFFF' } });
      q.addText((sl.icon || '\u25CE').toString(), { x: 0.9, y: 0.7, w: 0.9, h: 0.9, align: 'center', valign: 'middle', fontSize: 32, color: ACC });
      const qlabel = (sl.label || '').toString();
      if (qlabel) q.addText(qlabel.toUpperCase(), { x: 0.9, y: 1.85, w: 10, h: 0.4, fontSize: 13, bold: true, color: 'FFFFFF', charSpacing: 2 });
      q.addText((sl.title || '').toString().toUpperCase(), { x: 0.9, y: 2.3, w: 10.9, h: 1.6, fontSize: 32, bold: true, color: 'FFFFFF' });
      q.addShape('roundRect', { x: 0.9, y: 4.15, w: 10.9, h: 1.7, rectRadius: 0.08, fill: { color: 'FFFFFF' } });
      q.addText((sl.quote || '').toString(), { x: 1.3, y: 4.15, w: 10.1, h: 1.7, fontSize: 18, bold: true, color: DARK, valign: 'middle', lineSpacingMultiple: 1.2 });
      if (sl.note) q.addText(sl.note, { x: 0.9, y: 6.05, w: 10.9, h: 0.4, fontSize: 13, italic: true, color: 'FFFFFF' });
      return;
    }

    const img = slideImgs[i];
    const hasImg = !!img;
    const panel = (sl && sl.panel && typeof sl.panel === 'object') ? sl.panel : null;
    const callout = (sl && sl.callout && typeof sl.callout === 'object') ? sl.callout : null;
    const hasRight = hasImg || !!panel || !!callout;
    const c = pres.addSlide();
    c.background = { color: LIGHTBG };
    const CX = 0.9;
    const CW = hasRight ? 6.2 : 11.4;
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
    if (body) { const lines = Math.max(1, Math.ceil(body.length / (hasRight ? 50 : 95))); const h = lines * 0.29 + 0.08; c.addText(body, { x: CX, y, w: CW, h, fontSize: 14, color: BODY, lineSpacingMultiple: 1.15 }); y += h + 0.22; }

    const bullets = (sl && Array.isArray(sl.bullets)) ? sl.bullets : [];
    if (bullets.length) { const arr = bullets.map(b => ({ text: String(b), options: { bullet: { code: '2022', indent: 18 }, fontSize: 15, color: BODY, paraSpaceAfter: 10 } })); const h = bullets.length * 0.44 + 0.1; c.addText(arr, { x: CX + 0.05, y, w: CW - 0.05, h, valign: 'top', lineSpacingMultiple: 1.1 }); y += h + 0.12; }

    const badges = (sl && Array.isArray(sl.badges)) ? sl.badges : [];
    if (badges.length) { badges.forEach(bd => { const bw = 1.55, bh = 0.5; c.addShape('roundRect', { x: CX, y, w: bw, h: bh, rectRadius: 0.06, fill: { color: ACC } }); c.addText((bd && bd.label ? bd.label : '').toString(), { x: CX, y, w: bw, h: bh, align: 'center', valign: 'middle', bold: true, color: 'FFFFFF', fontSize: 13 }); c.addText((bd && bd.text ? bd.text : '').toString(), { x: CX + bw + 0.22, y, w: CW - bw - 0.22, h: bh, valign: 'middle', fontSize: 14, color: BODY }); y += bh + 0.16; }); }

    const stats = (sl && Array.isArray(sl.stats)) ? sl.stats : [];
    if (stats.length) { const n = Math.min(stats.length, 3); const gap = 0.3; const sw = (CW - gap * (n - 1)) / n; stats.slice(0, n).forEach((st, idx) => { const sx = CX + idx * (sw + gap); c.addText((st && st.value ? st.value : '').toString(), { x: sx, y, w: sw, h: 0.7, fontSize: 34, bold: true, color: ACC }); c.addText((st && st.label ? st.label : '').toString(), { x: sx, y: y + 0.74, w: sw, h: 0.6, fontSize: 12, color: BODY }); }); y += 1.5; }

    // Cartes à icônes (grille façon "offres"), 4 styles visuels différents pour ne jamais se répéter
    const cards = (sl && Array.isArray(sl.cards)) ? sl.cards : [];
    if (cards.length) {
      const cols = cards.length <= 2 ? cards.length : (cards.length <= 4 ? 2 : 3);
      const gap = 0.22;
      const cw = (CW - gap * (cols - 1)) / cols;
      const ch = CARD_STYLE === 'bar' ? 1.65 : 1.5;
      cards.forEach((cd, idx) => {
        const col = idx % cols, row = Math.floor(idx / cols);
        const cx = CX + col * (cw + gap);
        const cy = y + row * (ch + gap);
        const icon = (cd && cd.icon ? cd.icon : '\u2605').toString();
        const ctitle = (cd && cd.title ? cd.title : '').toString();
        const ctext = (cd && cd.text ? cd.text : '').toString();

        if (CARD_STYLE === 'circle') {
          // Icône ronde centrée en haut, titre et texte centrés
          c.addShape('roundRect', { x: cx, y: cy, w: cw, h: ch, rectRadius: RADIUS, fill: { color: CARD }, line: { color: LINE, width: 0.75 } });
          c.addShape('ellipse', { x: cx + cw / 2 - 0.32, y: cy + 0.18, w: 0.64, h: 0.64, fill: { color: ACC } });
          c.addText(icon, { x: cx + cw / 2 - 0.32, y: cy + 0.18, w: 0.64, h: 0.64, align: 'center', valign: 'middle', fontSize: 22, color: 'FFFFFF' });
          c.addText(ctitle, { x: cx + 0.15, y: cy + 0.9, w: cw - 0.3, h: 0.35, fontSize: 13, bold: true, color: DARK, align: 'center' });
          c.addText(ctext, { x: cx + 0.15, y: cy + 1.22, w: cw - 0.3, h: ch - 1.3, fontSize: 10, color: BODY, align: 'center', valign: 'top', lineSpacingMultiple: 1.05 });
        } else if (CARD_STYLE === 'bar') {
          // Barre de couleur pleine largeur en haut, icône dedans, titre + texte en dessous
          c.addShape('roundRect', { x: cx, y: cy, w: cw, h: ch, rectRadius: RADIUS, fill: { color: CARD }, line: { color: LINE, width: 0.75 } });
          c.addShape('roundRect', { x: cx, y: cy, w: cw, h: 0.55, rectRadius: RADIUS, fill: { color: ACC } });
          c.addShape('rect', { x: cx, y: cy + 0.28, w: cw, h: 0.27, fill: { color: ACC } });
          c.addText(icon, { x: cx + 0.15, y: cy, w: 0.5, h: 0.55, align: 'center', valign: 'middle', fontSize: 18, color: 'FFFFFF' });
          c.addText(ctitle, { x: cx + 0.6, y: cy, w: cw - 0.75, h: 0.55, fontSize: 12.5, bold: true, color: 'FFFFFF', valign: 'middle' });
          c.addText(ctext, { x: cx + 0.2, y: cy + 0.7, w: cw - 0.4, h: ch - 0.85, fontSize: 10.5, color: BODY, valign: 'top', lineSpacingMultiple: 1.08 });
        } else if (CARD_STYLE === 'minimal') {
          // Pas de fond de carte : juste un trait de couleur, icône + titre en ligne, texte en dessous
          c.addShape('rect', { x: cx, y: cy, w: 0.06, h: ch, fill: { color: ACC } });
          c.addText(icon, { x: cx + 0.22, y: cy, w: 0.5, h: 0.5, fontSize: 20, valign: 'middle' });
          c.addText(ctitle, { x: cx + 0.7, y: cy, w: cw - 0.85, h: 0.5, fontSize: 13, bold: true, color: DARK, valign: 'middle' });
          c.addText(ctext, { x: cx + 0.22, y: cy + 0.56, w: cw - 0.4, h: ch - 0.65, fontSize: 10.5, color: BODY, valign: 'top', lineSpacingMultiple: 1.08 });
        } else {
          // 'square' (style d'origine) : icône carrée en haut à gauche, titre à côté, texte en dessous
          c.addShape('roundRect', { x: cx, y: cy, w: cw, h: ch, rectRadius: RADIUS, fill: { color: CARD }, line: { color: LINE, width: 0.75 } });
          c.addShape('roundRect', { x: cx + 0.2, y: cy + 0.2, w: 0.5, h: 0.5, rectRadius: RADIUS, fill: { color: ACC } });
          c.addText(icon, { x: cx + 0.2, y: cy + 0.2, w: 0.5, h: 0.5, align: 'center', valign: 'middle', fontSize: 20, color: 'FFFFFF' });
          c.addText(ctitle, { x: cx + 0.85, y: cy + 0.2, w: cw - 1.05, h: 0.5, fontSize: 13, bold: true, color: DARK, valign: 'middle' });
          c.addText(ctext, { x: cx + 0.2, y: cy + 0.78, w: cw - 0.4, h: ch - 0.95, fontSize: 10.5, color: BODY, valign: 'top', lineSpacingMultiple: 1.08 });
        }
      });
      const rows = Math.ceil(cards.length / cols);
      y += rows * (ch + gap) + 0.1;
    }


    // Tableau de données (en-tête colorée, façon tableau de résultats)
    const table = (sl && sl.table && Array.isArray(sl.table.rows)) ? sl.table : null;
    if (table) {
      const headers = Array.isArray(table.headers) ? table.headers : [];
      const tRows = [];
      if (headers.length) tRows.push(headers.map(h => ({ text: String(h), options: { bold: true, color: 'FFFFFF', fill: { color: ACC }, fontSize: 12 } })));
      table.rows.forEach((r, ri) => {
        tRows.push((Array.isArray(r) ? r : []).map((cell, ci) => ({ text: String(cell), options: { color: BODY, fontSize: 11.5, fill: { color: ri % 2 === 0 ? 'FFFFFF' : LIGHTBG }, bold: ci === 0 } })));
      });
      if (tRows.length) {
        const rowH = 0.42;
        c.addTable(tRows, { x: CX, y, w: CW, h: rowH * tRows.length, autoPage: false, border: { type: 'solid', color: LINE, pt: 0.75 }, valign: 'middle', margin: 3, fontFace: FONT });
        y += rowH * tRows.length + 0.2;
      }
    }

    // Étapes numérotées (ex: méthode CROC) : puce-lettre colorée + titre + texte, en liste
    const steps = (sl && Array.isArray(sl.steps)) ? sl.steps : [];
    if (steps.length) {
      const rh = 0.72;
      steps.forEach(st => {
        c.addShape('roundRect', { x: CX, y, w: 0.55, h: 0.55, rectRadius: RADIUS, fill: { color: ACC } });
        c.addText((st && st.letter ? st.letter : '\u2022').toString(), { x: CX, y, w: 0.55, h: 0.55, align: 'center', valign: 'middle', fontSize: 20, bold: true, color: 'FFFFFF' });
        const tx = [];
        if (st && st.title) tx.push({ text: String(st.title), options: { bold: true, color: DARK, fontSize: 13, breakLine: true } });
        if (st && st.text) tx.push({ text: String(st.text), options: { color: BODY, fontSize: 11.5 } });
        c.addText(tx, { x: CX + 0.72, y, w: CW - 0.72, h: rh, valign: 'top', lineSpacingMultiple: 1.05 });
        y += rh + 0.12;
      });
      y += 0.05;
    }

    // Barres de comparaison (ex: objectif vs réalisé)
    const bars = (sl && Array.isArray(sl.bars)) ? sl.bars : [];
    if (bars.length) {
      bars.forEach(b => {
        const val = Number(b && b.value) || 0, max = Number(b && b.max) || 100;
        const pct = Math.max(0, Math.min(1, max ? val / max : 0));
        c.addText((b && b.label ? b.label : '').toString(), { x: CX, y, w: CW * 0.6, h: 0.32, fontSize: 13, bold: true, color: DARK });
        const disp = (b && b.display ? b.display : Math.round(pct * 100) + ' %').toString();
        c.addText(disp, { x: CX + CW - 1.6, y, w: 1.6, h: 0.32, align: 'right', fontSize: 13, bold: true, color: ACC });
        y += 0.36;
        c.addShape('roundRect', { x: CX, y, w: CW, h: 0.26, rectRadius: 0.05, fill: { color: LINE } });
        c.addShape('roundRect', { x: CX, y, w: Math.max(0.12, CW * pct), h: 0.26, rectRadius: 0.05, fill: { color: ACC } });
        y += 0.26 + 0.08;
        if (b && b.note) { c.addText(String(b.note), { x: CX, y, w: CW, h: 0.25, fontSize: 10, color: MUT }); y += 0.28; }
        y += 0.14;
      });
    }

    // Planning / Gantt (déroulé dans le temps)
    const timeline = (sl && sl.timeline && Array.isArray(sl.timeline.rows)) ? sl.timeline : null;
    if (timeline) {
      const periods = Array.isArray(timeline.periods) ? timeline.periods : [];
      const labelW = CW * 0.28;
      const trackW = CW - labelW;
      const n = Math.max(1, periods.length || Math.max.apply(null, timeline.rows.map(r => (r && r.end) || 1)));
      const colW = trackW / n;
      if (periods.length) { periods.forEach((p, idx) => { c.addText(String(p), { x: CX + labelW + idx * colW, y, w: colW, h: 0.3, fontSize: 10.5, bold: true, color: MUT } ); }); y += 0.4; }
      const rowH = 0.42;
      timeline.rows.forEach(r => {
        c.addText((r && r.label ? r.label : '').toString(), { x: CX, y: y + 0.03, w: labelW - 0.15, h: rowH, fontSize: 11, color: DARK, valign: 'middle' });
        c.addShape('roundRect', { x: CX + labelW, y: y + 0.06, w: trackW, h: rowH - 0.14, rectRadius: 0.04, fill: { color: 'E8E8EA' } });
        const s = Math.max(1, (r && r.start) || 1) - 1, e = Math.max(s + 1, (r && r.end) || s + 1);
        c.addShape('roundRect', { x: CX + labelW + s * colW, y: y + 0.06, w: Math.max(colW * 0.6, (e - s) * colW), h: rowH - 0.14, rectRadius: 0.04, fill: { color: ACC } });
        y += rowH + 0.08;
      });
      y += 0.1;
    }

    // Organigramme (boîtes hiérarchiques, la personne "highlight" ressort en couleur)
    const org = (sl && sl.org && typeof sl.org === 'object') ? sl.org : null;
    if (org) {
      const boxW = 2.5, boxH = 0.8, gap = 0.28;
      let oy = y;
      if (org.top) {
        const bx = CX + (CW - boxW) / 2;
        c.addShape('roundRect', { x: bx, y: oy, w: boxW, h: boxH, rectRadius: RADIUS * 0.75, fill: { color: CARD }, line: { color: LINE, width: 0.75 } });
        c.addText([{ text: (org.top.name || '').toString(), options: { bold: true, color: DARK, fontSize: 12, breakLine: true } }, { text: (org.top.role || '').toString(), options: { color: MUT, fontSize: 10 } }], { x: bx, y: oy, w: boxW, h: boxH, valign: 'middle', align: 'center' });
        oy += boxH + gap + 0.25;
      }
      const orows = Array.isArray(org.rows) ? org.rows : [];
      orows.forEach(rowArr => {
        const arr = Array.isArray(rowArr) ? rowArr : [];
        const n2 = arr.length || 1;
        const rowW = n2 * boxW + (n2 - 1) * gap;
        let bx = CX + (CW - rowW) / 2;
        arr.forEach(person => {
          const hl = !!(person && person.highlight);
          c.addShape('roundRect', { x: bx, y: oy, w: boxW, h: boxH, rectRadius: RADIUS * 0.75, fill: { color: hl ? ACC : CARD }, line: hl ? undefined : { color: LINE, width: 0.75 } });
          c.addText([{ text: (person && person.name ? person.name : '').toString(), options: { bold: true, color: hl ? 'FFFFFF' : DARK, fontSize: 12, breakLine: true } }, { text: (person && person.role ? person.role : '').toString(), options: { color: hl ? 'FFFFFF' : MUT, fontSize: 10 } }], { x: bx, y: oy, w: boxW, h: boxH, valign: 'middle', align: 'center' });
          bx += boxW + gap;
        });
        oy += boxH + gap;
      });
      y = oy + 0.1;
    }

    if (hasImg) {
      c.addImage({ data: img, x: 7.55, y: 1.05, w: 5.05, h: 5.3, sizing: { type: 'cover', w: 5.05, h: 5.3 }, shadow });
    } else if (panel) {
      // Panneau couleur avec une liste d'items (façon "canaux / cibles")
      const px = 7.55, py = 1.05, pw = 5.05, ph = 5.3;
      c.addShape('roundRect', { x: px, y: py, w: pw, h: ph, rectRadius: RADIUS, fill: { color: ACC } });
      let iy = py + 0.35;
      const ptitle = (panel.title || '').toString();
      if (ptitle) { c.addText(ptitle.toUpperCase(), { x: px + 0.35, y: iy, w: pw - 0.7, h: 0.5, fontSize: 13, bold: true, color: 'FFFFFF', charSpacing: 1 }); iy += 0.65; }
      const items = Array.isArray(panel.items) ? panel.items : [];
      const rowH = Math.max(0.55, Math.min(1.1, (ph - (iy - py) - 0.25) / Math.max(1, items.length)));
      items.forEach(it => {
        const label = (it && it.label) ? it.label : (typeof it === 'string' ? it : '');
        const text = (it && it.text) ? it.text : '';
        c.addShape('roundRect', { x: px + 0.35, y: iy + 0.03, w: 0.36, h: 0.36, rectRadius: 0.06, fill: { color: 'FFFFFF' } });
        c.addText('\u2022', { x: px + 0.35, y: iy + 0.03, w: 0.36, h: 0.36, align: 'center', valign: 'middle', fontSize: 16, bold: true, color: ACC });
        const tx = [];
        if (label) tx.push({ text: label, options: { bold: true, color: 'FFFFFF', fontSize: 13, breakLine: true } });
        if (text) tx.push({ text: text, options: { color: 'FFFFFF', fontSize: 11 } });
        c.addText(tx, { x: px + 0.85, y: iy, w: pw - 1.2, h: rowH, valign: 'top', lineSpacingMultiple: 1.05 });
        iy += rowH;
      });
    } else if (callout) {
      // Gros chiffre clé mis en avant (façon "taux de retour")
      const cx = 7.55, cy = 1.05, cw = 5.05, ch = 5.3;
      c.addShape('roundRect', { x: cx, y: cy, w: cw, h: ch, rectRadius: RADIUS, fill: { color: ACC } });
      let iy = cy + 0.7;
      const clabel = (callout.label || '').toString();
      if (clabel) { c.addText(clabel.toUpperCase(), { x: cx + 0.4, y: iy, w: cw - 0.8, h: 0.5, fontSize: 13, bold: true, color: 'FFFFFF', charSpacing: 2, align: 'center' }); iy += 1.0; }
      const cvalue = (callout.value || '').toString();
      if (cvalue) { c.addText(cvalue, { x: cx + 0.3, y: iy, w: cw - 0.6, h: 1.6, fontSize: 58, bold: true, color: 'FFFFFF', align: 'center' }); iy += 1.8; }
      const cnote = (callout.note || '').toString();
      if (cnote) { c.addText(cnote, { x: cx + 0.4, y: iy, w: cw - 0.8, h: 0.8, fontSize: 12, italic: true, color: 'FFFFFF', align: 'center' }); }
    }

    c.addShape('rect', { x: 0.9, y: 7.02, w: 0.18, h: 0.18, fill: { color: ACC } });
    c.addText(title, { x: 1.2, y: 6.98, w: 8, h: 0.3, fontSize: 10, color: MUT });
    c.addText(String(i + 1), { x: 12.3, y: 6.96, w: 0.5, h: 0.3, fontSize: 12, bold: true, color: DARK, align: 'right' });
  });

  const token = crypto.randomBytes(6).toString('hex');
  const fileName = 'presentation-' + token + '.pptx';
  await pres.writeFile({ fileName: path.join(GEN_DIR, fileName) });
  return { title, url: '/download/' + fileName };
}

// Synthèse vocale de bonne qualité (voix IA OpenAI) pour le mode vocal et la lecture à voix haute
app.post('/api/tts', requireAuth, async (req, res) => {
  try {
    if (!OPENAI_API_KEY) return res.status(501).json({ error: 'no_key' });
    const text = String((req.body && req.body.text) || '').slice(0, 4000);
    if (!text.trim()) return res.status(400).json({ error: 'empty' });
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + OPENAI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice: 'shimmer', input: text, response_format: 'mp3' })
    });
    if (!r.ok) { const t = await r.text(); console.error('OpenAI TTS error', r.status, t); return res.status(502).json({ error: 'tts_failed' }); }
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.send(buf);
  } catch (e) {
    console.error('tts route error', e);
    res.status(502).json({ error: 'tts_failed' });
  }
});

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
  else if (file && file.kind === 'pptx' && file.data) fileKind = 'pptx';
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
  let pptxBuffer = null; // gardé en mémoire si un .pptx est joint, pour un éventuel remplissage de modèle fidèle
  let pptxParagraphList = null;
  let pptxUniqueTexts = null;
  let refImage = null; // image jointe (ex: logo) réutilisable comme référence pour generate_image
  if (fileKind === 'image') {
    blocks.push({ type: 'image', source: { type: 'base64', media_type: file.media_type, data: file.data } });
    refImage = { data: file.data, media_type: file.media_type };
  } else if (fileKind === 'pdf') {
    blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: file.data } });
  } else if (fileKind === 'text') {
    const nm = (file.name || 'fichier').slice(0, 120);
    textForAI = 'Fichier joint "' + nm + '" :\n\n' + file.text.slice(0, 100000) + (text ? '\n\n' + text : '');
  } else if (fileKind === 'pptx') {
    const nm = (file.name || 'presentation.pptx').slice(0, 120);
    try {
      pptxBuffer = Buffer.from(file.data, 'base64');
      const slides = await extractPptxText(pptxBuffer);
      const body = slides.map((t, i) => 'Slide ' + (i + 1) + ': ' + (t || '(vide)')).join('\n');
      pptxParagraphList = await extractPptxParagraphs(pptxBuffer);
      const seenTexts = new Set();
      const uniqueTexts = [];
      for (const p of pptxParagraphList) { if (!seenTexts.has(p.text)) { seenTexts.add(p.text); uniqueTexts.push(p.text); } }
      pptxUniqueTexts = uniqueTexts;
      const uniqueListStr = uniqueTexts.map((t, i) => i + ': ' + t).join('\n');
      textForAI = 'Contenu du PowerPoint joint "' + nm + '" :\n\n' +
        '--- Résumé slide par slide (source d\'informations si tu recrées une présentation avec create_presentation) ---\n' + body.slice(0, 60000) +
        '\n\n--- Liste des ' + uniqueTexts.length + ' textes UNIQUES du fichier (certains se répètent plusieurs fois dans le fichier, ex: texte de remplissage ou nom de marque en pied de page ; À UTILISER PAR DÉFAUT via l\'outil fill_pptx_template avec un tableau "mappings", sauf si l\'utilisateur demande explicitement un style/design différent de l\'original) ---\n' + uniqueListStr.slice(0, 60000) +
        (text ? '\n\n' + text : '');
    } catch (e) {
      textForAI = 'Le fichier PowerPoint joint "' + nm + '" n\'a pas pu être lu (format inattendu).' + (text ? '\n\n' + text : '');
    }
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
    description: "Génère un vrai fichier PowerPoint (.pptx) au design professionnel façon Canva/consultant, avec une grande variété de mises en page. Utilise cet outil UNIQUEMENT quand l'utilisateur veut créer/faire/générer une présentation, un diaporama, un PowerPoint ou des slides (sinon réponds normalement). C'est ton point fort : sois ambitieux et VARIE OBLIGATOIREMENT la structure. N'utilise JAMAIS de simples puces sur toutes les slides. Blocs disponibles par slide (combine-les selon le contenu, choisis 1 à 3 blocs visuels par slide) : lead/subtext/body (texte d'intro), bullets (puces courtes), cards (grille de 3 à 6 cartes icône+titre+texte : offre, produits, atouts, outils), panel (encart couleur à droite avec une liste de points : canaux, cibles, critères, objectifs), table (tableau à en-tête colorée : indicateurs, résultats chiffrés), callout (immense chiffre mis en avant : taux, résultat clé), stats (2-3 chiffres côte à côte), badges (étiquette + description), steps (étapes numérotées/lettrées en liste verticale : méthode, processus, script d'appel), bars (barres de comparaison objectif vs réalisé avec pourcentage), timeline (planning/Gantt sur plusieurs périodes), org (organigramme avec une personne 'top' et des lignes de boîtes, mets highlight:true sur la personne à mettre en avant). Deux types de slides PLEINE PAGE pour rythmer une présentation de plus de 6 slides : divider (page de transition colorée avec icône+titre, pour ouvrir une nouvelle partie) et quote (page colorée avec une accroche/citation forte dans un encart blanc, pour marquer les esprits). Une slide de contenu classique ne doit JAMAIS rester avec juste un titre et 3 lignes : enrichis-la toujours d'au moins un bloc visuel. N'utilise pas image_query sur une slide qui a déjà panel, callout, divider ou quote. Choisis une couleur de marque (accent) cohérente avec le sujet. 7 à 14 slides selon la richesse du sujet, en alternant les types de blocs d'une slide à l'autre pour que ça ne se ressemble jamais deux fois de suite. Utilise le paramètre theme pour changer complètement le style visuel (couleurs de fond, formes, police) si l'utilisateur n'est pas content du rendu précédent et demande autre chose. Si un fichier PDF ou texte (pas un PowerPoint) a été joint, utilise-le comme SOURCE D'INFORMATIONS et construis une présentation avec TA PROPRE structure et TON PROPRE style. ATTENTION : si un fichier PowerPoint (.pptx) a été joint, n'utilise PAS cet outil par défaut — utilise fill_pptx_template à la place, qui reprend le fichier exact. N'utilise create_presentation avec un .pptx joint QUE si l'utilisateur demande explicitement un rendu différent de l'original (ex: \"fais un autre style\", \"change complètement le design\", \"je ne veux pas garder cette mise en page\").",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Titre de la présentation' },
        subtitle: { type: 'string', description: 'Sous-titre / accroche (slide de titre)' },
        accent: { type: 'string', description: 'Couleur de marque en hexa SANS # (ex: C0392B). Cohérente avec le sujet.' },
        theme: { type: 'string', enum: ['canva', 'dark', 'sharp', 'bold'], description: "Style visuel global. 'canva' = clair et arrondi (polyvalent, corporate). 'dark' = fond sombre élégant (tech, gaming, sujets modernes/perso). 'sharp' = sobre, coins carrés, police sérif (Georgia), look éditorial/corporate strict. 'bold' = coins très arrondis, police Verdana, look impactant/fun. NE CHOISIS PAS TOUJOURS 'canva' : adapte le theme à l'AMBIANCE du sujet à chaque nouvelle présentation (un sujet pro/BTP/finance appelle plutôt canva/sharp, un sujet fun/perso/jeu vidéo/lifestyle appelle plutôt bold/dark). Si l'utilisateur dit qu'il n'aime pas le rendu et veut un style différent, choisis un theme DIFFÉRENT de celui utilisé dans le message précédent." },
        card_style: { type: 'string', enum: ['square', 'circle', 'bar', 'minimal'], description: "Style de dessin des cartes (bloc cards) : 'square' = icône carrée en haut à gauche. 'circle' = icône ronde centrée, tout centré. 'bar' = bandeau de couleur en haut de la carte. 'minimal' = pas de fond de carte, juste un trait de couleur sur le côté. VARIE ce choix d'une présentation à l'autre pour ne jamais donner deux fois le même rendu de suite." },
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
              stats: { type: 'array', description: 'Chiffres clés côte à côte, 2 ou 3 max (optionnel)', items: { type: 'object', properties: { value: { type: 'string', description: 'Le chiffre (ex: "2 Md€")' }, label: { type: 'string', description: 'Ce que représente le chiffre' } }, required: ['value', 'label'] } },
              cards: { type: 'array', description: 'Grille de cartes avec icône (3 à 6 cartes, idéal pour une offre, des familles de produits, des atouts, des outils utilisés)', items: { type: 'object', properties: { icon: { type: 'string', description: 'Un seul emoji représentatif (ex: 🔧, 📦, ⚡)' }, title: { type: 'string' }, text: { type: 'string', description: 'Description courte (1 phrase)' } }, required: ['title', 'text'] } },
              panel: { type: 'object', description: "Encart de couleur à droite de la slide avec une liste de points (remplace image_query). Idéal pour les canaux, les cibles, les critères, les objectifs.", properties: { title: { type: 'string', description: 'Titre de l\'encart, en majuscules' }, items: { type: 'array', items: { type: 'object', properties: { label: { type: 'string', description: 'Titre court du point' }, text: { type: 'string', description: 'Détail du point' } }, required: ['label'] } } }, required: ['items'] },
              table: { type: 'object', description: "Tableau avec en-tête colorée, idéal pour des indicateurs/résultats chiffrés.", properties: { headers: { type: 'array', items: { type: 'string' }, description: 'Titres des colonnes (optionnel)' }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'Lignes du tableau, chaque ligne étant un tableau de cellules texte' } }, required: ['rows'] },
              callout: { type: 'object', description: "Encart de couleur à droite avec un immense chiffre clé mis en avant (remplace image_query et panel). Idéal pour un taux de conversion, un résultat marquant.", properties: { label: { type: 'string', description: 'Petit texte au-dessus du chiffre (ex: "TAUX DE RETOUR")' }, value: { type: 'string', description: 'Le chiffre en grand (ex: "26,7 %")' }, note: { type: 'string', description: 'Petite note en dessous (optionnel)' } }, required: ['value'] },
              steps: { type: 'array', description: "Étapes numérotées/lettrées en liste verticale (méthode, processus, script). Ex: méthode CROC avec les lettres C, R, O, C.", items: { type: 'object', properties: { letter: { type: 'string', description: 'Lettre ou numéro affiché dans le badge coloré (ex: "C", "1")' }, title: { type: 'string' }, text: { type: 'string' } }, required: ['title'] } },
              bars: { type: 'array', description: "Barres de comparaison horizontales (objectif vs réalisé, avec pourcentage).", items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number', description: 'Valeur atteinte' }, max: { type: 'number', description: 'Valeur de référence (100 = pourcentage direct)' }, display: { type: 'string', description: 'Texte affiché à droite (ex: "120 %")' }, note: { type: 'string', description: 'Petite note sous la barre (ex: "12/10")' } }, required: ['label', 'value'] } },
              timeline: { type: 'object', description: "Planning / diagramme de Gantt sur plusieurs périodes.", properties: { periods: { type: 'array', items: { type: 'string' }, description: 'Noms des colonnes de temps (ex: ["Semaine 1","Semaine 2","Semaine 3"])' }, rows: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, start: { type: 'number', description: 'Période de début (1 = première période)' }, end: { type: 'number', description: 'Période de fin (incluse)' } }, required: ['label', 'start', 'end'] } } }, required: ['rows'] },
              org: { type: 'object', description: "Organigramme : une personne au sommet puis des lignes de boîtes en dessous.", properties: { top: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' } } }, rows: { type: 'array', description: 'Chaque élément est une ligne (un tableau de personnes affichées côte à côte)', items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, role: { type: 'string' }, highlight: { type: 'boolean', description: 'true pour faire ressortir cette personne en couleur' } }, required: ['name'] } } } }, required: ['rows'] },
              divider: { type: 'boolean', description: "Mets true pour que cette slide soit une page de transition PLEINE COULEUR (icône + titre + sous-titre centrés), sans autre contenu. Utilise title, subtext, icon (un emoji)." },
              icon: { type: 'string', description: "Emoji utilisé par les slides divider et quote" },
              quote: { type: 'string', description: "Si rempli, cette slide devient une page PLEINE COULEUR avec cette accroche/citation forte affichée en grand dans un encart blanc. Utilise aussi title, label, icon, note." },
              note: { type: 'string', description: "Petite note italique en bas de la slide quote (optionnel)" },
              image_query: { type: 'string', description: "Mots-clés EN ANGLAIS pour la photo de cette slide (à éviter si panel, callout, divider ou quote est utilisé)" }
            },
            required: ['title']
          }
        }
      },
      required: ['title', 'slides']
    }
  }];

  if (OPENAI_API_KEY) {
    tools.push({
      name: 'generate_image',
      description: "Utilise cet outil quand l'utilisateur demande de générer, créer, dessiner une image, un visuel, un logo ou une illustration qui reste une IMAGE FIGÉE (comme une photo, non modifiable élément par élément). Si une image a été jointe au message (ex: un logo à intégrer), elle sera automatiquement utilisée comme référence visuelle : mentionne dans le prompt comment l'utiliser. Écris un prompt DÉTAILLÉ ET PRÉCIS, de préférence en anglais, décrivant le sujet, le style, la composition, les couleurs, et tout texte exact entre guillemets. N'utilise PAS cet outil pour un flyer/une affiche que l'utilisateur veut pouvoir modifier ensuite (texte à déplacer, dans Canva ou PowerPoint) : utilise generate_flyer à la place dans ce cas.",
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Description détaillée de l\'image à générer, si possible en anglais, avec le texte exact entre guillemets s\'il y en a.' },
          size: { type: 'string', enum: ['1024x1024', '1024x1536', '1536x1024'], description: '1024x1024 = carré, 1024x1536 = portrait, 1536x1024 = paysage' }
        },
        required: ['prompt']
      }
    });
    tools.push({
      name: 'generate_flyer',
      description: "Utilise cet outil PAR DÉFAUT pour un flyer, une affiche ou un poster événementiel/promotionnel — car l'utilisateur veut ensuite pouvoir déplacer/modifier chaque élément (texte, logo) dans PowerPoint ou Canva. Le résultat combine : une photo/ambiance de fond générée par IA (SANS texte dedans), un titre et des infos pratiques en VRAI texte éditable par-dessus, et le logo de l'utilisateur (s'il en a joint un) posé comme élément séparé déplaçable. Le prompt d'image ne doit décrire QUE l'ambiance/le décor (scène, lumière, couleurs), avec une zone naturellement plus sombre dans le tiers inférieur pour que le texte reste lisible, et ne doit JAMAIS inclure de texte à écrire dans l'image (ajoute toujours 'no text, no words, no writing' à la fin du prompt). N'utilise PAS cet outil si l'utilisateur veut juste une belle image figée sans avoir besoin de la modifier ensuite : utilise generate_image dans ce cas.",
      input_schema: {
        type: 'object',
        properties: {
          image_prompt: { type: 'string', description: "Description de l'ambiance/du décor de fond uniquement, en anglais, avec une zone sombre en bas pour la lisibilité du texte, sans aucun texte à afficher (ajoute 'no text, no words' à la fin)." },
          title: { type: 'string', description: 'Titre principal du flyer (grand texte)' },
          kicker: { type: 'string', description: 'Court mot-étiquette dans le ruban en haut (ex: "MATCH", "CONCERT"), 1-2 mots max' },
          subtitle: { type: 'string', description: 'Sous-titre ou accroche (optionnel)' },
          details: { type: 'array', items: { type: 'string' }, description: 'Lignes d\'infos pratiques (date, lieu, prix...), chacune affichée en pilule' },
          accent: { type: 'string', description: 'Couleur de marque en hexa SANS # (ex: C0392B), utilisée pour le ruban, le dégradé et les pilules' }
        },
        required: ['image_prompt', 'title']
      }
    });
  }

  if (fileKind === 'pptx' && pptxUniqueTexts && pptxUniqueTexts.length) {
    tools.push({
      name: 'fill_pptx_template',
      description: "UTILISE CET OUTIL PAR DÉFAUT dès qu'un fichier PowerPoint (.pptx) est joint au message et que l'utilisateur veut l'adapter, le modifier, le reprendre, changer des infos dedans (nom d'entreprise, chiffres, texte) — même s'il ne précise pas explicitement 'garde le design'. C'est le comportement ATTENDU PAR DÉFAUT pour tout .pptx joint : il faut préserver le design, les couleurs, les images et la mise en page d'origine, et changer seulement le texte. N'utilise PAS cet outil, et utilise create_presentation à la place, SEULEMENT si l'utilisateur demande explicitement un style/design différent de l'original (ex: \"fais un style différent\", \"change complètement le design\", \"je veux un autre rendu que celui-ci\"). Fournis un tableau 'mappings' avec une entrée { original, replacement } pour CHAQUE texte de la liste des " + pptxUniqueTexts.length + " textes uniques fournie dans le message (même si le texte doit rester identique : mets alors replacement = original). Le champ 'original' doit être une copie EXACTE (caractère pour caractère) d'un texte de la liste fournie, sinon le remplacement ne sera pas appliqué. Garde une longueur de texte proche de l'original pour chaque remplacement, pour ne pas déborder de son emplacement (le design et les positions ne changent pas). L'ordre des entrées dans le tableau n'a pas d'importance.",
      input_schema: {
        type: 'object',
        properties: {
          mappings: {
            type: 'array',
            description: 'Une entrée par texte unique de la liste fournie (' + pptxUniqueTexts.length + ' attendues).',
            items: {
              type: 'object',
              properties: {
                original: { type: 'string', description: 'Texte original EXACT, copié depuis la liste fournie dans le message' },
                replacement: { type: 'string', description: 'Nouveau texte (identique à original si rien ne doit changer)' }
              },
              required: ['original', 'replacement']
            }
          }
        },
        required: ['mappings']
      }
    });
  }

  let systemToUse = SYSTEM_PROMPT;
  if (mode === 'correct') {
    systemToUse = "Tu es un correcteur de français professionnel. On te donne un texte : tu dois le CORRIGER, pas répondre à son contenu. Corrige l'orthographe, la grammaire, la conjugaison, la ponctuation, la typographie, et améliore la formulation pour que ce soit clair et naturel, SANS changer le sens ni le ton. Réponds en Markdown, exactement dans ce format :\n\n## ✅ Texte corrigé\n\n(le texte entièrement corrigé)\n\n## ✍️ Principales corrections\n\n- (liste courte et simple des fautes ou reformulations importantes ; si tout était déjà correct, écris « Rien à signaler, ton texte était déjà correct 👍 »)";
  }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 8192, system: systemToUse, messages, tools })
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
    else if (fileKind === 'pptx') marker = '📊 [' + (file.name || 'PowerPoint') + ']';
    const storedUser = marker ? (text ? text + '\n' + marker : marker) : text;

    // L'IA a-t-elle décidé de créer une présentation (nouveau style) ?
    const toolUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'create_presentation');
    if (toolUse) {
      const pres = await buildPptx(toolUse.input || {});
      const pre = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      const reply = (pre ? pre + '\n\n' : '') + 'Voilà ✨ Ta présentation « ' + pres.title + ' » est prête !\n\n[📊 Télécharger le PowerPoint](' + pres.url + ')\n\nTu peux me demander d\'ajouter des slides, d\'en enlever ou de changer le contenu.';
      db.prepare('INSERT INTO messages (user_id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)').run(u.id, convId, 'user', storedUser, now);
      db.prepare('INSERT INTO messages (user_id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)').run(u.id, convId, 'assistant', reply, now + 1);
      db.prepare('UPDATE users SET msg_used = msg_used + 1 WHERE id = ?').run(u.id);
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
      return res.json({ reply, download: { url: pres.url, title: pres.title }, used: u.msg_used + 1, limit, conversation_id: convId, title: conv.title });
    }

    // L'IA a-t-elle décidé de remplir le modèle pptx joint tel quel (même design) ?
    const fillUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'fill_pptx_template');
    if (fillUse && pptxBuffer) {
      const mappings = (fillUse.input && Array.isArray(fillUse.input.mappings)) ? fillUse.input.mappings : [];
      const { buffer: outBuf, replacedCount, totalCount } = await fillPptxTemplateByMap(pptxBuffer, mappings);
      const token = crypto.randomBytes(6).toString('hex');
      const fileName = 'presentation-' + token + '.pptx';
      fs.writeFileSync(path.join(GEN_DIR, fileName), outBuf);
      const presTitle = (file.name || 'Présentation').replace(/\.pptx$/i, '');
      const pre = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      let reply = (pre ? pre + '\n\n' : '') + 'Voilà ✨ J\'ai repris exactement ton modèle et changé le contenu.\n\n[📊 Télécharger le PowerPoint](/download/' + fileName + ')';
      if (totalCount > 0 && replacedCount < totalCount * 0.6) {
        reply += '\n\n⚠️ Seulement ' + replacedCount + ' texte(s) sur ' + totalCount + ' ont pu être remplacés — réessaie ou reformule ta demande si le résultat ne te convient pas.';
      }
      db.prepare('INSERT INTO messages (user_id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)').run(u.id, convId, 'user', storedUser, now);
      db.prepare('INSERT INTO messages (user_id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)').run(u.id, convId, 'assistant', reply, now + 1);
      db.prepare('UPDATE users SET msg_used = msg_used + 1 WHERE id = ?').run(u.id);
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
      return res.json({ reply, download: { url: '/download/' + fileName, title: presTitle }, used: u.msg_used + 1, limit, conversation_id: convId, title: conv.title });
    }

    // L'IA a-t-elle décidé de générer une image ?
    const imgUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'generate_image');
    if (imgUse) {
      try {
        const quality = u.plan === 'pro' ? 'high' : 'medium';
        const prompt = (imgUse.input && imgUse.input.prompt) ? imgUse.input.prompt : text;
        const size = (imgUse.input && imgUse.input.size) || '1024x1024';
        const buf = await generateImageOpenAI({ prompt, quality, size, refData: refImage && refImage.data, refMediaType: refImage && refImage.media_type });
        const token = crypto.randomBytes(6).toString('hex');
        const fileName = 'image-' + token + '.png';
        fs.writeFileSync(path.join(GEN_DIR, fileName), buf);
        const pre = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        const qualityNote = u.plan === 'pro' ? '' : '\n\n💡 Qualité "standard" (forfait gratuit). Passe au Pro pour la meilleure qualité d\'image.';
        const reply = (pre ? pre + '\n\n' : '') + 'Voilà ton image ✨\n\n![Image générée](/download/' + fileName + ')\n\n[⬇️ Télécharger l\'image](/download/' + fileName + ')' + qualityNote;
        db.prepare('INSERT INTO messages (user_id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)').run(u.id, convId, 'user', storedUser, now);
        db.prepare('INSERT INTO messages (user_id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)').run(u.id, convId, 'assistant', reply, now + 1);
        db.prepare('UPDATE users SET msg_used = msg_used + 1 WHERE id = ?').run(u.id);
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
        return res.json({ reply, image: { url: '/download/' + fileName }, used: u.msg_used + 1, limit, conversation_id: convId, title: conv.title });
      } catch (e) {
        console.error('generate_image error', e);
        return res.status(502).json({ error: 'image', message: "La génération d'image a échoué (vérifie la clé OpenAI et le crédit disponible)." });
      }
    }

    // L'IA a-t-elle décidé de créer un flyer (même qualité que generate_image, livré en PowerPoint modifiable) ?
    const flyerUse = (data.content || []).find(b => b.type === 'tool_use' && b.name === 'generate_flyer');
    if (flyerUse) {
      try {
        const quality = u.plan === 'pro' ? 'high' : 'medium';
        const inp = flyerUse.input || {};
        const imagePrompt = (inp.image_prompt || '') + ', no text, no words, no writing, no letters, no logos';
        const buf = await generateImageOpenAI({ prompt: imagePrompt, quality, size: '1024x1536' }); // pas de refData : le logo reste un élément à part, pas fondu dans le fond
        const logoBuffer = refImage ? Buffer.from(refImage.data, 'base64') : null;
        const { url } = await buildFlyerPptx({ imageBuffer: buf, title: inp.title, kicker: inp.kicker, subtitle: inp.subtitle, details: inp.details, accent: inp.accent, logoBuffer, logoMediaType: refImage && refImage.media_type });
        const pre = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
        const qualityNote = u.plan === 'pro' ? '' : '\n\n💡 Qualité "standard" (forfait gratuit). Passe au Pro pour la meilleure qualité d\'image.';
        const reply = (pre ? pre + '\n\n' : '') + 'Voilà ton flyer ✨ (fichier PowerPoint : chaque élément — fond, titre, texte, logo — est déplaçable/modifiable séparément, et importable dans Canva)\n\n[📊 Télécharger le flyer](' + url + ')' + qualityNote;
        db.prepare('INSERT INTO messages (user_id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)').run(u.id, convId, 'user', storedUser, now);
        db.prepare('INSERT INTO messages (user_id, conversation_id, role, content, created_at) VALUES (?,?,?,?,?)').run(u.id, convId, 'assistant', reply, now + 1);
        db.prepare('UPDATE users SET msg_used = msg_used + 1 WHERE id = ?').run(u.id);
        db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, convId);
        return res.json({ reply, download: { url, title: inp.title || 'Flyer' }, used: u.msg_used + 1, limit, conversation_id: convId, title: conv.title });
      } catch (e) {
        console.error('generate_flyer error', e);
        return res.status(502).json({ error: 'flyer', message: "La génération du flyer a échoué (vérifie la clé OpenAI et le crédit disponible)." });
      }
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
  if (!/^[\w.-]+\.(pptx|docx|pdf|png|jpg|jpeg)$/.test(name)) return res.status(400).end();
  const fp = path.join(GEN_DIR, name);
  if (!fs.existsSync(fp)) return res.status(404).end();
  if (/\.(png|jpg|jpeg)$/.test(name)) return res.sendFile(fp); // affichage inline (balise <img>)
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

app.post('/admin/delete', requireAuth, requireAdmin, (req, res) => {
  const id = parseInt(req.body.userId, 10);
  if (id && id !== req.session.userId) { // sécurité : un admin ne peut pas se supprimer lui-même depuis cette page
    db.prepare('DELETE FROM messages WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM conversations WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
  res.redirect('/admin');
});

// ===================== DIAGNOSTIC =====================
app.get('/health', (req, res) => {
  const info = { ok: true, model: MODEL, dataDir: DATA_DIR, node: process.version, hasApiKey: !!ANTHROPIC_API_KEY, hasOpenAiKey: !!OPENAI_API_KEY, mailEnabled: MAIL_ENABLED };
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
