const http=require('http'),WebSocket=require('ws');
const B='http://127.0.0.1:8090',LIVE=B.replace(/^http/,'ws')+'/live/ws';
const ag=new http.Agent({keepAlive:true,maxSockets:100});
const N=Number(process.env.N||200);
function post(p,b){return new Promise((s,j)=>{const d=Buffer.from(JSON.stringify(b));const r=http.request(B+p,{method:'POST',agent:ag,headers:{'content-type':'application/json','content-length':d.length}},x=>{const c=[];x.on('data',y=>c.push(y));x.on('end',()=>s({headers:x.headers,body:Buffer.concat(c).toString()}))});r.on('error',j);r.end(d)})}
async function sess(id){const t=JSON.parse((await post('/dev/launch-token',{vaultId:id,displayName:id})).body).token;const s=await post('/api/session',{token:t});return (s.headers['set-cookie']||[]).map(c=>c.split(';')[0]).find(c=>c.startsWith('gsid='))}
(async()=>{
const ck=[];for(let i=0;i<N;i++){try{ck.push(await sess('@d2'+i))}catch{}}
process.stderr.write('minted '+ck.length+'\n');
let ok=0,fail=0;const socks=[];
// open ALL concurrently, hold
await Promise.all(ck.map(c=>new Promise(r=>{const s=new WebSocket(LIVE,{headers:{Cookie:c}});
s.once('open',()=>{ok++;socks.push(s);r()});s.once('error',()=>{fail++;r()});setTimeout(()=>r(),10000)})));
const live=socks.filter(s=>s.readyState===1).length;
console.log(JSON.stringify({target:N,opened:ok,failed:fail,liveAfterOpen:live}));
socks.forEach(s=>{try{s.close()}catch{}});setTimeout(()=>process.exit(0),300);
})();
