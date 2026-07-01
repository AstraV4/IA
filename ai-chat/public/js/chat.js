const $ = (id) => document.getElementById(id);
const messages = $('messages');
const input = $('input');
const send = $('send');
const fileInput = $('file');
const attach = $('attach');
const preview = $('preview');
const previewImg = $('preview-img');
const previewChip = $('preview-chip');
const convList = $('conv-list');

let pendingFile = null; // { kind, media_type, data, text, name, url }

// ---------- Sidebar mobile ----------
const side = $('side'), overlay = $('side-overlay');
$('menu-btn').addEventListener('click', () => { side.classList.add('open'); overlay.classList.add('show'); });
overlay.addEventListener('click', () => { side.classList.remove('open'); overlay.classList.remove('show'); });
function closeSide() { side.classList.remove('open'); overlay.classList.remove('show'); }

// ---------- Nouvelle conversation ----------
$('new-conv').addEventListener('click', () => {
  window.CURRENT = null;
  messages.innerHTML = '<div class="empty" id="empty"><div class="empty-icon">✦</div><h3>Nouvelle conversation</h3><p>Pose ta question, ou envoie un fichier.</p></div>';
  document.querySelectorAll('.conv.active').forEach(c => c.classList.remove('active'));
  clearFile(); closeSide(); input.focus();
});

// ---------- Renommer / Supprimer ----------
convList.addEventListener('click', async (e) => {
  const edit = e.target.closest('.conv-edit');
  const del = e.target.closest('.conv-del');
  if (edit) {
    e.preventDefault(); e.stopPropagation();
    const id = edit.getAttribute('data-edit');
    const row = edit.closest('.conv');
    const cur = row.querySelector('.conv-t').textContent;
    const title = prompt('Nouveau titre :', cur);
    if (title && title.trim()) {
      const r = await fetch('/api/conversations/' + id + '/rename', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim() })
      });
      const d = await r.json();
      row.querySelector('.conv-t').textContent = d.title || title.trim();
    }
    return;
  }
  if (del) {
    e.preventDefault(); e.stopPropagation();
    if (!confirm('Supprimer cette conversation ?')) return;
    const id = del.getAttribute('data-del');
    await fetch('/api/conversations/' + id + '/delete', { method: 'POST' });
    if (String(window.CURRENT) === String(id)) { window.location = '/chat'; return; }
    const el = del.closest('.conv'); if (el) el.remove();
  }
});

// ---------- Fichiers (image / pdf / texte) ----------
const TEXT_EXT = ['.txt','.md','.csv','.json','.js','.ts','.py','.html','.css','.xml','.log','.java','.c','.cpp','.rb','.go','.php','.sql','.yml','.yaml','.sh','.ini','.env','.rs','.kt','.swift'];
function classify(f) {
  const t = f.type || ''; const n = (f.name || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (t.startsWith('text/') || TEXT_EXT.some(e => n.endsWith(e))) return 'text';
  return 'other';
}
attach.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (!f) return;
  if (f.size > 10 * 1024 * 1024) { alert('Fichier trop lourd (max 10 Mo).'); fileInput.value = ''; return; }
  const kind = classify(f);
  if (kind === 'other') { alert("Ce type de fichier ne peut pas être lu par l'IA.\nFormats acceptés : images, PDF, et fichiers texte/code."); fileInput.value = ''; return; }
  const reader = new FileReader();
  if (kind === 'text') {
    reader.onload = () => { pendingFile = { kind, text: reader.result, name: f.name }; showPreview(kind, null, f.name); };
    reader.readAsText(f);
  } else {
    reader.onload = () => {
      const url = reader.result;
      pendingFile = { kind, media_type: f.type, data: url.split(',')[1], name: f.name, url };
      showPreview(kind, kind === 'image' ? url : null, f.name);
    };
    reader.readAsDataURL(f);
  }
});
function showPreview(kind, url, name) {
  if (kind === 'image') {
    previewImg.src = url; previewImg.hidden = false; previewChip.hidden = true;
  } else {
    $('preview-icon').textContent = kind === 'pdf' ? '📄' : '📎';
    $('preview-name').textContent = name;
    previewChip.hidden = false; previewImg.hidden = true;
  }
  preview.hidden = false;
}
$('preview-remove').addEventListener('click', clearFile);
function clearFile() { pendingFile = null; preview.hidden = true; previewImg.hidden = true; previewChip.hidden = true; fileInput.value = ''; }

// ---------- Bulles ----------
function addUser(text, file) {
  const empty = $('empty'); if (empty) empty.remove();
  const row = document.createElement('div'); row.className = 'row user';
  const msg = document.createElement('div'); msg.className = 'msg user';
  if (file && file.kind === 'image' && file.url) {
    const im = document.createElement('img'); im.src = file.url; im.className = 'msg-img'; msg.appendChild(im);
  } else if (file) {
    const chip = document.createElement('div'); chip.className = 'filechip';
    chip.innerHTML = '<span class="fi">' + (file.kind === 'pdf' ? '📄' : '📎') + '</span><span class="fn"></span>';
    chip.querySelector('.fn').textContent = file.name || 'fichier';
    msg.appendChild(chip);
  }
  if (text) { const t = document.createElement('div'); t.textContent = text; msg.appendChild(t); }
  row.appendChild(msg); messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
}
function addAI(text) {
  const row = document.createElement('div'); row.className = 'row ai';
  row.innerHTML = '<div class="ava">✦</div>';
  const msg = document.createElement('div'); msg.className = 'msg ai'; msg.textContent = text;
  row.appendChild(msg); messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
  return msg;
}
function addTyping() {
  const row = document.createElement('div'); row.className = 'row ai typing-row';
  row.innerHTML = '<div class="ava">✦</div><div class="msg ai typing"><span></span><span></span><span></span></div>';
  messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
  return row;
}
function addConvToSidebar(id, title) {
  document.querySelectorAll('.conv.active').forEach(c => c.classList.remove('active'));
  const a = document.createElement('a');
  a.className = 'conv active'; a.href = '/chat?c=' + id; a.setAttribute('data-id', id);
  a.innerHTML = '<span class="conv-t"></span><span class="conv-actions"><button class="conv-edit" type="button" data-edit="' + id + '" title="Renommer">✏️</button><button class="conv-del" type="button" data-del="' + id + '" title="Supprimer">🗑</button></span>';
  a.querySelector('.conv-t').textContent = title || 'Conversation';
  convList.prepend(a);
}

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
});

async function sendMessage() {
  const text = input.value.trim();
  if (!text && !pendingFile) return;
  const file = pendingFile;
  addUser(text, file);
  input.value = ''; input.style.height = 'auto';
  clearFile();
  send.disabled = true;
  const typing = addTyping();

  const payloadFile = file ? (file.kind === 'text'
    ? { kind: 'text', text: file.text, name: file.name }
    : { kind: file.kind, media_type: file.media_type, data: file.data, name: file.name }) : undefined;

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, conversation_id: window.CURRENT || undefined, file: payloadFile })
    });
    const data = await r.json();
    typing.remove();
    if (r.status === 402) {
      const m = addAI("🔒 " + (data.message || "Limite atteinte.") + " Passe au Pro pour continuer.");
      const a = document.createElement('a'); a.href = '/account'; a.textContent = ' → Voir comment';
      a.style.color = 'var(--accent)'; a.style.marginLeft = '4px'; m.appendChild(a);
    } else if (!r.ok) {
      addAI("⚠️ " + (data.message || "Une erreur est survenue."));
    } else {
      addAI(data.reply);
      if (!window.CURRENT && data.conversation_id) { window.CURRENT = data.conversation_id; addConvToSidebar(data.conversation_id, data.title); }
      if (typeof data.used === 'number') {
        $('used').textContent = data.used;
        const fill = $('quota-fill'); if (fill) fill.style.width = Math.min(100, Math.round(data.used / window.LIMIT * 100)) + '%';
      }
    }
  } catch (e) {
    typing.remove();
    addAI("⚠️ Erreur de connexion.");
  }
  send.disabled = false;
  input.focus();
}

send.addEventListener('click', sendMessage);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

messages.scrollTop = messages.scrollHeight;
