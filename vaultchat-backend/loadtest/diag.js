const http=require('http'),WebSocket=require('ws');
const B='http://127.0.0.1:8090',LIVE=B.replace(/^http/,'ws')+'/live/ws';
const ag=new http.Agent({keepAlive:true,maxSockets:50});
function post(p,b){return new Promise((s,j)=>{const d=Buffer.from(JSON.stringify(b));const r=http.request(B+p,{method:'POST',agent:ag,headers:{'content-type':'application/json','content-length':d.length}},x=>{const c=[];x.on('data',y=>c.push(y));x.on('end',()=>s({headers:x.headers,body:Buffer.concat(c).toString()}))});r.on('error',j);r.end(d)})}
async function sess(id){const t=JSON.parse((await post('/dev/launch-token',{vaultId:id,displayName:id})).body).token;const s=await post('/api/session',{token:t});return (s.headers['set-cookie']||[]).map(c=>c.split(';')[0]).find(c=>c.startsWith('gsid='))}
(async()=>{const errs={};let ok=0;
for(let i=0;i<40;i++){const ck=await sess('@dg'+i);
await new Promise(r=>{const s=new WebSocket(LIVE,{headers:{Cookie:ck}});
s.once('open',()=>{ok++;s.close();r()});
s.once('error',e=>{errs[e.message]=(errs[e.message]||0)+1;r()});
s.once('unexpected-response',(_,res)=>{errs['http'+res.statusCode]=(errs['http'+res.statusCode]||0)+1;r()});
setTimeout(()=>r(),3000);});
await new Promise(r=>setTimeout(r,60));}
console.log('ok',ok,'errs',JSON.stringify(errs));})();
