// lib/speedTarget.selftest.ts — npx tsx lib/speedTarget.selftest.ts
import assert from 'node:assert/strict';
import { appTarget, cloudflareTarget, probeVerdict, rateLimitMessage, CLOUDFLARE_HOST, historyServers, filterHistory, serverFilterChip, UNRECORDED_SERVER } from './speedTarget';

let n = 0;
const ok = (cond: boolean, what: string) => { assert.ok(cond, what); n++; };

const app = appTarget('https://api.example.com/', 'tok');
ok(app.kind === 'app' && app.host === 'api.example.com', '1. app target names its own host');
ok(app.downUrl(1000) === 'https://api.example.com/net/speed/down?bytes=1000', '2. download URL per the contract');
ok(app.pingUrl.endsWith('bytes=0'), '3. ping uses the empty-body probe (bytes=0)');
ok(app.upUrl === 'https://api.example.com/net/speed/up', '4. upload URL per the contract');
ok(app.headers.Authorization === 'Bearer tok', '5. the app endpoints get the bearer token');
const cf = cloudflareTarget();
ok(cf.kind === 'cloudflare' && cf.host === CLOUDFLARE_HOST && cf.pingUrl.endsWith('bytes=1'), '6. fallback is today\'s Cloudflare test');
ok(Object.keys(cf.headers).length === 0, '7. the token is never sent to Cloudflare');
ok(probeVerdict(200) === 'app' && probeVerdict(204) === 'app', '8. 2xx: the endpoint exists');
ok(probeVerdict(404) === 'fallback' && probeVerdict(405) === 'fallback', '9. 404/405 (not deployed): fall back');
ok(probeVerdict(null) === 'fallback' && probeVerdict(503) === 'fallback' && probeVerdict(401) === 'fallback', '10. no answer, 5xx, 401: fall back');
ok(probeVerdict(429) === 'rate_limited', '11. 429 is the budget, not a missing endpoint');
ok(rateLimitMessage('120') === 'Too many speed tests. Try again in 2 min.', '12. Retry-After seconds become minutes');
ok(rateLimitMessage('5') === 'Too many speed tests. Try again in 1 min.', '13. under a minute rounds up to 1');
ok(rateLimitMessage(null) === 'Too many speed tests. Try again later.' && rateLimitMessage('soon') === 'Too many speed tests. Try again later.',
  '14. a missing or unreadable Retry-After still gives a sentence');

// History by server: results from different servers are not comparable.
const rows = [{ id: 'a', server: 'speed.cloudflare.com' }, { id: 'b', server: 'api.example.com' }, { id: 'c' }, { id: 'd', server: 'speed.cloudflare.com' }];
ok(JSON.stringify(historyServers(rows)) === JSON.stringify(['speed.cloudflare.com', 'api.example.com', UNRECORDED_SERVER]),
  '15. servers listed once each, most recent first, old rows under one label');
ok(historyServers([]).length === 0 && historyServers([{}]).length === 1, '16. empty list has no servers; an old row is still one');
ok(filterHistory(rows, null).length === 4, '17. no filter keeps every row');
ok(filterHistory(rows, 'speed.cloudflare.com').map(r => r.id).join() === 'a,d', '18. a filter keeps only that server, in order');
ok(filterHistory(rows, UNRECORDED_SERVER).map(r => r.id).join() === 'c', '19. rows saved before the server was recorded can be picked');
ok(filterHistory(rows, 'gone.example').length === 4, '20. a server no longer in the list falls back to all rows, never an empty list');

ok(serverFilterChip(null).label === 'All servers' && serverFilterChip(null).text === 'All', '21. the All chip');
ok(serverFilterChip(UNRECORDED_SERVER).label === 'Older results, server not recorded'
  && !/Measured by/.test(serverFilterChip(UNRECORDED_SERVER).label), '22. unrecorded rows read naturally');
ok(serverFilterChip('api.example.com').label === 'Measured by api.example.com', '23. a named server');

console.log(`speedTarget.selftest: ${n} assertions passed`);
