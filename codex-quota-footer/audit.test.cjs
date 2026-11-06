const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/quota-footer.js','utf8').replace(/^import .*;\r?\n/gm,'').replace(/export /g,'');
function harness(){
 let now=10000,effect,timer,focus,removed=false,cleared=false,requests=[],states=[],client;
 const React={useState:()=>[{data:null},s=>states.push(s)],useEffect:f=>effect=f};
 client={rpc:{sendRequest(method,params,opts){assert.equal(method,'account/rateLimits/read');assert.equal(opts.timeoutMs,15000);return new Promise((resolve,reject)=>requests.push({resolve,reject}));}}};
 const C={console:{warn(){}},AbortController,AbortSignal,initializeClients(){},react:()=>React,jsxRuntime:()=>({jsx:(_,p)=>p}),
  useKeyedSignal:()=>client,clientSignal:{},awaitRpc(p,signal){assert.equal(signal.aborted,false);signal.addEventListener('abort',()=>{}, {once:true});C.lastSignal=signal;return p;},
  Date:class extends Date{static now(){return now;}},setInterval(f,ms){assert.equal(ms,60000);timer=f;return 1},clearInterval(){cleared=true},
  window:{addEventListener(e,f){assert.equal(e,'focus');focus=f},removeEventListener(e,f){assert.equal(f,focus);removed=true}}};
 vm.createContext(C);vm.runInContext(source,C);C.CodexQuotaFooter();const dispose=effect();
 return {C,states,requests,dispose,focus:()=>focus(),poll:()=>timer(),advance:n=>now+=n,cleanup:()=>cleared&&removed};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('RPC path, immediate read, 60s refresh, focus throttle and cleanup abortion',async()=>{
 const h=harness();try{
  assert.equal(h.requests.length,1);h.focus();h.poll();assert.equal(h.requests.length,1);
  const data={rateLimits:{primary:{windowDurationMins:300,usedPercent:19}}};
  h.requests[0].resolve(data);await tick();assert.equal(h.states.at(-1).data,data);
  h.focus();assert.equal(h.requests.length,1);h.advance(60000);h.poll();assert.equal(h.requests.length,2);
  h.dispose();assert.equal(h.C.lastSignal.aborted,true);assert.equal(h.cleanup(),true);
  const count=h.states.length;h.requests[1].resolve(data);await tick();assert.equal(h.states.length,count);
 }finally{h.dispose();}
});
test('failed read clears stale data and next minute can recover',async()=>{
 const h=harness();try{
  h.requests[0].reject(Error('offline'));await tick();assert.equal(h.states.at(-1).error,true);assert.equal(h.states.at(-1).data,null);
  h.advance(60000);h.poll();h.requests[1].resolve({rateLimits:{}});await tick();assert.equal(h.states.at(-1).error,false);
 }finally{h.dispose();}
});
test('window matching, named bucket preference, missing values and bounds',()=>{
 const h=harness();try{
  const format=h.C.quotaText;
  assert.equal(format(null),'5h -- | 1week --');
  assert.equal(format({rateLimits:{primary:{windowDurationMins:10080,usedPercent:35},secondary:{windowDurationMins:300,usedPercent:60}}}),'5h 40% | 1week 65%');
  assert.equal(format({rateLimitsByLimitId:{codex:{primary:{windowDurationMins:300,usedPercent:100}}},rateLimits:{primary:{windowDurationMins:300,usedPercent:0}}}),'5h 0% | 1week --');
  for(const invalid of [null,undefined,NaN,Infinity,'30'])assert.equal(format({rateLimits:{primary:{windowDurationMins:300,usedPercent:invalid}}}),'5h -- | 1week --');
  assert.equal(format({rateLimits:{primary:{windowDurationMins:300,usedPercent:-2},secondary:{windowDurationMins:10080,usedPercent:103}}}),'5h 100% | 1week 0%');
 }finally{h.dispose();}
});
test('tooltip shows both reset timestamps and duration-matched countdowns',()=>{
 const h=harness();try{
  const now=Date.parse('2026-11-06T00:00:00Z');
  const data={rateLimits:{primary:{windowDurationMins:10080,resetsAt:now/1000+2*86400+3*3600+240},secondary:{windowDurationMins:300,resetsAt:now/1000+3900}}};
  const text=h.C.quotaTooltip(data,false,now),lines=text.split('\n');
  assert.match(lines[0],/^5h：.*2026.*重置（还有 1小时5分钟）$/);
  assert.match(lines[1],/^周额度：.*2026.*重置（还有 2天3小时4分钟）$/);
  assert.match(h.C.quotaTooltip(data,false,now+60000),/还有 1小时4分钟/);
  const props=h.C.CodexQuotaFooter();const target={title:''};props.onMouseEnter({currentTarget:target});assert.match(target.title,/5h：/);
  assert.doesNotMatch(text,/每分钟|更新于|刷新/);
 }finally{h.dispose();}
});
test('tooltip handles missing, invalid, expired and unavailable reset data honestly',()=>{
 const h=harness();try{
  assert.equal(h.C.quotaTooltip(null),'5h：未提供重置时间\n周额度：未提供重置时间');
  for(const resetsAt of [null,undefined,NaN,Infinity,-1,0,'123',1e20])assert.match(h.C.quotaTooltip({rateLimits:{primary:{windowDurationMins:300,resetsAt}}}),/^5h：未提供重置时间/);
  assert.match(h.C.quotaTooltip({rateLimits:{primary:{windowDurationMins:300,resetsAt:100}}},false,200000),/等待服务端更新/);
  assert.equal(h.C.quotaTooltip(null,true),'5h：暂时无法读取\n周额度：暂时无法读取');
 }finally{h.dispose();}
});
