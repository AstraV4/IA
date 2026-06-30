const $ = (id) => document.getElementById(id);
const messages = $('messages');
const input = $('input');
const send = $('send');

function addMsg(text, who) {
  const empty = $('empty'); if (empty) empty.remove();
  const div = document.createElement('div');
  div.className = 'msg ' + (who === 'user' ? 'user' : 'ai');
  div.textContent = text;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

// hauteur auto du textarea
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
});

async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;
  input.value = ''; input.style.height = 'auto';
  addMsg(text, 'user');
  send.disabled = true;
  const typing = addMsg('…', 'ai'); typing.classList.add('typing');

  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    const data = await r.json();
    typing.remove();
    if (r.status === 402) {
      const d = addMsg("🔒 " + (data.message || "Limite atteinte.") + " Passe au Pro pour continuer.", 'ai');
      const a = document.createElement('a'); a.href = '/account'; a.textContent = ' → Voir les forfaits';
      a.style.color = '#818cf8'; d.appendChild(a);
    } else if (!r.ok) {
      addMsg("⚠️ " + (data.message || "Une erreur est survenue."), 'ai');
    } else {
      addMsg(data.reply, 'ai');
      if (typeof data.used === 'number') $('used').textContent = data.used;
    }
  } catch (e) {
    typing.remove();
    addMsg("⚠️ Erreur de connexion.", 'ai');
  }
  send.disabled = false;
  input.focus();
}

send.addEventListener('click', sendMessage);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

const clearBtn = $('clear');
if (clearBtn) clearBtn.addEventListener('click', async () => {
  if (!confirm('Effacer toute la conversation ?')) return;
  await fetch('/api/clear', { method: 'POST' });
  location.reload();
});

messages.scrollTop = messages.scrollHeight;
