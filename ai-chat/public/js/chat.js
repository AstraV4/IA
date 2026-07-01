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
  thread.innerHTML = '<div class="empty" id="empty"><div class="empty-icon">✦</div><h3>Nouvelle conversation</h3><p>Pose ta question, ou joins un fichier.</p></div>';
  document.querySelectorAll('.conv.active').forEach(c => c.classList.remove('active'));
  clearFile(); closeSide(); input.focus();
});

/* ---------- Renommer / Supprimer ---------- */
convList.addEventListener('click', async (e) => {
  const edit = e.target.closest('.conv-edit');
  const del = e.target.closest('.conv-del');
  if (edit) {
    e.preventDefault(); e.stopPropagation();
    const id = edit.getAttribute('data-edit');
    const row = edit.closest('.conv');
    const title = prompt('Nouveau titre :', row.querySelector('.conv-t').textContent);
    if (title && title.trim()) {
      const r = await fetch('/api/conversations/' + id + '/rename', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title: title.trim() }) });
      const d = await r.json();
      row.querySelector('.conv-t').textContent = d.title || title.trim();
    }
    return;
  }
  if (del) {
    e.preventDefault(); e.stopPropagation();
    if (!confirm('Supprimer cette conversation ?')) return;
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
  a.innerHTML='<span class="conv-t"></span><span class="conv-actions"><button class="conv-edit" type="button" data-edit="'+id+'" title="Renommer">✏️</button><button class="conv-del" type="button" data-del="'+id+'" title="Supprimer">🗑</button></span>';
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
  const payloadFile = file ? (file.kind==='text' ? {kind:'text',text:file.text,name:file.name} : {kind:file.kind,media_type:file.media_type,data:file.data,name:file.name}) : undefined;
  try{
    const r=await fetch('/api/chat',{ method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ message:text, conversation_id:window.CURRENT||undefined, file:payloadFile }) });
    const data=await r.json(); typing.remove();
    if(r.status===402){ const m=addAI("🔒 "+(data.message||"Limite atteinte.")+" [Passe au Pro](/account) pour continuer."); }
    else if(!r.ok){ addAI("⚠️ "+(data.message||"Une erreur est survenue.")); }
    else {
      addAI(data.reply);
      if(!window.CURRENT && data.conversation_id){ window.CURRENT=data.conversation_id; addConvToSidebar(data.conversation_id, data.title); }
      if(typeof data.used==='number'){ $('used').textContent=data.used; const f=$('quota-fill'); if(f) f.style.width=Math.min(100,Math.round(data.used/window.LIMIT*100))+'%'; }
    }
  }catch(e){ typing.remove(); addAI("⚠️ Erreur de connexion."); }
  send.disabled=false; input.focus();
}
send.addEventListener('click', sendMessage);
input.addEventListener('keydown', (e)=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMessage(); } });

thread.scrollTop=thread.scrollHeight;
