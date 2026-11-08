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
#stage>div{margin-bottom:12px}.choice{display:block;width:100%;text-align:left}
</style></head><body><main>
<div>
<section><h1>Sage dev console</h1>
<label>Objective<textarea id="obj" rows="2">Pass the theory part of my driving test next week</textarea></label>
<label>Minutes <input id="mins" type="number" value="60" min="5"></label>
<button class="primary" onclick="create()">Create Cram session</button>
<select id="sessions" onchange="resume(this.value)"><option value="">resume a session…</option></select>
</section>
<section><h2>Session</h2><div id="stage"><div class="mute">No session yet.</div></div>
<div id="answer" hidden><textarea id="resp" rows="4" placeholder="Your answer"></textarea>
<button class="primary" onclick="submit()">Submit</button><button onclick="call('hint.request',{level:1})">Hint 1</button><button onclick="call('hint.request',{level:2})">Hint 2</button><button onclick="call('hint.request',{level:3})">Hint 3</button><button onclick="call('chunk.peek')">Peek chunk</button></div>
<div><button onclick="call('plan.approve')">Approve plan</button><button onclick="ack()">OK, next</button><button onclick="call('control.advance')">Advance</button><button onclick="call('control.morePractice')">More practice</button><button onclick="call('control.teach')">Teach me</button><button onclick="call('pace.set',{pace:'speed_up'})">Speed up</button><button onclick="call('control.stop')">Stop</button><button onclick="accept()">Accept research</button><button onclick="state()">State</button><button onclick="exp()">Export</button><label><input type="checkbox" id="usage" checked onchange="rpc('usage.set',{enabled:this.checked}).then(v=>log('usage counters '+(v.enabled?'on':'off')+' (local only, nothing uploaded)'))"> Usage counters</label><button onclick="dispute()">Dispute grade</button></div>
</section>
</div>
<section><h2>Events</h2><div id="log" aria-live="polite"></div></section>
</main><script>
const ws=new WebSocket(location.origin.replace('http','ws')+'/ws'+location.search);let n=0,sid=null,feedback=null,pack=null,fit=null,lastAttempt=null;const pending={};
const $=id=>document.getElementById(id);
const log=(t,c)=>{const d=document.createElement('div');d.className='ev '+(c||'');d.textContent=t;$('log').prepend(d)};
const rpc=(method,params={})=>new Promise((res,rej)=>{const id=++n;pending[id]={res,rej};ws.send(JSON.stringify({jsonrpc:'2.0',id,method,params}))});
const call=(m,p={})=>rpc(m,{sessionId:sid,...p}).then(v=>(m==='state.get'&&log(JSON.stringify(v,null,1).slice(0,3000)),v)).catch(e=>log(m+': '+e.message,'err'));
ws.onopen=async()=>{for(const s of await rpc('session.list')){const o=document.createElement('option');o.value=s.sessionId;o.textContent=(s.objective||s.sessionId).slice(0,60);$('sessions').append(o)}};
ws.onmessage=m=>{const x=JSON.parse(m.data);if(x.id&&pending[x.id]){x.error?pending[x.id].rej(new Error(x.error.message)):pending[x.id].res(x.result);delete pending[x.id];return}
 if(x.method!=='event')return;const e=x.params,d=e.data;log(e.event+' '+JSON.stringify(d).slice(0,400),e.event==='error'?'err':'');show(e.event,d)};
function show(ev,d){const st=$('stage');const box=h=>{const div=document.createElement('div');div.innerHTML=h;st.prepend(div)};const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
 if(ev==='tutor.done')box('<b>Tutor</b><p>'+esc(d.text)+'</p>');
 if(ev==='item.present'){const it=d.item,t=it.activityType,slots=t==='ordering'||t==='matching';$('answer').hidden=slots;
  const opts=a=>'<option value="">choose</option>'+a.map((x,j)=>'<option value="'+j+'">'+esc(x)+'</option>').join('');
  const body=t==='ordering'?(it.choices||[]).map((_,p)=>'<label class="slot">Step '+(p+1)+' <select class="seq">'+opts(it.choices)+'</select></label>').join('')
   :t==='matching'?(it.choices||[]).map(c=>'<label class="slot">'+esc(c)+' → <select class="seq">'+opts(it.targets||[])+'</select></label>').join('')
   :(it.choices||[]).map((c,i)=>'<button class="choice" onclick="choose('+i+')">'+esc(c)+'</button>').join('');
  const cases=(it.cases||[]).length?'<div class="cases">'+it.cases.map((c,i)=>'<div><b>Case '+'AB'[i]+'</b><p>'+esc(c)+'</p></div>').join('')+'</div>':'';
  box('<b>'+esc(t)+'</b>'+(d.cueText?'<p><i>'+esc(d.cueText)+'</i></p>':'')+'<p>'+esc(it.stem)+'</p>'+cases+body+(slots?'<p><button class="primary" onclick="seq(this)">Submit</button></p>':'')
   +(t==='scrap_work'?'<p><label>Photo of your working <input type="file" class="photo" accept="image/png,image/jpeg,image/webp" multiple></label> <button onclick="photo(this)">Send photo</button> <span class="mute">or type your working below</span></p>':''))}
 if(ev==='transcription.review')box('<b>Check the transcription</b><p>Fix anything that was misread. Only the text you confirm is graded.</p><textarea class="tr" rows="8" aria-label="Transcription of your working">'+esc(d.text)+'</textarea><p><button class="primary" onclick="confirmTr(this)">Confirm and submit</button></p>');
 if(ev==='feedback.present'){feedback=d.attemptId;lastAttempt=d.attemptId;box('<b>Score '+d.grade.score0to100+'</b><p>'+esc(d.grade.feedback)+'</p>')}
 if(ev==='repair.required')box('<b>Fix this first</b><ul>'+d.flaws.map(f=>'<li>"'+esc(f.quote)+'": '+esc(f.problem)+'</li>').join('')+'</ul>');
 if(ev==='hint.reveal')box('<b>Hint</b><p>'+esc(d.text)+'</p>');
 if(ev==='plan.changed'||ev==='notice'||ev==='pace.notice'||ev==='research.ready')box('<i>'+esc(d.text)+'</i>');
 if(ev==='plan.changed')call('plan.get').then(p=>p&&box('<b>Plan</b><ol>'+p.nodes.map(n=>'<li>'+esc(n.title)+' <span class="mute">('+n.estMinutes+' min; '+n.subskills.map(x=>esc(x.statement)).join('; ')+')</span></li>').join('')+'</ol>'));
 if(ev==='plan.fit'&&!d.fits){fit=d;box('<b>Plan does not fit the time</b><p>'+esc(d.text)+'</p><button onclick="extend()">Extend to '+d.estMin+' min</button><button onclick="merge()">Merge nodes</button><button onclick="speed()">Start in Speed-up</button>')}
}
async function create(){const r=await rpc('session.create',{goal:{objective:$('obj').value,mode:'cram',timeBudgetMin:+$('mins').value}}).catch(e=>log(e.message,'err'));if(r){sid=r.sessionId;log('session '+sid)}}
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
const ack=()=>feedback&&call('feedback.ack',{attemptId:feedback}).then(()=>feedback=null);
const state=()=>call('state.get');
const exp=()=>call('export.get').then(v=>v&&log('Exported to '+v.dir+(v.userEdited.length?' (kept your edits: '+v.userEdited.join(', ')+')':'')+'\\n\\n'+v.sessionMd.slice(0,6000)));
ws.addEventListener('open',()=>{rpc('usage.get',{}).then(v=>{$('usage').checked=v.enabled!==false}).catch(()=>{});rpc('settings.get',{}).then(v=>{const m=v.roleModels.transcriber;if(m)tmodel=m.provider+'/'+m.model}).catch(()=>{})});
const extend=()=>call('time.extend',{minutes:fit.estMin-fit.budgetMin}),speed=()=>call('pace.set',{pace:'speed_up'});
async function merge(){for(const g of fit.mergeGroups)await call('plan.merge',{nodeIds:g})}
function dispute(){if(!lastAttempt)return log('nothing to dispute','err');const a=prompt('Why is the grade or answer key wrong?');if(a)call('grade.dispute',{attemptId:lastAttempt,argument:a})}
async function accept(){const s=await call('research.status');const p=s&&s.packs.find(p=>p.status==='pending');if(p)call('sources.acceptPack',{packId:p.id});else log('no pending research pack')}
</script></body></html>`;
