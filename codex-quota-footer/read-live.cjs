const {spawn}=require('node:child_process');
const path=require('node:path');
const exe=path.join(process.env.CODEX_EXTENSION_DIR||path.join(require('node:os').homedir(),'.vscode/extensions/openai.chatgpt-26.1021.22027'),'bin/windows-x86_64/codex.exe');
const proc=spawn(exe,['app-server'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
let buffer='',done=false;
const timer=setTimeout(()=>finish('Timed out reading quota',1),25000);
function finish(text,code=0){if(done)return;done=true;clearTimeout(timer);console.log(text);proc.stdin.end();proc.kill();process.exitCode=code;}
function send(o){proc.stdin.write(JSON.stringify(o)+'\n')}
proc.on('error',()=>finish('Cannot launch bundled app-server',1));
proc.on('exit',()=>{if(!done)finish('App-server exited before returning quota',1)});
proc.stderr.on('data',()=>{});
proc.stdin.on('error',()=>{if(!done)finish('App-server input closed before returning quota',1)});
proc.stdout.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,n);buffer=buffer.slice(n+1);let m;try{m=JSON.parse(line)}catch{continue}
  if(m.id===1){if(m.error)return finish('Initialize failed: '+m.error.message,1);send({method:'initialized'});send({id:2,method:'account/rateLimits/read',params:{}})}
  if(m.id===2){if(m.error)return finish('Quota read failed: '+m.error.message,1);const s=m.result?.rateLimitsByLimitId?.codex??m.result?.rateLimits;const windows=[s?.primary,s?.secondary];const pct=d=>{let w=windows.find(w=>w?.windowDurationMins===d);return typeof w?.usedPercent==='number'?Math.round(Math.max(0,Math.min(100,100-w.usedPercent)))+'%':'--'};finish('LIVE remaining: 5h '+pct(300)+' | 1week '+pct(10080));}
}});
send({id:1,method:'initialize',params:{clientInfo:{name:'local_quota_check',version:'1.0.0'}}});
