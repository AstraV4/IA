const $ = (id) => document.getElementById(id);
const thread = $('thread');
const messages = $('messages');
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
  if(t==='dark'){ document.documentElement.setAttribute('data-theme','dark'); if(themeBtn) themeBtn.title='Thème clair'; }
  else { document.documentElement.removeAttribute('data-theme'); if(themeBtn) themeBtn.title='Thème sombre'; }
}
try{ applyTheme(localStorage.getItem('theme')||'light'); }catch(e){}
const prefersReducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if(themeBtn) themeBtn.addEventListener('click', (e)=>{
  const dark = document.documentElement.getAttribute('data-theme')!=='dark';
  const doSwitch = () => { try{localStorage.setItem('theme',dark?'dark':'light');}catch(err){} applyTheme(dark?'dark':'light'); };
  if(prefersReducedMotion() || !document.startViewTransition){ doSwitch(); return; }
  const r = themeBtn.getBoundingClientRect();
  const x = r.left + r.width/2, y = r.top + r.height/2;
  const radius = Math.hypot(Math.max(x, innerWidth-x), Math.max(y, innerHeight-y));
  document.startViewTransition(doSwitch).ready.then(()=>{
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 550, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' }
    );
  });
});

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
  const imgs=[]; const links=[];
  t = t.replace(/!\[([^\]]*)\]\((\/[^)\s]+|https?:\/\/[^)\s]+)\)/g,(m,alt,src)=>{ imgs.push({alt,src}); return '\u0001'+(imgs.length-1)+'\u0001'; });
  t = t.replace(/\[([^\]]+)\]\((\/[^)\s]+|https?:\/\/[^)\s]+)\)/g,(m,label,href)=>{ links.push({label,href}); return '\u0002'+(links.length-1)+'\u0002'; });
  t = escapeHtml(t);
  t = t.replace(/`([^`]+)`/g,'<code>$1</code>');
  t = t.replace(/\*\*([^*]+?)\*\*/g,'<strong>$1</strong>');
  t = t.replace(/__([^_]+?)__/g,'<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g,'$1<em>$2</em>');
  t = t.replace(/\u0001(\d+)\u0001/g,(m,i)=>{ const im=imgs[+i]; return '<img class="gen-img" src="'+im.src+'" alt="'+im.alt.replace(/"/g,'&quot;')+'" loading="lazy">'; });
  t = t.replace(/\u0002(\d+)\u0002/g,(m,i)=>{ const l=links[+i]; const ext = /^https?:\/\//.test(l.href) ? ' target="_blank" rel="noopener"' : ''; const isFile = /\.(pptx|docx|pdf|png|jpe?g)(\?|$)/i.test(l.href); const cls = isFile ? ' class="dl-btn"' : ''; return '<a href="'+l.href+'"'+ext+cls+(isFile?' download':'')+'>'+l.label+'</a>'; });
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
// Barre d'actions sous une réponse IA : copier, régénérer (si dispo), réagir 👍👎
function addActs(bodyEl, raw, opts){
  opts = opts || {};
  const acts = document.createElement('div'); acts.className = 'acts'; acts.setAttribute('contenteditable', 'false');
  const copyBtn = document.createElement('button'); copyBtn.className = 'act'; copyBtn.type = 'button'; copyBtn.textContent = '📋 Copier';
  copyBtn.addEventListener('click', () => { navigator.clipboard.writeText(raw).then(() => { copyBtn.textContent = '✓ Copié'; setTimeout(() => copyBtn.textContent = '📋 Copier', 1500); }).catch(() => {}); });
  acts.appendChild(copyBtn);
  if (opts.onRegenerate) {
    const regBtn = document.createElement('button'); regBtn.className = 'act'; regBtn.type = 'button'; regBtn.textContent = '↻ Régénérer';
    regBtn.addEventListener('click', () => opts.onRegenerate());
    acts.appendChild(regBtn);
  }
  const up = document.createElement('button'); up.className = 'act'; up.type = 'button'; up.title = 'Bonne réponse'; up.textContent = '👍';
  const down = document.createElement('button'); down.className = 'act'; down.type = 'button'; down.title = 'Mauvaise réponse'; down.textContent = '👎';
  function react(v) {
    up.classList.toggle('on', v === 'up'); down.classList.toggle('on', v === 'down');
    fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verdict: v, excerpt: raw.slice(0, 300), conversation_id: window.CURRENT }) }).catch(() => {});
  }
  up.addEventListener('click', () => react('up'));
  down.addEventListener('click', () => react('down'));
  acts.appendChild(up); acts.appendChild(down);

  // Traduire (menu de langues)
  const trWrap = document.createElement('div'); trWrap.className = 'translate-wrap';
  const trBtn = document.createElement('button'); trBtn.className = 'act'; trBtn.type = 'button'; trBtn.textContent = '🌐 Traduire';
  const trMenu = document.createElement('div'); trMenu.className = 'translate-menu';
  [['Anglais','anglais'],['Espagnol','espagnol'],['Allemand','allemand'],['Italien','italien'],['Portugais','portugais']].forEach(([label, lang]) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('click', () => { trMenu.classList.remove('show'); input.value = 'Traduis ta réponse précédente en ' + lang + '.'; sendMessage(); });
    trMenu.appendChild(b);
  });
  trBtn.addEventListener('click', (e) => { e.stopPropagation(); trMenu.classList.toggle('show'); });
  document.addEventListener('click', (e) => { if (!trWrap.contains(e.target)) trMenu.classList.remove('show'); });
  trWrap.appendChild(trBtn); trWrap.appendChild(trMenu);
  acts.appendChild(trWrap);

  // Modifier (brouillon collaboratif) : édite directement le texte affiché, sans repasser par l'IA
  const editBtn = document.createElement('button'); editBtn.className = 'act'; editBtn.type = 'button'; editBtn.textContent = '✏️ Modifier';
  editBtn.addEventListener('click', () => {
    const editing = bodyEl.getAttribute('contenteditable') === 'true';
    if (editing) { bodyEl.removeAttribute('contenteditable'); editBtn.textContent = '✏️ Modifier'; }
    else { bodyEl.setAttribute('contenteditable', 'true'); bodyEl.focus(); editBtn.textContent = '✓ Terminé'; }
  });
  acts.appendChild(editBtn);

  bodyEl.appendChild(acts);
  return acts;
}
function highlightCode(root){ try { if (window.hljs) (root||document).querySelectorAll('pre code').forEach(b => { if (!b.classList.contains('hljs')) window.hljs.highlightElement(b); }); } catch(e){} }
// Rendre le Markdown de l'historique au chargement
document.querySelectorAll('.md-raw').forEach(el => { const raw=el.textContent; el.innerHTML = renderMarkdown(raw); el.classList.remove('md-raw'); addActs(el, raw); });
window.addEventListener('DOMContentLoaded', () => highlightCode());
if (window.hljs) highlightCode(); else document.addEventListener('load', () => highlightCode());
setTimeout(() => highlightCode(), 400); // repli si le script highlight.js (defer) charge après coup

/* ---------- Sidebar mobile ---------- */
const side = $('side'), overlay = $('side-overlay');
$('menu-btn').addEventListener('click', () => { side.classList.add('open'); overlay.classList.add('show'); });
overlay.addEventListener('click', () => { side.classList.remove('open'); overlay.classList.remove('show'); });
function closeSide(){ side.classList.remove('open'); overlay.classList.remove('show'); }

/* ---------- Nouvelle conversation ---------- */
$('new-conv').addEventListener('click', () => {
  window.CURRENT = null;
  messages.innerHTML = EMPTY_HTML;
  document.querySelectorAll('.conv.active').forEach(c => c.classList.remove('active'));
  clearFile(); closeSide(); input.focus();
});

/* Clic sur une suggestion -> remplit le champ */
messages.addEventListener('click', (e) => {
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

/* ---------- Glisser pour supprimer une conversation (mobile) ---------- */
let swipeState = null;
convList.addEventListener('touchstart', (e) => {
  const row = e.target.closest('.conv'); if (!row) return;
  swipeState = { row, startX: e.touches[0].clientX, dx: 0, moved: false };
  row.classList.add('swiping');
}, { passive: true });
convList.addEventListener('touchmove', (e) => {
  if (!swipeState) return;
  const dx = e.touches[0].clientX - swipeState.startX;
  if (dx < 0) {
    swipeState.dx = Math.max(dx, -90);
    swipeState.moved = Math.abs(dx) > 8;
    const content = swipeState.row.querySelector('.conv-main'), acts = swipeState.row.querySelector('.conv-actions');
    if (content) content.style.transform = `translateX(${swipeState.dx}px)`;
    if (acts) acts.style.transform = `translateX(${swipeState.dx}px)`;
    swipeState.row.classList.toggle('swipe-open', swipeState.dx < -60);
  }
}, { passive: true });
convList.addEventListener('touchend', () => {
  if (!swipeState) return;
  const { row, dx, moved } = swipeState;
  const content = row.querySelector('.conv-main'), acts = row.querySelector('.conv-actions');
  row.classList.remove('swiping');
  if (dx < -60) {
    // Swipe suffisant -> déclenche la même suppression (avec confirmation) que le bouton 🗑
    const delBtn = row.querySelector('.conv-del'); if (delBtn) delBtn.click();
  }
  if (content) content.style.transform = ''; if (acts) acts.style.transform = '';
  row.classList.remove('swipe-open');
  if (moved) { const blocker = (ev) => { ev.preventDefault(); row.removeEventListener('click', blocker); }; row.addEventListener('click', blocker, { once: true }); }
  swipeState = null;
});

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
  if(n.endsWith('.pptx')||t==='application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  if(t.startsWith('text/')||TEXT_EXT.some(e=>n.endsWith(e))) return 'text';
  return 'other'; }
attach.addEventListener('click', () => fileInput.click());
function handleIncomingFile(f){
  if (!f) return;
  if (f.size > 10*1024*1024) { alert('Fichier trop lourd (max 10 Mo).'); return; }
  const kind = classify(f);
  if (kind==='other'){ alert("Ce type de fichier ne peut pas être lu par l'IA.\nFormats acceptés : images, PDF, PowerPoint (.pptx), textes/code."); return; }
  const reader = new FileReader();
  if (kind==='text'){ reader.onload=()=>{ pendingFile={kind,text:reader.result,name:f.name}; showPreview(kind,null,f.name); }; reader.readAsText(f); }
  else { reader.onload=()=>{ const url=reader.result; pendingFile={kind,media_type:f.type,data:url.split(',')[1],name:f.name,url}; showPreview(kind, kind==='image'?url:null, f.name); }; reader.readAsDataURL(f); }
}
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0]; if (!f) return;
  handleIncomingFile(f);
  fileInput.value='';
});
function showPreview(kind,url,name){
  if(kind==='image'){ previewImg.src=url; previewImg.hidden=false; previewChip.hidden=true; }
  else { $('preview-icon').textContent = kind==='pdf'?'📄':(kind==='pptx'?'📊':'📎'); $('preview-name').textContent=name; previewChip.hidden=false; previewImg.hidden=true; }
  preview.hidden=false;
}
$('preview-remove').addEventListener('click', clearFile);
function clearFile(){ pendingFile=null; preview.hidden=true; previewImg.hidden=true; previewChip.hidden=true; fileInput.value=''; }

/* ---------- Glisser-déposer un fichier n'importe où sur le chat ---------- */
const dropZone = document.querySelector('.main') || document.body;
const dropHint = document.createElement('div');
dropHint.className = 'drop-hint';
dropHint.innerHTML = '<div class="drop-hint-card">📎 Dépose ton fichier ici</div>';
dropHint.hidden = true;
dropZone.appendChild(dropHint);
let dragDepth = 0;
dropZone.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; dropHint.hidden = false; });
dropZone.addEventListener('dragover', (e) => { e.preventDefault(); });
dropZone.addEventListener('dragleave', (e) => { dragDepth = Math.max(0, dragDepth-1); if (dragDepth===0) dropHint.hidden = true; });
dropZone.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; dropHint.hidden = true;
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleIncomingFile(f);
});

/* ---------- Bulles / rendu ---------- */
function nowLabel(){ try { return new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); } catch(e){ return ''; } }
function isNearBottom(){ return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80; }
function scrollToBottom(){ if (!window._userScrolledUp) thread.scrollTop = thread.scrollHeight; }
const jumpBtn = $('jump-btn');
if (jumpBtn) {
  thread.addEventListener('scroll', () => {
    window._userScrolledUp = !isNearBottom();
    jumpBtn.hidden = !window._userScrolledUp;
  });
  jumpBtn.addEventListener('click', () => { window._userScrolledUp = false; thread.scrollTop = thread.scrollHeight; jumpBtn.hidden = true; });
}
function onNewTurn(turn){
  if (window._userScrolledUp && jumpBtn) jumpBtn.hidden = false;
}
// Petite pluie de confettis discrète (succès d'une génération) — pure Canvas, aucune dépendance
function confettiBurst(){
  if (prefersReducedMotion()) return;
  const c = document.createElement('canvas'); c.style.position='fixed'; c.style.inset='0'; c.style.zIndex='9998'; c.style.pointerEvents='none';
  c.width = innerWidth; c.height = innerHeight; document.body.appendChild(c);
  const ctx = c.getContext('2d');
  const colors = ['#2A45E8', '#0F7B6C', '#E8B84B', '#E85C5C'];
  const pieces = Array.from({length: 60}, () => ({
    x: innerWidth/2 + (Math.random()-0.5)*140, y: innerHeight*0.3, vx: (Math.random()-0.5)*7, vy: Math.random()*-7-3,
    r: 3+Math.random()*3, c: colors[Math.floor(Math.random()*colors.length)], rot: Math.random()*6, vr: (Math.random()-0.5)*0.3
  }));
  let frame = 0;
  function tick(){
    frame++;
    ctx.clearRect(0,0,c.width,c.height);
    pieces.forEach(p => { p.x+=p.vx; p.y+=p.vy; p.vy+=0.25; p.rot+=p.vr;
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot); ctx.fillStyle=p.c; ctx.fillRect(-p.r,-p.r,p.r*2,p.r*2); ctx.restore();
    });
    if (frame < 90) requestAnimationFrame(tick); else c.remove();
  }
  tick();
}
const _origTitle = document.title;
let _pendingWhileHidden = false;
function notifyIfHidden(){
  if (!document.hidden) return;
  _pendingWhileHidden = true;
  document.title = '🔵 Nouvelle réponse — ' + _origTitle;
  if (window.Notification && Notification.permission === 'granted') {
    try { new Notification('✨ Ta réponse est prête', { body: 'Reviens sur ' + _origTitle + ' pour la lire.', silent: true }); } catch(e){}
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && _pendingWhileHidden) {
    _pendingWhileHidden = false;
    document.title = _origTitle;
    const toast = document.createElement('div'); toast.className = 'writing-toast show';
    toast.innerHTML = '<span class="dot"></span> Nouvelle réponse reçue';
    document.body.appendChild(toast);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 2500);
  }
});
/* ---------- Zoom plein écran sur les images ---------- */
const lightbox = document.createElement('div'); lightbox.className = 'lightbox';
lightbox.innerHTML = '<button class="lightbox-close" type="button" title="Fermer">✕</button><img alt="" />';
document.body.appendChild(lightbox);
const lightboxImg = lightbox.querySelector('img');
function openLightbox(src){ lightboxImg.src = src; lightbox.classList.add('show'); }
function closeLightbox(){ lightbox.classList.remove('show'); }
lightbox.addEventListener('click', (e) => { if (e.target === lightbox || e.target.closest('.lightbox-close')) closeLightbox(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
messages.addEventListener('click', (e) => {
  const img = e.target.closest('img.gen-img, img.msg-img');
  if (img) openLightbox(img.src);
});

function addUser(text, file){
  const empty=$('empty'); if(empty) empty.remove();
  const turn=document.createElement('div'); turn.className='turn user';
  const b=document.createElement('div'); b.className='bubble';
  if(file && file.kind==='image' && file.url){ const im=document.createElement('img'); im.src=file.url; im.className='msg-img'; b.appendChild(im); }
  else if(file){ const chip=document.createElement('div'); chip.className='filechip'; chip.innerHTML='<span class="fi">'+(file.kind==='pdf'?'📄':'📎')+'</span><span class="fn"></span>'; chip.querySelector('.fn').textContent=file.name||'fichier'; b.appendChild(chip); }
  if(text){ const t=document.createElement('div'); t.textContent=text; b.appendChild(t); }
  turn.appendChild(b); messages.appendChild(turn); window._userScrolledUp=false; if(jumpBtn) jumpBtn.hidden=true; thread.scrollTop=thread.scrollHeight;
}

/* Découpe un HTML déjà rendu en tokens sûrs à révéler progressivement :
   chaque balise complète (<img ...>, <a ...>...</a>, etc.) est un bloc atomique qu'on ne coupe jamais,
   seul le texte entre les balises est découpé en mots. Générique : marche avec n'importe quel markdown rendu. */
function tokenizeHtml(html){
  const tokens=[]; let i=0, buf='';
  while(i<html.length){
    const ch=html[i];
    if(ch==='<'){
      if(buf){ tokens.push(buf); buf=''; }
      let j=html.indexOf('>', i); if(j===-1) j=html.length-1;
      tokens.push(html.slice(i, j+1)); i=j+1;
    } else if(ch===' '||ch==='\n'){
      buf+=ch; tokens.push(buf); buf=''; i++;
    } else { buf+=ch; i++; }
  }
  if(buf) tokens.push(buf);
  return tokens;
}

function addAI(text, opts){
  opts = opts || {};
  const turn=document.createElement('div'); turn.className='turn ai';
  turn.innerHTML='<div class="fil"><span class="node live"></span><i></i></div>';
  const body=document.createElement('div'); body.className='body';
  turn.appendChild(body);
  messages.appendChild(turn); scrollToBottom();

  const node=turn.querySelector('.node'), fil=turn.querySelector('.fil i');
  function growFil(){ fil.style.height = Math.max(0, body.offsetHeight - 8) + 'px'; }
  function finish(){
    node.classList.remove('live'); turn.classList.add('done'); growFil();
    addActs(body, text, { onRegenerate: opts.onRegenerate });
    highlightCode(body);
    const t=document.createElement('span'); t.className='msg-time'; t.textContent = nowLabel(); turn.appendChild(t);
    onNewTurn(turn);
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch(e){} }
    if (opts.followups) {
      const fu = document.createElement('div'); fu.className='followups';
      ['Explique plus simplement', 'Continue', 'Traduis en anglais', 'Résume'].forEach(q => {
        const b = document.createElement('button'); b.type='button'; b.textContent = q;
        b.addEventListener('click', () => { input.value = q; sendMessage(); });
        fu.appendChild(b);
      });
      body.appendChild(fu);
    }
    notifyIfHidden();
  }

  const finalHtml = renderMarkdown(text);
  if (prefersReducedMotion()) { body.innerHTML = finalHtml; finish(); return body; }

  const tokens = tokenizeHtml(finalHtml);
  const duration = Math.min(2200, Math.max(280, text.length * 4)); // borné : reste rapide même pour une longue réponse
  const startT = performance.now();
  const cursor = document.createElement('span'); cursor.className='type-cursor';
  function step(now){
    const t = Math.min(1, (now - startT) / duration);
    const eased = 1 - Math.pow(1 - t, 2);
    const n = Math.max(1, Math.round(tokens.length * eased));
    body.innerHTML = tokens.slice(0, n).join('');
    body.appendChild(cursor);
    growFil(); scrollToBottom();
    if (t < 1) requestAnimationFrame(step);
    else { cursor.remove(); body.innerHTML = finalHtml; finish(); }
  }
  requestAnimationFrame(step);
  return body;
}

function addTyping(){
  const turn=document.createElement('div'); turn.className='turn ai typing-row';
  turn.innerHTML='<div class="fil"><span class="node live"></span><i></i></div>'+
    '<div class="body"><span class="skel" style="width:78%"></span><span class="skel" style="width:52%"></span></div>';
  messages.appendChild(turn); thread.scrollTop=thread.scrollHeight; return turn;
}
function addConvToSidebar(id,title){
  document.querySelectorAll('.conv.active').forEach(c=>c.classList.remove('active'));
  const a=document.createElement('a'); a.className='conv active'; a.href='/chat?c='+id; a.setAttribute('data-id',id);
  a.innerHTML='<span class="conv-swipe-bg" aria-hidden="true">🗑 Supprimer</span><span class="conv-main"><span class="conv-t"></span></span><span class="conv-actions"><button class="conv-pin" type="button" data-pin="'+id+'" title="Épingler">📌</button><button class="conv-edit" type="button" data-edit="'+id+'" title="Renommer">✏️</button><button class="conv-del" type="button" data-del="'+id+'" title="Supprimer">🗑</button></span>';
  a.querySelector('.conv-t').textContent=title||'Conversation';
  convList.prepend(a);
}

input.addEventListener('input', () => { input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,150)+'px'; updateSlashMenu(); });

/* ---------- Commandes rapides "/" ---------- */
const slashMenu = $('slash-menu');
function updateSlashMenu(){
  if (!slashMenu) return;
  const v = input.value;
  if (v.startsWith('/') && !v.includes('\n') && v.length < 30) { slashMenu.hidden = false; }
  else { slashMenu.hidden = true; }
}
if (slashMenu) {
  slashMenu.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      const cmd = btn.getAttribute('data-cmd');
      slashMenu.hidden = true;
      if (cmd === '__goto_correction__') { window.location.href = '/correction'; return; }
      input.value = cmd; input.focus();
      input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,150)+'px';
    });
  });
  document.addEventListener('click', (e) => { if (!slashMenu.hidden && !slashMenu.contains(e.target) && e.target !== input) slashMenu.hidden = true; });
}

/* ---------- Mes prompts (modèles réutilisables, stockés localement) ---------- */
const tplList = $('tpl-list');
function loadTemplates(){ try { return JSON.parse(localStorage.getItem('templates') || '[]'); } catch(e){ return []; } }
function saveTemplates(list){ try { localStorage.setItem('templates', JSON.stringify(list.slice(0, 20))); } catch(e){} }
function renderTemplates(){
  if (!tplList) return;
  const list = loadTemplates();
  tplList.innerHTML = '';
  if (!list.length) { const p = document.createElement('div'); p.className='tpl-item'; p.style.opacity='.6'; p.style.cursor='default'; p.textContent='Aucun prompt enregistré'; tplList.appendChild(p); return; }
  list.forEach((t, i) => {
    const el = document.createElement('div'); el.className='tpl-item';
    el.innerHTML = '<span class="tpl-t"></span><button class="tpl-del" type="button" title="Supprimer">✕</button>';
    el.querySelector('.tpl-t').textContent = t;
    el.querySelector('.tpl-t').addEventListener('click', () => { input.value = t; input.focus(); input.style.height='auto'; input.style.height=Math.min(input.scrollHeight,150)+'px'; });
    el.querySelector('.tpl-del').addEventListener('click', (e) => { e.stopPropagation(); const l = loadTemplates(); l.splice(i,1); saveTemplates(l); renderTemplates(); });
    tplList.appendChild(el);
  });
}
renderTemplates();
const tplAdd = $('tpl-add');
if (tplAdd) tplAdd.addEventListener('click', () => {
  const v = input.value.trim();
  if (!v) { alert('Écris ton message dans le champ avant de l\'enregistrer comme prompt.'); return; }
  const list = loadTemplates(); list.unshift(v); saveTemplates(list); renderTemplates();
});
const summarizeBtn = $('summarize-btn');
if (summarizeBtn) summarizeBtn.addEventListener('click', () => {
  if (!messages.querySelector('.turn')) { alert("Il n'y a encore rien à résumer dans cette conversation."); return; }
  input.value = "Fais un résumé concis de notre conversation jusqu'ici, sous forme de puces.";
  sendMessage();
});

/* ---------- Détection d'un long texte collé sans instruction ---------- */
const intentBar = $('intent-bar');
if (intentBar) {
  input.addEventListener('paste', () => {
    setTimeout(() => { if (input.value.trim().length > 400) intentBar.hidden = false; else intentBar.hidden = true; }, 30);
  });
  intentBar.querySelectorAll('button[data-act]').forEach(b => {
    b.addEventListener('click', () => { input.value = b.getAttribute('data-act') + input.value; intentBar.hidden = true; input.focus(); });
  });
  const intentClose = intentBar.querySelector('.intent-close');
  if (intentClose) intentClose.addEventListener('click', () => { intentBar.hidden = true; });
}
const chaloWrap = $('chalo-wrap');
if (chaloWrap) {
  input.addEventListener('focus', () => chaloWrap.classList.add('hot'));
  input.addEventListener('blur', () => { if (!input.value) chaloWrap.classList.remove('hot'); });
}

let currentAbortController = null;

async function sendMessage(){
  if(currentAbortController) return; // une réponse est déjà en cours
  const text=input.value.trim();
  if(!text && !pendingFile) return;
  const file=pendingFile;
  addUser(text,file);
  input.value=''; input.style.height='auto'; clearFile();
  if (slashMenu) slashMenu.hidden = true;
  if (intentBar) intentBar.hidden = true;
  if (chaloWrap) chaloWrap.classList.remove('hot');
  setSendState('stop');
  const typing=addTyping();
  if(window.voiceMode) setVoiceStatus('thinking');
  const payloadFile = file ? (file.kind==='text' ? {kind:'text',text:file.text,name:file.name} : {kind:file.kind,media_type:file.media_type,data:file.data,name:file.name}) : undefined;
  window._lastUserPayload = { text, file: payloadFile };
  currentAbortController = new AbortController();
  try{
    const r=await fetch('/api/chat',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message:text, conversation_id:window.CURRENT||undefined, file:payloadFile }), signal: currentAbortController.signal });
    const data=await r.json(); typing.remove();
    if(r.status===402){ addAI("🔒 "+(data.message||"Limite atteinte.")+" [Passe au Pro](/account) pour continuer."); if(window.voiceMode) vmClose(); }
    else if(!r.ok){ addAI("⚠️ "+(data.message||"Une erreur est survenue.")); if(window.voiceMode) vmListen(); }
    else {
      const wasVoice = window._voiceTurn; window._voiceTurn = false;
      const body=addAI(data.reply, { onRegenerate: () => regenerate(body.closest('.turn'), text, payloadFile), followups: true });
      if (data.download || data.image) confettiBurst();
      const willSpeak = window.speakOn || window.voiceMode;
      if(window.voiceMode && willSpeak){ vmSpeak(plainForSpeech(data.reply)); }
      else if(willSpeak){ speakText(plainForSpeech(data.reply), function(){ if(wasVoice) startListening(); }); }
      else if(window.voiceMode){ vmListen(); }
      if(!window.CURRENT && data.conversation_id){ window.CURRENT=data.conversation_id; addConvToSidebar(data.conversation_id, data.title); }
      if(typeof data.used==='number'){ $('used').textContent=data.used; const f=$('quota-fill'); if(f) f.style.width=Math.min(100,Math.round(data.used/window.LIMIT*100))+'%'; }
    }
  }catch(e){
    typing.remove();
    if(e.name==='AbortError'){ addAI("⏹️ Génération interrompue."); if(window.voiceMode) vmListen(); }
    else { addAI("⚠️ Erreur de connexion."); }
  }
  currentAbortController = null;
  setSendState('send'); input.focus();
}
// Redemande la même question (sans réafficher la bulle utilisateur), remplace l'ancienne réponse
async function regenerate(turnEl, text, payloadFile){
  if (currentAbortController) return;
  if (turnEl) turnEl.remove();
  const typing = addTyping();
  currentAbortController = new AbortController();
  try {
    const r = await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message:text, conversation_id:window.CURRENT||undefined, file:payloadFile, regenerate:true }), signal: currentAbortController.signal });
    const data = await r.json(); typing.remove();
    if (!r.ok) { addAI("⚠️ "+(data.message||"Une erreur est survenue.")); }
    else {
      const body = addAI(data.reply, { onRegenerate: () => regenerate(body.closest('.turn'), text, payloadFile), followups: true });
      if (data.download || data.image) confettiBurst();
    }
  } catch(e) { typing.remove(); addAI("⚠️ Erreur de connexion."); }
  currentAbortController = null;
}
function setSendState(state){
  if(state==='stop'){ send.classList.add('is-stop'); send.title='Arrêter'; send.innerHTML='<span class="stop-sq"></span>'; send.classList.add('sent-pop'); setTimeout(()=>send.classList.remove('sent-pop'),350); }
  else { send.classList.remove('is-stop'); send.disabled=false; send.title='Envoyer'; send.innerHTML='➤'; }
}
send.addEventListener('click', () => {
  if(send.classList.contains('is-stop')){ if(currentAbortController) currentAbortController.abort(); }
  else { sendMessage(); }
});
input.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMessage(); } });

thread.scrollTop=thread.scrollHeight;

/* ---------- Export de la conversation (markdown, PDF) + partage ---------- */
function collectTurns(){
  return [...messages.querySelectorAll('.turn')].map(t => {
    if (t.classList.contains('user')) return { role: 'user', text: t.querySelector('.bubble') ? t.querySelector('.bubble').innerText.trim() : '' };
    const b = t.querySelector('.body'); let txt = '';
    if (b) { const c = b.cloneNode(true); c.querySelectorAll('.acts,.dl-btn,.gen-img,.msg-time').forEach(x => x.remove()); txt = c.innerText.trim(); }
    return { role: 'ai', text: txt };
  });
}
$('export-btn').addEventListener('click', () => {
  const turns = collectTurns();
  if (!turns.length) { alert('Rien à exporter pour le moment.'); return; }
  let md = '# Conversation\n\n';
  turns.forEach(t => { md += (t.role === 'user' ? '**Moi :**\n\n' : '**IA :**\n\n') + t.text + '\n\n'; });
  const blob = new Blob([md], { type: 'text/markdown' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'conversation.md';
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
});
const shareBtn = $('share-btn');
if (shareBtn) shareBtn.addEventListener('click', async () => {
  if (!window.CURRENT) { alert("Envoie au moins un message avant de partager cette conversation."); return; }
  try {
    const r = await fetch('/api/conversations/' + window.CURRENT + '/share', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({}) });
    const data = await r.json();
    if (data.url) { await navigator.clipboard.writeText(data.url).catch(()=>{}); alert('Lien copié ✅ (lecture seule, sans connexion nécessaire) :\n' + data.url); }
  } catch(e) { alert("Impossible de créer le lien de partage."); }
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

// Écoute une phrase. onFinal(texte) reçoit le résultat. opts.keepSpeaking=true : ne coupe pas une synthèse vocale en cours (utilisé pour l'écoute de fond / interruption).
function listenOnce(onFinal, opts){
  opts = opts || {};
  if (!recogSupported) return false;
  if (listening) return true;
  if (!opts.keepSpeaking) { stopSpeaking(); }
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
function speakTextBrowser(text, onEnd){
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
let currentAudioEl = null;
// Coupe la lecture en cours, qu'elle vienne de la voix IA (audio) ou de la voix du navigateur (speechSynthesis)
function stopSpeaking(){
  if (currentAudioEl){ try { currentAudioEl.pause(); currentAudioEl.src=''; } catch(e){} currentAudioEl = null; }
  try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch(e){}
}
// Voix IA (bien plus naturelle) via /api/tts ; si indisponible (pas de clé OpenAI, erreur réseau…), repli automatique sur la voix du navigateur
async function speakText(text, onEnd){
  const t = String(text || '').trim();
  if (!t){ if (onEnd) onEnd(); return; }
  try {
    const r = await fetch('/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t.slice(0, 4000) }) });
    if (!r.ok) throw new Error('tts_unavailable');
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    currentAudioEl = audio;
    const finish = () => { URL.revokeObjectURL(url); if (currentAudioEl === audio) currentAudioEl = null; if (onEnd) onEnd(); };
    audio.onended = finish; audio.onerror = finish;
    await audio.play();
  } catch (e) {
    speakTextBrowser(t, onEnd); // repli propre, le mode vocal continue de fonctionner sans clé OpenAI
  }
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
    if (!window.speakOn) stopSpeaking();
  });
}

/* Mode vocal mains libres (overlay onde) */
const voiceOverlay = $('voice-overlay'), voiceOrb = $('voice-orb'), voiceStatusEl = $('voice-status');
function setVoiceStatus(state){
  if (voiceStatusEl){ const map = { listening:"🎧 Je t'écoute…", thinking:'💭 Je réfléchis…', speaking:'🗣️ Je réponds…', idle:'En pause' }; voiceStatusEl.textContent = map[state] || ''; }
  if (voiceOrb) voiceOrb.className = 'orb ' + (state || '');
}
function vmListen(){ setVoiceStatus('listening'); const live = $('voice-live'); if (live) live.textContent = ''; listenOnce(vmHandleUserUtterance); }
function vmHandleUserUtterance(t){ setVoiceStatus('thinking'); input.value = t; window._voiceTurn = true; sendMessage(); }

// Écoute de fond indépendante (n'utilise pas recog/listening du dictaphone) : détecte si l'utilisateur
// se met à parler PENDANT que l'IA répond à voix haute, pour l'interrompre — comme dans un vrai appel.
function startBargeInWatch(onInterrupt){
  if (!recogSupported) return { stop(){} };
  let r; try { r = new SR(); } catch(e){ return { stop(){} }; }
  r.lang = 'fr-FR'; r.interimResults = false; r.continuous = false; r.maxAlternatives = 1;
  let done = false;
  r.onresult = (e) => { const t = e.results[e.results.length-1][0].transcript.trim(); if (t && !done){ done = true; onInterrupt(t); } };
  r.onerror = () => {}; r.onend = () => {};
  try { r.start(); } catch(e){ return { stop(){} }; }
  return { stop(){ done = true; try { r.onresult = null; r.stop(); } catch(e){} } };
}
function vmSpeak(text){
  setVoiceStatus('speaking');
  let interrupted = false;
  const watch = startBargeInWatch(function(t){
    interrupted = true;
    stopSpeaking();
    vmHandleUserUtterance(t);
  });
  speakText(text, function(){
    watch.stop();
    if (interrupted) return; // déjà pris en charge par l'interruption ci-dessus
    if (window.voiceMode) vmListen();
  });
}
function vmOpen(){
  if (!recogSupported){ alert("Le mode vocal n'est pas disponible sur ce navigateur.\nUtilise Google Chrome (ordinateur ou Android)."); return; }
  window.voiceMode = true; if (voiceOverlay) voiceOverlay.hidden = false; vmListen();
}
function vmClose(){
  window.voiceMode = false; if (voiceOverlay) voiceOverlay.hidden = true;
  stopListening(); stopSpeaking();
}
const vmBtn = $('voice-mode'); if (vmBtn){ vmBtn.addEventListener('click', vmOpen); if (!recogSupported) vmBtn.style.opacity = '.5'; }
const vmCloseBtn = $('voice-close'); if (vmCloseBtn) vmCloseBtn.addEventListener('click', vmClose);

/* ---------- Bouton d'envoi magnétique (suit légèrement le curseur, ordinateur uniquement) ---------- */
if (send && window.matchMedia && window.matchMedia('(pointer: fine)').matches && !prefersReducedMotion()) {
  send.addEventListener('pointermove', (e) => {
    const r = send.getBoundingClientRect();
    const mx = (e.clientX - r.left - r.width / 2) * 0.32;
    const my = (e.clientY - r.top - r.height / 2) * 0.32;
    send.style.transform = `translate(${mx.toFixed(1)}px,${my.toFixed(1)}px) scale(1.06)`;
  });
  send.addEventListener('pointerleave', () => { send.style.transform = ''; });
}

/* ---------- Ondulation au clic sur les boutons marqués .ripple-host ---------- */
document.querySelectorAll('.ripple-host').forEach(btn => {
  btn.addEventListener('click', (e) => {
    if (prefersReducedMotion()) return;
    const r = btn.getBoundingClientRect();
    const d = Math.max(r.width, r.height) * 1.6;
    const span = document.createElement('span');
    span.className = 'ripple';
    span.style.width = span.style.height = d + 'px';
    span.style.left = (e.clientX - r.left - d / 2) + 'px';
    span.style.top = (e.clientY - r.top - d / 2) + 'px';
    btn.appendChild(span);
    span.addEventListener('animationend', () => span.remove());
  });
});
