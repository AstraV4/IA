const $ = (id) => document.getElementById(id);
const inp = $('corr-input'), go = $('corr-go'), result = $('corr-result');

/* Markdown -> HTML (sûr) */
function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function inlineMd(t){ t=escapeHtml(t);
  t=t.replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+?)\*\*/g,'<strong>$1</strong>').replace(/__([^_]+?)__/g,'<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*?)\*/g,'$1<em>$2</em>');
  return t; }
function splitRow(l){ return l.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>c.trim()); }
function renderMarkdown(src){
  src=String(src).replace(/\r\n/g,'\n'); const blocks=[];
  src=src.replace(/```[^\n]*\n?([\s\S]*?)```/g,(m,code)=>{blocks.push('<pre><code>'+escapeHtml(code.replace(/\n$/,''))+'</code></pre>');return '\u0000'+(blocks.length-1)+'\u0000';});
  const lines=src.split('\n'); const out=[]; let i=0;
  while(i<lines.length){ const line=lines[i];
    const cb=line.match(/^\u0000(\d+)\u0000$/); if(cb){out.push(blocks[+cb[1]]);i++;continue;}
    if(/^\s*$/.test(line)){i++;continue;}
    const h=line.match(/^(#{1,6})\s+(.*)$/); if(h){const lv=h[1].length;out.push('<h'+lv+'>'+inlineMd(h[2].trim())+'</h'+lv+'>');i++;continue;}
    if(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)){out.push('<hr>');i++;continue;}
    if(/\|/.test(line)&&i+1<lines.length&&/^\s*\|?[\s:\-|]+\|?\s*$/.test(lines[i+1])&&/-/.test(lines[i+1])){
      const header=splitRow(line);i+=2;const rows=[];
      while(i<lines.length&&/\|/.test(lines[i])&&!/^\s*$/.test(lines[i])){rows.push(splitRow(lines[i]));i++;}
      let t='<table><thead><tr>'+header.map(c=>'<th>'+inlineMd(c)+'</th>').join('')+'</tr></thead><tbody>';
      t+=rows.map(r=>'<tr>'+r.map(c=>'<td>'+inlineMd(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
      out.push(t);continue;}
    if(/^\s*[-*+]\s+/.test(line)){const it=[];while(i<lines.length&&/^\s*[-*+]\s+/.test(lines[i])){it.push('<li>'+inlineMd(lines[i].replace(/^\s*[-*+]\s+/,''))+'</li>');i++;}out.push('<ul>'+it.join('')+'</ul>');continue;}
    if(/^\s*\d+\.\s+/.test(line)){const it=[];while(i<lines.length&&/^\s*\d+\.\s+/.test(lines[i])){it.push('<li>'+inlineMd(lines[i].replace(/^\s*\d+\.\s+/,''))+'</li>');i++;}out.push('<ol>'+it.join('')+'</ol>');continue;}
    const para=[];while(i<lines.length&&!/^\s*$/.test(lines[i])&&!/^(#{1,6})\s/.test(lines[i])&&!/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])&&!/^\s*[-*+]\s+/.test(lines[i])&&!/^\s*\d+\.\s+/.test(lines[i])&&!/^\u0000\d+\u0000$/.test(lines[i])){para.push(lines[i]);i++;}
    out.push('<p>'+para.map(inlineMd).join('<br>')+'</p>');
  }
  return out.join('\n');
}

async function correct(){
  const text = inp.value.trim();
  if(!text){ inp.focus(); return; }
  go.disabled = true; go.textContent = 'Correction…';
  result.hidden = false; result.innerHTML = '<div class="corr-loading">✍️ Je corrige ton texte…</div>';
  try{
    const r = await fetch('/api/correct', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text }) });
    const data = await r.json();
    if(r.status===402){ result.innerHTML = '<div class="corr-err">🔒 '+(data.message||'Limite atteinte.')+' <a href="/account">Passer au Pro</a></div>'; }
    else if(!r.ok){ result.innerHTML = '<div class="corr-err">⚠️ '+(data.message||'Erreur.')+'</div>'; }
    else {
      result.innerHTML = '<div class="body">'+renderMarkdown(data.reply)+'</div>';
      const btn = document.createElement('button'); btn.className='copy-btn'; btn.textContent='📋 Copier';
      btn.addEventListener('click', ()=>{ navigator.clipboard.writeText(data.reply); btn.textContent='✅ Copié'; setTimeout(()=>btn.textContent='📋 Copier',1500); });
      result.querySelector('.body').appendChild(btn);
      if(typeof data.used==='number'){ const u=$('used'); if(u) u.textContent=data.used; }
    }
  }catch(e){ result.innerHTML = '<div class="corr-err">⚠️ Erreur de connexion.</div>'; }
  go.disabled = false; go.textContent = 'Corriger le texte';
}
go.addEventListener('click', correct);
