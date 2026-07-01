const $ = (id) => document.getElementById(id);
const messages = $('messages');
const input = $('input');
const send = $('send');
const fileInput = $('file');
const attach = $('attach');
const preview = $('preview');
const previewImg = $('preview-img');
const convList = $('conv-list');

let pendingImage = null;

// ---------- Sidebar mobile ----------
const side = $('side'), overlay = $('side-overlay');
function openSide() { side.classList.add('open'); overlay.classList.add('show'); }
function closeSide() { side.classList.remove('open'); overlay.classList.remove('show'); }
$('menu-btn').addEventListener('click', openSide);
overlay.addEventListener('click', closeSide);

// ---------- Nouvelle conversation ----------
$('new-conv').addEventListener('click', () => {
  window.CURRENT = null;
  messages.innerHTML = '<div class="empty" id="empty"><div class="empty-icon">✨</div><h3>Nouvelle conversation</h3><p>Pose ta question, ou envoie une photo.</p></div>';
  document.querySelectorAll('.conv.active').forEach(c => c.classList.remove('active'));
  clearImage(); closeSide(); input.focus();
});

// ---------- Suppression de conversation ----------
convList.addEventListener('click', async (e) => {
  const del = e.target.closest('.conv-del');
  if (!del) return;
  e.preventDefault(); e.stopPropagation();
  if (!confirm('Supprimer cette conversation ?')) return;
  const id = del.getAttribute('data-del');
  await fetch('/api/conversations/' + id + '/delete', { method: 'POST' });
  if (String(window.CURRENT) === String(id)) { window.location = '/chat'; return; }
  const el = del.closest('.conv'); if (el) el.remove();
});

// ---------- Ajout de photo ----------
attach.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (!f) return;
  if (f.size > 10 * 1024 * 1024) { alert('Image trop lourde (max 10 Mo).'); fileInput.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    const url = reader.result;
    pendingImage = { media_type: f.type, data: url.split(',')[1], url };
    previewImg.src = url; preview.hidden = false;
  };
  reader.readAsDataURL(f);
});
$('preview-remove').addEventListener('click', clearImage);
function clearImage() { pendingImage = null; preview.hidden = true; fileInput.value = ''; }

// ---------- Bulles ----------
function addUser(text, imgUrl) {
  const empty = $('empty'); if (empty) empty.remove();
  const row = document.createElement('div'); row.className = 'row user';
  const msg = document.createElement('div'); msg.className = 'msg user';
  if (imgUrl) { const im = document.createElement('img'); im.src = imgUrl; im.className = 'msg-img'; msg.appendChild(im); }
  if (text) { const t = document.createElement('div'); t.textContent = text; msg.appendChild(t); }
  row.appendChild(msg); messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
}
function addAI(text) {
  const row = document.createElement('div'); row.className = 'row ai';
  row.innerHTML = '<div class="ava">✨</div>';
  const msg = document.createElement('div'); msg.className = 'msg ai'; msg.textContent = text;
  row.appendChild(msg); messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
  return msg;
}
function addTyping() {
  const row = document.createElement('div'); row.className = 'row ai typing-row';
  row.innerHTML = '<div class="ava">✨</div><div class="msg ai typing"><span></span><span></span><span></span></div>';
  messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
  return row;
}
function addConvToSidebar(id, title) {
  const empty = convList.querySelector('.conv-empty'); if (empty) empty.remove();
  document.querySelectorAll('.conv.active').forEach(c => c.classList.remove('active'));
  const a = document.createElement('a');
  a.className = 'conv active'; a.href = '/chat?c=' + id; a.setAttribute('data-id', id);
  a.innerHTML = '<span class="conv-t"></span><button class="conv-del" type="button" data-del="' + id + '" title="Supprimer">🗑</button>';
  a.querySelector('.conv-t').textContent = title || 'Conversation';
  convList.prepend(a);
}

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
});

async function sendMessage() {
  const text = input.value.trim();
  if (!text && !pendingImage) return;
  const img = pendingImage;
  addUser(text, img && img.url);
  input.value = ''; input.style.height = 'auto';
  clearImage();
  send.disabled = true;
  const typing = addTyping();

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        conversation_id: window.CURRENT || undefined,
        image: img ? { media_type: img.media_type, data: img.data } : undefined
      })
    });
    const data = await r.json();
    typing.remove();
    if (r.status === 402) {
      const m = addAI("🔒 " + (data.message || "Limite atteinte.") + " Passe au Pro pour continuer.");
      const a = document.createElement('a'); a.href = '/account'; a.textContent = ' → Voir comment';
      a.style.color = '#a5b4fc'; a.style.marginLeft = '4px'; m.appendChild(a);
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
