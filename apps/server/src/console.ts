// Throwaway dev console (M3). Phase 2 replaces it with the real client; it exists to run one real Cram session by hand.
export const CONSOLE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sage dev console</title>
<style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--mute:#6b6b66;--line:#ddd;--acc:#2d6a4f;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecece8;--mute:#9a9a93;--line:#333;--acc:#74c69d;--err:#f97066}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:16px;display:grid;gap:16px;grid-template-columns:minmax(0,1fr) minmax(0,380px)}
@media (max-width:800px){main{grid-template-columns:1fr}}
section{border:1px solid var(--line);border-radius:8px;padding:12px}
h1{font-size:18px;margin:0 0 8px}h2{font-size:14px;margin:0 0 8px;color:var(--mute);text-transform:uppercase;letter-spacing:.04em}
textarea,input,select{width:100%;box-sizing:border-box;font:inherit;padding:8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit}
button{font:inherit;padding:6px 10px;margin:4px 4px 0 0;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;cursor:pointer}
button.primary{background:var(--acc);color:var(--bg);border-color:var(--acc)}
#log{height:420px;overflow:auto;font:12px/1.4 ui-monospace,monospace;white-space:pre-wrap}
.ev{border-bottom:1px solid var(--line);padding:4px 0;white-space:pre-wrap}.slot{display:block;margin:4px 0}.cases{display:flex;gap:8px;flex-wrap:wrap}.cases>div{flex:1 1 220px;border:1px solid var(--line);padding:8px}.err{color:var(--err)}
#stage>div{margin-bottom:12px}#stage p,#stage li{white-space:pre-wrap}.choice{display:block;width:100%;text-align:left}
</style></head><body><main>
<div>
<section><h1>Sage dev console</h1>
<label>Objective<textarea id="obj" rows="2">Pass the theory part of my driving test next week</textarea></label>
<label>Minutes <input id="mins" type="number" value="60" min="5"></label>
<button class="primary" onclick="create()">Create Cram session</button>
<select id="sessions" onchange="resume(this.value)"><option value="">resume a session…</option></select>
</section>
<section><h2>Your sources</h2>
<p class="mute">Checked sources are used by the next session you create. Nothing is sent to a model unless you accept it with "share excerpts with the models".</p>
<label>File (pdf, docx, pptx, png/jpg scan, vtt/srt, txt/md) <input type="file" id="srcfile"></label>
<label>or a YouTube video / .vtt or .srt file URL <input id="srcurl" type="url" placeholder="https://www.youtube.com/watch?v=…" oninput="ytCheck()"></label>
<div id="ytpaste" hidden><p>On YouTube, click Show transcript under the description, select all, copy, paste here</p><textarea id="srctr" rows="6" aria-label="Pasted YouTube transcript"></textarea></div>
<label><input type="checkbox" id="srcexam"> This is a past exam</label>
<button onclick="addSource()">Add source</button>
<div id="srclist"></div>
<details><summary>Obsidian vault and extensions</summary>
<label>Vault folder (absolute path) <input id="vault" placeholder="C:\\Users\\you\\Documents\\Vault"></label><button onclick="setVault()">Save vault</button>
<button onclick="rpc('extensions.list',{}).then(v=>log((v.packages.map(p=>typeof p==='string'?p:p.source).join(', ')||'no extensions')+'. '+v.notice))">Show extensions</button>
</details>
</section>
<section><h2>Session</h2><div id="stage"><div class="mute">No session yet.</div></div>
<div id="answer" hidden><textarea id="resp" rows="4" placeholder="Your answer"></textarea>
<button class="primary" onclick="submit()">Submit</button><button onclick="call('hint.request',{level:1})">Hint 1</button><button onclick="call('hint.request',{level:2})">Hint 2</button><button onclick="call('hint.request',{level:3})">Hint 3</button><button onclick="call('chunk.peek')">Peek chunk</button></div>
<div><button onclick="call('plan.approve')">Approve plan</button><button onclick="ack()">OK, next</button><button onclick="call('control.advance')">Advance</button><button onclick="call('control.morePractice')">More practice</button><button onclick="call('control.teach')">Teach me</button><button onclick="call('pace.set',{pace:'speed_up'})">Speed up</button><button onclick="call('control.stop')">Stop</button><button onclick="call('control.resume').then(v=>v&&state())">Resume</button><button onclick="call('control.leaveWithGaps')">Leave node with gaps</button><button onclick="accept()">Accept research</button><button onclick="state()">State</button><button onclick="exp()">Export</button><label><input type="checkbox" id="usage" checked onchange="rpc('usage.set',{enabled:this.checked}).then(v=>log('usage counters '+(v.enabled?'on':'off')+' (local only, nothing uploaded)'))"> Usage counters</label><button onclick="dispute()">Dispute grade</button></div>
</section>
</div>
<section><h2>Events</h2><div id="log" aria-live="polite"></div></section>
</main><script>
let ws;let n=0,sid=null,feedback=null,pack=null,fit=null,lastAttempt=null;const pending={};
const $=id=>document.getElementById(id);
const log=(t,c)=>{const d=document.createElement('div');d.className='ev '+(c||'');d.textContent=t;$('log').prepend(d)};
const rpc=(method,params={})=>new Promise((res,rej)=>{if(!ws||ws.readyState!==1)return rej(new Error('not connected; reconnecting'));const id=++n;pending[id]={res,rej};ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params}))});
const call=(m,p={})=>rpc(m,{sessionId:sid,...p}).then(v=>(m==='state.get'&&log(JSON.stringify(v,null,1).slice(0,3000)),v)).catch(e=>log(m+': '+e.message,'err'));
function connect(){ws=new WebSocket(location.origin.replace('http','ws')+'/ws'+location.search);ws.onopen=opened;ws.onmessage=got;
 ws.onclose=()=>{for(const k in pending){pending[k].rej(new Error('connection lost'));delete pending[k]}log('Connection lost. Reconnecting…','err');setTimeout(connect,2000)}}
let first=true;
async function opened(){if(!first){log('Reconnected.');if(sid)resume(sid);return}first=false;
 rpc('usage.get',{}).then(v=>{$('usage').checked=v.enabled!==false}).catch(()=>{});rpc('settings.get',{}).then(v=>{const m=v.roleModels.transcriber;if(m)tmodel=m.provider+'/'+m.model;if(v.vaultPath)$('vault').value=v.vaultPath}).catch(()=>{});sources();
 for(const s of await rpc('session.list')){const o=document.createElement('option');o.value=s.sessionId;o.textContent=(s.objective||s.sessionId).slice(0,60);$('sessions').append(o)}};
function got(m){const x=JSON.parse(m.data);if(x.id&&pending[x.id]){x.error?pending[x.id].rej(new Error(x.error.message)):pending[x.id].res(x.result);delete pending[x.id];return}
 if(x.method!=='event')return;const e=x.params,d=e.data;log(e.event+' '+JSON.stringify(d).slice(0,400),e.event==='error'?'err':'');show(e.event,d)}
function show(ev,d){const st=$('stage');const box=h=>{const div=document.createElement('div');div.innerHTML=h;st.prepend(div)};const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
 const q=s=>esc(s).replace(/"/g,'&quot;');
 const cites=l=>(l||[]).length?'<p class="mute">Source: '+l.map(c=>c.link?'<a href="'+q(c.link)+'" data-span="'+q(c.spanId)+'" onclick="openSrc(this)" target="_blank" rel="noopener noreferrer">'+esc(c.title+' '+c.locator)+'</a>':esc(c.title+' '+c.locator)).join('; ')+'</p>':'';
 if(ev==='tutor.done')box('<b>Tutor</b><p>'+esc(d.text)+'</p>'+cites(d.citations));
 if(ev==='item.present'){const it=d.item,t=it.activityType,slots=t==='ordering'||t==='matching';$('answer').hidden=slots;
  const opts=a=>'<option value="">choose</option>'+a.map((x,j)=>'<option value="'+j+'">'+esc(x)+'</option>').join('');
  const body=t==='ordering'?(it.choices||[]).map((_,p)=>'<label class="slot">Step '+(p+1)+' <select class="seq">'+opts(it.choices)+'</select></label>').join('')
   :t==='matching'?(it.choices||[]).map(c=>'<label class="slot">'+esc(c)+' → <select class="seq">'+opts(it.targets||[])+'</select></label>').join('')
   :(it.choices||[]).map((c,i)=>'<button class="choice" onclick="choose('+i+')">'+esc(c)+'</button>').join('');
  const cases=(it.cases||[]).length?'<div class="cases">'+it.cases.map((c,i)=>'<div><b>Case '+'AB'[i]+'</b><p>'+esc(c)+'</p></div>').join('')+'</div>':'';
  box('<b>'+esc(t)+'</b>'+(d.cueText?'<p><i>'+esc(d.cueText)+'</i></p>':'')+'<p>'+esc(it.stem)+'</p>'+cases+body+(slots?'<p><button class="primary" onclick="seq(this)">Submit</button></p>':'')
   +(t==='scrap_work'?'<p><label>Photo of your working <input type="file" class="photo" accept="image/png,image/jpeg,image/webp" multiple></label> <button onclick="photo(this)">Send photo</button> <span class="mute">or type your working below</span></p>':''))}
 if(ev==='transcription.review')box('<b>Check the transcription</b><p>Fix anything that was misread. Only the text you confirm is graded.</p><textarea class="tr" rows="8" aria-label="Transcription of your working">'+esc(d.text)+'</textarea><p><button class="primary" onclick="confirmTr(this)">Confirm and submit</button></p>');
 if(ev==='feedback.present'){feedback=d.attemptId;lastAttempt=d.attemptId;
  const g=d.grade,crit=(g.criterionEvidence||[]).map(c=>'<li>'+(c.satisfied===true?'met':c.satisfied===false?'not met':'not observed')+': '+esc(c.criterion)+(c.quote?' <i>"'+esc(c.quote)+'"</i>':'')+'</li>').join('');
  const fl=(g.flaws||[]).map(f=>'<li><b>'+esc(f.severity)+'</b>: '+(f.quote?'"'+esc(f.quote)+'" ':'')+esc(f.problem)+(f.suggestion?' Try: '+esc(f.suggestion):'')+'</li>').join('');
  box('<b>Score '+g.score0to100+'</b><p>'+esc(g.feedback)+'</p>'+(crit?'<p class="mute">Criteria</p><ul>'+crit+'</ul>':'')+(fl?'<p class="mute">Flaws</p><ul>'+fl+'</ul>':'')+cites(d.citations)+'<p class="mute">Press OK, next to continue, or Dispute grade.</p>')}
 if(ev==='repair.required'){box('<b>Fix this first, then submit again</b><ul>'+d.flaws.map(f=>'<li>"'+esc(f.quote)+'": '+esc(f.problem)+'</li>').join('')+'</ul>');$('answer').hidden=false;st.querySelectorAll('button[disabled]').forEach(b=>b.disabled=false)}
 if(ev==='error'&&d.retry)box('<b class="err">A model call failed</b><p>'+esc(d.message||d.code||'')+'</p><button class="primary" onclick="retry()">Retry</button>');
 if(ev==='confirm.required'&&d.action==='leaveWithGaps'&&confirm(d.text))call('control.leaveWithGaps',{confirmToken:d.token});
 if(ev==='export.ready')box('<b>Export: '+esc(d.what)+'</b><p>'+(d.available?'Written to '+esc(d.dir||''):esc(d.note||'not available'))+'</p>');
 if(ev==='hint.reveal')box('<b>Hint</b><p>'+esc(d.text)+'</p>');
 if(ev==='plan.changed'||ev==='notice'||ev==='pace.notice'||ev==='research.ready')box('<i>'+esc(d.text)+'</i>');
 if(ev==='plan.changed')call('plan.get').then(p=>p&&box('<b>Plan</b><ol>'+p.nodes.map(n=>'<li>'+esc(n.title)+' <span class="mute">('+n.estMinutes+' min; '+n.subskills.map(x=>esc(x.statement)).join('; ')+')</span></li>').join('')+'</ol>'));
 if(ev==='plan.fit'&&!d.fits){fit=d;box('<b>Plan does not fit the time</b><p>'+esc(d.text)+'</p><button onclick="extend()">Extend to '+d.estMin+' min</button><button onclick="merge()">Merge nodes</button><button onclick="speed()">Start in Speed-up</button>')}
}
// Opening a source while an item waits for an answer is logged as assistance (like Peek chunk); the link still opens.
const openSrc=a=>{if(sid)call('source.open',{spanId:a.dataset.span})};
const picked=()=>[...document.querySelectorAll('input.srcuse:checked')].map(x=>x.value);
async function sources(){const l=await rpc('sources.list',{}).catch(()=>[]);const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 $('srclist').innerHTML=l.filter(s=>s.status!=='removed').map(s=>'<div class="ev"><label><input type="checkbox" class="srcuse" value="'+esc(s.sourceId)+'"'+(s.status==='accepted'&&s.shareWithModels?'':' disabled')+'> <b>'+esc(s.title)+'</b></label> <span class="mute">'+esc(s.kind)+(s.examSample?', past exam':'')+' · '+s.spans+' spans · '+esc(s.status)+(s.status==='accepted'&&!s.shareWithModels?' (not shared)':'')+'</span>'
  +(s.warnings.length?'<p class="mute">'+s.warnings.map(esc).join(' ')+'</p>':'')
  +' <button data-id="'+esc(s.sourceId)+'" onclick="preview(this.dataset.id)">Preview</button>'+(s.status!=='accepted'||!s.shareWithModels?' <button data-id="'+esc(s.sourceId)+'" onclick="acceptSrc(this.dataset.id)">Accept and share excerpts with the models</button>':'')+' <button data-id="'+esc(s.sourceId)+'" onclick="removeSrc(this.dataset.id)">Remove</button></div>').join('')||'<p class="mute">No sources yet.</p>'}
async function addSource(){const f=$('srcfile').files[0],u=$('srcurl').value.trim(),exam=$('srcexam').checked?{examSample:true}:{};
 const b64=f=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]);r.onerror=rej;r.readAsDataURL(f)});
 const tr=$('srctr').value;if(!f&&u&&isYt(u)&&!tr.trim())return log('On YouTube, click Show transcript under the description, select all, copy, paste here.','err');
 const p=f?{name:f.name,dataBase64:await b64(f),...exam}:u?{url:u,...(isYt(u)?{transcript:tr}:{}),...exam}:null;if(!p)return log('Choose a file or paste a URL.','err');log('Reading '+(f?f.name:u)+'…');
 await rpc('sources.add',p).then(s=>log('Added "'+s.title+'" ('+s.spans+' spans). Preview it, then accept.')).catch(e=>log(e.message,'err'));$('srcfile').value='';$('srcurl').value='';$('srctr').value='';ytCheck();sources()}
const isYt=u=>{try{return ['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(new URL(u).hostname)}catch{return false}};
const ytCheck=()=>{$('ytpaste').hidden=!isYt($('srcurl').value.trim())};
const preview=id=>rpc('sources.preview',{sourceId:id}).then(v=>log(v.title+'\\n\\n'+v.excerpts.slice(0,8).map(e=>'['+e.locator+(e.link?' '+e.link:'')+'] '+e.text).join('\\n\\n'))).catch(e=>log(e.message,'err'));
const acceptSrc=id=>{if(confirm('Excerpts of this source will be sent to the planner and generator models when a session uses it. Accept and share?'))rpc('sources.accept',{sourceId:id,shareWithModels:true}).then(sources).catch(e=>log(e.message,'err'))};
const removeSrc=id=>{if(confirm('Remove this source? Sage will not use it again.'))rpc('sources.remove',{sourceId:id}).then(sources).catch(e=>log(e.message,'err'))};
const setVault=()=>rpc('settings.set',{vaultPath:$('vault').value.trim()||null}).then(v=>log(v.vaultPath?'Exports now go to '+v.vaultPath+'\\Sage (your notes are never overwritten)':'Vault cleared; exports go to SAGE_HOME')).catch(e=>log(e.message,'err'));
async function create(){const r=await rpc('session.create',{goal:{objective:$('obj').value,mode:'cram',timeBudgetMin:+$('mins').value,...(picked().length?{sourceIds:picked()}:{})}}).catch(e=>log(e.message,'err'));if(r){sid=r.sessionId;log('session '+sid)}}
async function resume(id){if(!id)return;sid=id;await rpc('session.resume',{sessionId:id,takeLease:true}).then(()=>state()).catch(e=>log(e.message,'err'))}
const submit=()=>{call('item.submit',{text:$('resp').value});$('resp').value='';$('answer').hidden=true};
const choose=i=>{call('item.submit',{choice:i});$('answer').hidden=true};
const seq=b=>{const v=[...b.closest('div').querySelectorAll('select.seq')].map(s=>s.value);if(v.some(x=>x===''))return log('Choose an option in every slot first.','err');b.disabled=true;call('item.submit',{indices:v.map(Number)})};
let tmodel='the transcriber model';
const photo=async b=>{const files=[...b.parentElement.querySelector('input.photo').files];if(!files.length)return log('Choose a photo first.','err');
 if(!confirm('Send '+files.length+' photo(s) to '+tmodel+' to read your working? Only the photos go; you check the text before it is graded.'))return;
 const b64=f=>new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]);r.onerror=rej;r.readAsDataURL(f)});
 b.disabled=true;call('image.consent',{images:await Promise.all(files.map(async f=>({dataBase64:await b64(f)})))}).then(v=>v&&log('Reading your working…'))};
const confirmTr=b=>{const t=b.closest('div').querySelector('textarea.tr').value;if(!t.trim())return log('The transcription is empty.','err');b.disabled=true;call('transcription.confirm',{text:t});$('answer').hidden=true};
const retry=()=>call('session.retry');
const ack=()=>feedback&&call('feedback.ack',{attemptId:feedback}).then(()=>feedback=null);
const state=()=>call('state.get').then(v=>{if(!v)return v;feedback=v.feedbackAttemptId||null;if(feedback)lastAttempt=feedback;if(v.current&&v.current.item&&!feedback)show('item.present',{item:v.current.item});return v});
const exp=()=>call('export.get').then(v=>v&&log('Exported to '+v.dir+(v.userEdited.length?' (kept your edits: '+v.userEdited.join(', ')+')':'')+'\\n\\n'+v.sessionMd.slice(0,6000)));

const extend=()=>call('time.extend',{minutes:fit.estMin-fit.budgetMin}),speed=()=>call('pace.set',{pace:'speed_up'});
async function merge(){for(const g of fit.mergeGroups)await call('plan.merge',{nodeIds:g})}
function dispute(){if(!lastAttempt)return log('nothing to dispute','err');const a=prompt('Why is the grade or answer key wrong?');if(a)call('grade.dispute',{attemptId:lastAttempt,argument:a})}
async function accept(){const s=await call('research.status');const p=s&&s.packs.find(p=>p.status==='pending');if(p)call('sources.acceptPack',{packId:p.id});else log('no pending research pack')}
connect();
</script></body></html>`;
