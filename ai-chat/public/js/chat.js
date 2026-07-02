const $ = (id) => document.getElementById(id);
const thread = $('messages');
const input = $('input');
const send = $('send');
const fileInput = $('file');
const attach = $('attach');
const preview = $('preview');
const previewImg = $('preview-img');
const previewChip = $('preview-chip');
const convList = $('conv-list');

let pendingFile = null;

/* ---------- Thème clair / sombre ---------- */
const themeBtn = document.getElementById('theme-toggle');
function applyTheme(t){
  if(t==='dark'){ document.documentElement.setAttribute('data-theme','dark'); if(themeBtn) themeBtn.textContent='☀️ Thème clair'; }
  else { document.documentElement.removeAttribute('data-theme'); if(themeBtn) themeBtn.textContent='🌙 Thème sombre'; }
}
try{ applyTheme(localStorage.getItem('theme')||'light'); }catch(e){}
if(themeBtn) themeBtn.addEventListener('click', ()=>{ const dark=document.documentElement.getAttribute('data-theme')!=='dark'; try{localStorage.setItem('theme',dark?'dark':'light');}catch(e){} applyTheme(dark?'dark':'light'); });

/* ---------- Recherche de conversations ---------- */
const searchInput = document.getElementById('conv-search');
if(searchInput) searchInput.addEventListener('input', ()=>{
  const q=searchInput.value.toLowerCase();
  document.querySelectorAll('#conv-list .conv').forEach(c=>{ const t=(c.querySelector('.conv-t')||{}).textContent||''; c.style.display=t.toLowerCase().includes(q)?'':'none'; });
});

/* ---------- Suggestions (chips) ---------- */
const EMPTY_HTML = '<div class="empty" id="empty"><div class="empty-icon">✦</div><h3>Nouvelle conversation</h3><p>Pose ta question, ou joins un fichier.</p><div class="suggests"><button class="sug" data-text="Corrige l\'orthographe et la grammaire de ce texte : ">✍️ Corriger un texte</button><button class="sug" data-text="Explique-moi simplement : ">💡 Expliquer un concept</button><button class="sug" data-text="Résume-moi ce document : ">📄 Résumer un document</button><button class="sug" data-text="Aide-moi à coder : ">💻 Aider à coder</button></div></div>';

/* ---------- Markdown -> HTML (sûr : on échappe d'abord) ---------- */
function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function inlineMd(t){
  t = escapeHtml(t);
  t = t.replace(/`([^`]+)`/g,'<code>$1</code>');
  t = t.replace(/\*\*([^*]+?)\*\*/g,'<strong>$1</strong>');
  t = t.replace(/__([^_]+?)__/g,'<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g,'$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  return t;
}
function splitRow(l){ return l.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim()); }
function renderMarkdown(src){
  src = String(src).replace(/\r\n/g,'\n');
  const blocks=[];
  src = src.replace(/```[^\n]*\n?([\s\S]*?)```/g,(m,code)=>{ blocks.push('<pre><code>'+escapeHtml(code.replace(/\n$/,''))+'</code></pre>'); return '\u0000'+(blocks.length-1)+'\u0000'; });
  const lines = src.split('\n'); const out=[]; let i=0;
  while(i<lines.length){
    const line=lines[i];
    const cb=line.match(/^\u0000(\d+)\u0000$/); if(cb){ out.push(blocks[+cb[1]]); i++; continue; }
    if(/^\s*$/.test(line)){ i++; continue; }
    const h=line.match(/^(#{1,6})\s+(.*)$/); if(h){ const lv=h[1].length; out.push('<h'+lv+'>'+inlineMd(h[2].trim())+'</h'+lv+'>'); i++; continue; }
    if(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)){ out.push('<hr>'); i++; continue; }
    if(/\|/.test(line) && i+1<lines.length && /^\s*\|?[\s:\-|]+\|?\s*$/.test(lines[i+1]) && /-/.test(lines[i+1])){
      const header=splitRow(line); i+=2; const rows=[];
      while(i<lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])){ rows.push(splitRow(lines[i])); i++; }
      let t='<table><thead><tr>'+header.map(c=>'<th>'+inlineMd(c)+'</th>').join('')+'</tr></thead><tbody>';
      t+=rows.map(r=>'<tr>'+r.map(c=>'<td>'+inlineMd(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
      out.push(t); continue;
    }
    if(/^\s*[-*+]\s+/.test(line)){ const it=[]; while(i<lines.length && /^\s*[-*+]\s+/.test(lines[i])){ it.push('<li>'+inlineMd(lines[i].replace(/^\s*[-*+]\s+/,''))+'</li>'); i++; } out.push('<ul>'+it.join('')+'</ul>'); continue; }
    if(/^\s*\d+\.\s+/.test(line)){ const it=[]; while(i<lines.length && /^\s*\d+\.\s+/.test(lines[i])){ it.push('<li>'+inlineMd(lines[i].replace(/^\s*\d+\.\s+/,''))+'</li>'); i++; } out.push('<ol>'+it.join('')+'</ol>'); continue; }
    const para=[]; while(i<lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^\u0000\d+\u0000$/.test(lines[i])){ para.push(lines[i]); i++; }
    out.push('<p>'+para.map(inlineMd).join('<br>')+'</p>');
  }
  return out.join('\n');
}
// Bouton "copier" sous une réponse
function addCopy(bodyEl, raw){
  const b=document.createElement('button'); b.className='copy-btn'; b.type='button'; b.textContent='📋 Copier';
  b.addEventListener('click',()=>{ navigator.clipboard.writeText(raw).then(()=>{ b.textContent='✓ Copié'; setTimeout(()=>b.textContent='📋 Copier',1500); }).catch(()=>{}); });
  bodyEl.appendChild(b);
}
// Rendre le Markdown de l'historique au chargement
document.querySelectorAll('.md-raw').forEach(el => { const raw=el.textContent; el.innerHTML = renderMarkdown(raw); el.classList.remove('md-raw'); addCopy(el, raw); });

/* ---------- Sidebar mobile ---------- */
const side = $('side'), overlay = $('side-overlay');
$('menu-btn').addEventListener('click', () => { side.classList.add('open'); overlay.classList.add('show'); });
overlay.addEventListener('click', () => { side.classList.remove('open'); overlay.classList.remove('show'); });
function closeSide(){ side.classList.remove('open'); overlay.classList.remove('show'); }

/* ---------- Nouvelle conversation ---------- */
$('new-conv').addEventListener('click', () => {
  window.CURRENT = null;
  thread.innerHTML = EMPTY_HTML;
  document.querySelectorAll('.conv.active').forEach(c => c.classList.remove('active'));
  clearFile(); closeSide(); input.focus();
});

/* Clic sur une suggestion -> remplit le champ */
thread.addEventListener('click', (e) => {
  const s = e.target.closest('.sug');
  if (!s) return;
  input.value = s.getAttribute('data-text') || '';
  input.focus();
  input.dispatchEvent(new Event('input'));
});

/* ---------- Fenêtre modale ---------- */
const modal = $('modal'), mTitle=$('modal-title'), mMsg=$('modal-msg'), mInput=$('modal-input'), mOk=$('modal-ok'), mCancel=$('modal-cancel');
function openModal(opts){
  return new Promise(resolve=>{
    const hasInput = opts.value !== undefined;
    mTitle.textContent = opts.title || '';
    if(opts.message){ mMsg.textContent=opts.message; mMsg.hidden=false; } else mMsg.hidden=true;
    if(hasInput){ mInput.hidden=false; mInput.value=opts.value||''; } else mInput.hidden=true;
    mOk.textContent = opts.okLabel || 'OK';
    mOk.className = opts.danger ? 'btn btn-danger' : 'btn-primary btn';
    modal.hidden=false;
    if(hasInput) setTimeout(()=>{ mInput.focus(); mInput.select(); },30);
    function done(val){ modal.hidden=true; mOk.removeEventListener('click',ok); mCancel.removeEventListener('click',cancel); document.removeEventListener('keydown',key); modal.removeEventListener('click',overlay); resolve(val); }
    function ok(){ done(hasInput ? mInput.value.trim() : true); }
    function cancel(){ done(hasInput ? null : false); }
    function key(e){ if(e.key==='Escape') cancel(); else if(e.key==='Enter' && hasInput){ e.preventDefault(); ok(); } }
    function overlay(e){ if(e.target===modal) cancel(); }
    mOk.addEventListener('click',ok); mCancel.addEventListener('click',cancel); document.addEventListener('keydown',key); modal.addEventListener('click',overlay);
  });
}

/* ---------- Renommer / Supprimer ---------- */
convList.addEventListener('click', async (e) => {
  const edit = e.target.closest('.conv-edit');
  const del = e.target.closest('.conv-del');
  const pin = e.target.closest('.conv-pin');
  if (pin) {
    e.preventDefault(); e.stopPropagation();
    const id = pin.getAttribute('data-pin');
    try { await fetch('/api/conversations/' + id + '/pin', { method:'POST' }); } catch(err){}
    window.location = '/chat' + (window.CURRENT ? '?c=' + window.CURRENT : '');
    return;
  }
  if (edit) {
    e.preventDefault(); e.stopPropagation();
    const id = edit.getAttribute('data-edit');
    const row = edit.closest('.conv');
    const title = await openModal({ title:'Renommer la conversation', value: row.querySelector('.conv-t').textContent, okLabel:'Enregistrer' });
    if (title) {
      const r = await fetch('/api/conversations/' + id + '/rename', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title }) });
      const d = await r.json();
      row.querySelector('.conv-t').textContent = d.title || title;
    }
    return;
  }
  if (del) {
    e.preventDefault(); e.stopPropagation();
    const ok = await openModal({ title:'Supprimer la conversation ?', message:'Cette action est définitive.', okLabel:'Supprimer', danger:true });
    if (!ok) return;
    const id = del.getAttribute('data-del');
    await fetch('/api/conversations/' + id + '/delete', { method:'POST' });
    if (String(window.CURRENT) === String(id)) { window.location = '/chat'; return; }
    const el = del.closest('.conv'); if (el) el.remove();
  }
});

/* ---------- Fichiers ---------- */
const TEXT_EXT = ['.txt','.md','.csv','.json','.js','.ts','.py','.html','.css','.xml','.log','.java','.c','.cpp','.rb','.go','.php','.sql','.yml','.yaml','.sh','.ini','.env','.rs','.kt','.swift'];
function classify(f){ const t=f.type||'', n=(f.name||'').toLowerCase();
  if(t.startsWith('image/')) return 'image';
  if(t==='application/pdf'||n.endsWith('.pdf')) return 'pdf';
  if(t.startsWith('text/')||TEXT_EXT.some(e=>n.endsWith(e))) return 'text';
  return 'other'; }
attach.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0]; if (!f) return;
  if (f.size > 10*1024*1024) { alert('Fichier trop lourd (max 10 Mo).'); fileInput.value=''; return; }
  const kind = classify(f);
  if (kind==='other'){ alert("Ce type de fichier ne peut pas être lu par l'IA.\nFormats acceptés : images, PDF, textes/code."); fileInput.value=''; return; }
  const reader = new FileReader();
  if (kind==='text'){ reader.onload=()=>{ pendingFile={kind,text:reader.result,name:f.name}; showPreview(kind,null,f.name); }; reader.readAsText(f); }
  else { reader.onload=()=>{ const url=reader.result; pendingFile={kind,media_type:f.type,data:url.split(',')[1],name:f.name,url}; showPreview(kind, kind==='image'?url:null, f.name); }; reader.readAsDataURL(f); }
});
function showPreview(kind,url,name){
  if(kind==='image'){ previewImg.src=url; previewImg.hidden=false; previewChip.hidden=true; }
  else { $('preview-icon').textContent = kind==='pdf'?'📄':'📎'; $('preview-name').textContent=name; previewChip.hidden=false; previewImg.hidden=true; }
  preview.hidden=false;
}
$('preview-remove').addEventListener('click', clearFile);
function clearFile(){ pendingFile=null; preview.hidden=true; previewImg.hidden=true; previewChip.hidden=true; fileInput.value=''; }

/* ---------- Bulles / rendu ---------- */
function addUser(text, file){
  const empty=$('empty'); if(empty) empty.remove();
  const turn=document.createElement('div'); turn.className='turn user';
  const b=document.createElement('div'); b.className='bubble';
  if(file && file.kind==='image' && file.url){ const im=document.createElement('img'); im.src=file.url; im.className='msg-img'; b.appendChild(im); }
  else if(file){ const chip=document.createElement('div'); chip.className='filechip'; chip.innerHTML='<span class="fi">'+(file.kind==='pdf'?'📄':'📎')+'</span><span class="fn"></span>'; chip.querySelector('.fn').textContent=file.name||'fichier'; b.appendChild(chip); }
  if(text){ const t=document.createElement('div'); t.textContent=text; b.appendChild(t); }
  turn.appendChild(b); thread.appendChild(turn); thread.scrollTop=thread.scrollHeight;
}
function addAI(text){
  const turn=document.createElement('div'); turn.className='turn ai';
  turn.innerHTML='<div class="av">✦</div>';
  const body=document.createElement('div'); body.className='body'; body.innerHTML=renderMarkdown(text);
  addCopy(body, text);
  turn.appendChild(body); thread.appendChild(turn); thread.scrollTop=thread.scrollHeight;
  return body;
}
function addTyping(){
  const turn=document.createElement('div'); turn.className='turn ai typing-row';
  turn.innerHTML='<div class="av">✦</div><div class="typing"><span></span><span></span><span></span></div>';
  thread.appendChild(turn); thread.scrollTop=thread.scrollHeight; return turn;
}
function addConvToSidebar(id,title){
  document.querySelectorAll('.conv.active').forEach(c=>c.classList.remove('active'));
  const a=document.createElement('a'); a.className='conv active'; a.href='/chat?c='+id; a.setAttribute('data-id',id);
  a.innerHTML='<span class="conv-t"></span><span class="conv-actions"><button class="conv-pin" type="button" data-pin="'+id+'" title="Épingler">📌</button><button class="conv-edit" type="button" data-edit="'+id+'" title="Renommer">✏️</button><button class="conv-del" type="button" data-del="'+id+'" title="Supprimer">🗑</button></span>';
  a.querySelector('.conv-t').textContent=title||'Conversation';
  convList.prepend(a);
}

input.addEventListener('input', () => { input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,150)+'px'; });

async function sendMessage(){
  const text=input.value.trim();
  if(!text && !pendingFile) return;
  const file=pendingFile;
  addUser(text,file);
  input.value=''; input.style.height='auto'; clearFile();
  send.disabled=true;
  const typing=addTyping();
  if(window.voiceMode) setVoiceStatus('thinking');
  const payloadFile = file ? (file.kind==='text' ? {kind:'text',text:file.text,name:file.name} : {kind:file.kind,media_type:file.media_type,data:file.data,name:file.name}) : undefined;
  try{
    const r=await fetch('/api/chat',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message:text, conversation_id:window.CURRENT||undefined, file:payloadFile }) });
    const data=await r.json(); typing.remove();
    if(r.status===402){ addAI("🔒 "+(data.message||"Limite atteinte.")+" [Passe au Pro](/account) pour continuer."); if(window.voiceMode) vmClose(); }
    else if(!r.ok){ addAI("⚠️ "+(data.message||"Une erreur est survenue.")); if(window.voiceMode) vmListen(); }
    else {
      const wasVoice = window._voiceTurn; window._voiceTurn = false;
      const body=addAI(data.reply);
      const willSpeak = window.speakOn || window.voiceMode;
      if(willSpeak){ if(window.voiceMode) setVoiceStatus('speaking'); speakText(plainForSpeech(data.reply), function(){ if(window.voiceMode) vmListen(); else if(wasVoice) startListening(); }); }
      else if(window.voiceMode){ vmListen(); }
      if(data.download){ const a=document.createElement('a'); a.href=data.download.url; a.className='dl-btn'; a.textContent='📊 Télécharger le PowerPoint'; const copy=body.querySelector('.copy-btn'); if(copy) body.insertBefore(a,copy); else body.appendChild(a); }
      if(!window.CURRENT && data.conversation_id){ window.CURRENT=data.conversation_id; addConvToSidebar(data.conversation_id, data.title); }
      if(typeof data.used==='number'){ $('used').textContent=data.used; const f=$('quota-fill'); if(f) f.style.width=Math.min(100,Math.round(data.used/window.LIMIT*100))+'%'; }
    }
  }catch(e){ typing.remove(); addAI("⚠️ Erreur de connexion."); }
  send.disabled=false; input.focus();
}
send.addEventListener('click', sendMessage);
input.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMessage(); } });

thread.scrollTop=thread.scrollHeight;

/* ---------- Export de la conversation ---------- */
$('export-btn').addEventListener('click', () => {
  const turns = [...thread.querySelectorAll('.turn')];
  if (!turns.length) { alert('Rien à exporter pour le moment.'); return; }
  let md = '# Conversation\n\n';
  turns.forEach(t => {
    if (t.classList.contains('user')) { md += '**Moi :**\n\n' + (t.querySelector('.bubble') ? t.querySelector('.bubble').innerText.trim() : '') + '\n\n'; }
    else { const b = t.querySelector('.body'); let txt = ''; if (b) { const c = b.cloneNode(true); c.querySelectorAll('.copy-btn,.dl-btn').forEach(x => x.remove()); txt = c.innerText.trim(); } md += '**IA :**\n\n' + txt + '\n\n'; }
  });
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'conversation.md';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
});

/* ================= Vocal : dictée + mode vocal mains libres ================= */
window.speakOn = false;
window.voiceMode = false;
window._voiceTurn = false;
const mic = $('mic'), speakBtn = $('speak'), voiceBar = $('voice-bar');

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const recogSupported = !!SR;
let recog = null, listening = false;

function stopVoiceUI(){ listening = false; if (voiceBar) voiceBar.hidden = true; if (mic) mic.classList.remove('rec'); }
function stopListening(){ try { if (recog) recog.stop(); } catch(e){} stopVoiceUI(); }

// Écoute une phrase. onFinal(texte) reçoit le résultat.
function listenOnce(onFinal){
  if (!recogSupported) return false;
  if (listening) return true;
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch(e){}
  recog = new SR();
  recog.lang = 'fr-FR'; recog.interimResults = true; recog.maxAlternatives = 1; recog.continuous = false;
  let finalText = '';
  recog.onstart = () => { listening = true; if (!window.voiceMode && voiceBar) voiceBar.hidden = false; if (mic) mic.classList.add('rec'); };
  recog.onerror = (e) => {
    stopVoiceUI();
    if (e && (e.error === 'not-allowed' || e.error === 'service-not-allowed')){ alert("Le micro est bloqué. Autorise le microphone pour ce site dans ton navigateur."); if (window.voiceMode) vmClose(); }
    else if (window.voiceMode) setVoiceStatus('idle');
  };
  recog.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++){ const rr = e.results[i]; if (rr.isFinal) finalText += rr[0].transcript; else interim += rr[0].transcript; }
    if (window.voiceMode){ const live = $('voice-live'); if (live) live.textContent = (finalText + ' ' + interim).trim(); }
  };
  recog.onend = () => {
    stopVoiceUI();
    const t = finalText.trim();
    if (t && onFinal){ onFinal(t); return; }
    if (window.voiceMode){ setTimeout(() => { if (window.voiceMode && !listening){ setVoiceStatus('listening'); listenOnce(onFinal); } }, 500); }
  };
  try { recog.start(); return true; } catch(e){ stopVoiceUI(); return false; }
}

/* Dictée : remplit le champ sans envoyer */
function startDictation(){
  if (!recogSupported){ alert("La dictée vocale n'est pas disponible sur ce navigateur.\nUtilise Google Chrome (ordinateur ou Android)."); return; }
  listenOnce(function(t){ input.value = (input.value ? input.value + ' ' : '') + t; input.focus(); input.dispatchEvent(new Event('input')); });
}
function startListening(){ startDictation(); } // compat (reprise après lecture si 🔊)
if (mic){
  mic.addEventListener('click', () => { if (window.voiceMode) return; if (listening) stopListening(); else startDictation(); });
  if (!recogSupported) mic.style.opacity = '.5';
}
const vStop = $('voice-stop'); if (vStop) vStop.addEventListener('click', stopListening);

/* Synthèse vocale */
function pickFrVoice(){ try { const vs = window.speechSynthesis.getVoices() || []; return vs.find(v => /^fr/i.test(v.lang)) || null; } catch(e){ return null; } }
function speakText(text, onEnd){
  if (!('speechSynthesis' in window) || !text){ if (onEnd) onEnd(); return; }
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text).slice(0, 4000));
    u.lang = 'fr-FR'; const v = pickFrVoice(); if (v) u.voice = v;
    u.onend = () => { if (onEnd) onEnd(); };
    u.onerror = () => { if (onEnd) onEnd(); };
    window.speechSynthesis.speak(u);
  } catch(e){ if (onEnd) onEnd(); }
}
function plainForSpeech(md){
  return String(md).replace(/```[\s\S]*?```/g,' bloc de code ').replace(/`([^`]+)`/g,'$1').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/[#>*_~|]/g,' ').replace(/\s+/g,' ').trim();
}
try { if (localStorage.getItem('speak') === '1'){ window.speakOn = true; if (speakBtn) speakBtn.classList.add('on'); } } catch(e){}
if ('speechSynthesis' in window){ try { window.speechSynthesis.onvoiceschanged = pickFrVoice; } catch(e){} }
if (speakBtn){
  speakBtn.addEventListener('click', () => {
    window.speakOn = !window.speakOn;
    speakBtn.classList.toggle('on', window.speakOn);
    try { localStorage.setItem('speak', window.speakOn ? '1' : '0'); } catch(e){}
    if (!window.speakOn && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  });
}

/* Mode vocal mains libres (overlay onde) */
const voiceOverlay = $('voice-overlay'), voiceOrb = $('voice-orb'), voiceStatusEl = $('voice-status');
function setVoiceStatus(state){
  if (voiceStatusEl){ const map = { listening:"🎧 Je t'écoute…", thinking:'💭 Je réfléchis…', speaking:'🗣️ Je réponds…', idle:'En pause' }; voiceStatusEl.textContent = map[state] || ''; }
  if (voiceOrb) voiceOrb.className = 'orb ' + (state || '');
}
function vmListen(){ setVoiceStatus('listening'); const live = $('voice-live'); if (live) live.textContent = ''; listenOnce(function(t){ setVoiceStatus('thinking'); input.value = t; window._voiceTurn = true; sendMessage(); }); }
function vmOpen(){
  if (!recogSupported){ alert("Le mode vocal n'est pas disponible sur ce navigateur.\nUtilise Google Chrome (ordinateur ou Android)."); return; }
  window.voiceMode = true; if (voiceOverlay) voiceOverlay.hidden = false; vmListen();
}
function vmClose(){
  window.voiceMode = false; if (voiceOverlay) voiceOverlay.hidden = true;
  stopListening(); try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch(e){}
}
const vmBtn = $('voice-mode'); if (vmBtn){ vmBtn.addEventListener('click', vmOpen); if (!recogSupported) vmBtn.style.opacity = '.5'; }
const vmCloseBtn = $('voice-close'); if (vmCloseBtn) vmCloseBtn.addEventListener('click', vmClose);
