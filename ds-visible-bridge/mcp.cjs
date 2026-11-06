'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),readline=require('node:readline'),crypto=require('node:crypto');
const STATE=path.join(__dirname,'state'),RUNS=path.join(__dirname,'messages');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function rpc(d,request,{signal}={}){return new Promise((resolve,reject)=>{
 const socket=net.createConnection(d.pipe);socket.setEncoding('utf8');let b='',settled=false;
 function finish(error,result){if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);socket.destroy();error?reject(error):resolve(result);}
 const timeout=request.action==='wait_event'?((request.wait_seconds??3600)+10)*1000:8000;
 const timer=setTimeout(()=>finish(Error('VS Code bridge timed out. Delivery may be uncertain; inspect the original conversation before retrying.')),timeout);
 function abort(){finish(Error('Report wait cancelled. The DS task itself was not cancelled.'));}
 if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});
 socket.once('connect',()=>socket.write(JSON.stringify({...request,token:d.token})+'\n'));
 socket.on('data',data=>{b+=data;if(b.length>4000000)return finish(Error('Bridge response too large'));if(b.includes('\n'))try{const r=JSON.parse(b.split('\n')[0]);finish(r.error?Error(r.error):null,r.result);}catch(error){finish(error);}});
 socket.on('error',error=>finish(error));socket.on('close',()=>{if(!settled)finish(Error('Bridge connection closed before its receipt. Inspect the original conversation before retrying.'));});
});}
async function windows(){const result=[];for(const file of fs.existsSync(STATE)?fs.readdirSync(STATE):[]){if(!/^window-\d+\.json$/.test(file))continue;try{const d=JSON.parse(fs.readFileSync(path.join(STATE,file),'utf8'));const info=await rpc(d,{action:'info'});result.push({d,info});}catch{}}return result;}
const norm=p=>path.resolve(p).toLowerCase();
const targetWindows=new Map();
async function call(name,a={},options={}){
 if(name==='ds_visible_sessions')return {mode:'open-session-chat',windows:(await windows()).map(w=>w.info),instructions:'Send messages to an open live Claude Code conversation, including background tabs. No separate DS process is started. The conversation handles its normal permissions. Choose when to delegate naturally. Route automatically by project and session metadata without routine user confirmation; report unresolved routing instead of guessing. Use ds_wait_report after dispatch; ordinary logs stay local. No fixed role split is required.'};
 if(name==='ds_send_message'){
  if(!path.isAbsolute(a.project_dir||''))throw Error('project_dir must be absolute.');
  let list=(await windows()).filter(w=>w.info.roots.some(r=>norm(r)===norm(a.project_dir))&&(!a.session_id||w.info.sessions.some(s=>s.session_id===a.session_id)));
  if(list.length>1){
   const previous=list.filter(w=>w.info.window_id===targetWindows.get(norm(a.project_dir))),focused=list.filter(w=>w.info.window_focused),live=list.filter(w=>w.info.sessions.some(s=>norm(s.project_dir||'')===norm(a.project_dir)));
   if(previous.length===1)list=previous;else if(focused.length===1)list=focused;else if(live.length===1)list=live;
  }
  if(list.length!==1)throw Error('Expected one VS Code window on this project. Reload the project window if the bridge is not loaded. Found '+list.length);
  const request_id=a.request_id||crypto.randomUUID();
  if(!/^[0-9a-f-]{36}$/i.test(request_id))throw Error('request_id must be a UUID');
  try{const result=await rpc(list[0].d,{...a,action:'send',request_id});if(result.status==='running'||result.status==='completed')targetWindows.set(norm(a.project_dir),list[0].info.window_id);return result;}
  catch(error){throw Error(error.message+' Request ID: '+request_id+'. Do not blindly resend; read ds_reply_status for this ID first.');}
 }
 if(name==='ds_reply_status'||name==='ds_cancel_message'||name==='ds_wait_report'){
  if(!/^[0-9a-f-]{36}$/.test(a.message_id||''))throw Error('Invalid message_id');
  const file=path.join(RUNS,a.message_id+'.json');
  let task=null;
  try{if(fs.existsSync(file))task=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
  const candidates=(await windows()).filter(w=>!task?.window_id||w.info.window_id===task.window_id);
  let owner=null;
  for(const w of candidates)try{task=await rpc(w.d,{action:'status',message_id:a.message_id});owner=w;break;}catch{}
  if(!task)throw Error('Unknown message_id');
  if(name==='ds_cancel_message'){
   if(task.status!=='running')return task;
   if(!owner)throw Error('The original session is not connected. No interrupt was sent.');
   return rpc(owner.d,{action:'cancel',message_id:a.message_id});
  }
  if(name==='ds_wait_report'){
   const wait=a.wait_seconds??3600,cursor=a.after_event??0;
   if(!Number.isInteger(wait)||wait<0||wait>7200||!Number.isInteger(cursor)||cursor<0)throw Error('wait_seconds must be 0–7200 and after_event must be nonnegative');
   if(!owner)return {message_id:a.message_id,status:task.status==='running'?'disconnected':task.status,report_type:'disconnected',reply:(task.reply||'').slice(-14000),error:'The original window is disconnected. Do not blindly resend the task.'};
   return rpc(owner.d,{action:'wait_event',message_id:a.message_id,wait_seconds:wait,after_event:cursor},options);
  }
  const wait=a.wait_seconds??0;if(!Number.isInteger(wait)||wait<0||wait>20)throw Error('wait_seconds must be 0–20');
  let latest=task;const end=Date.now()+wait*1000;
  if(!owner&&latest.status==='running')latest={...latest,status:'disconnected',error:'The original window is not connected. Completion cannot be confirmed; inspect the original chat before retrying.'};
  while(owner&&latest.status==='running'&&Date.now()<end){await sleep(500);let next;
   try{next=await rpc(owner.d,{action:'status',message_id:a.message_id});}catch{latest={...latest,status:'disconnected',error:'Connection lost while waiting. Completion is unknown.'};break;}
   if(next.updated_at!==latest.updated_at||next.status!==latest.status){latest=next;break;}latest=next;
  }
  return {...latest,reply:(latest.reply||'').slice(-14000),reply_truncated:(latest.reply||'').length>14000};
 }
 throw Error('Unknown tool');
}
const defs=[
 {name:'ds_wait_report',description:'Preferred after dispatch: wait locally until DS completes or reports a key checkpoint. Ordinary logs never end this wait and do not need model analysis. Returns only completion, a checkpoint, disconnection or timeout. Pass event_cursor back as after_event to wait for the next event. Keep the original Codex turn awaiting this tool; this is a tool-result handoff, not waking an ended chat. Requires ds_worker tool_timeout_sec=7500 for long tasks. After completion inspect diff/tests, send bounded revision requests if needed, then wait again. On blocked/decision ask for a decision instead of looping. No periodic ds_reply_status calls while waiting.',inputSchema:{type:'object',properties:{message_id:{type:'string'},after_event:{type:'integer',minimum:0},wait_seconds:{type:'integer',minimum:0,maximum:7200}},required:['message_id'],additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'ds_visible_sessions',description:'List open live Claude Code / DeepSeek sessions in VS Code, including background tabs and hidden sidebars. The legacy tool name is retained. visible is metadata, not a sending requirement.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'ds_send_message',description:'Send a collaboration message directly into the existing open Claude Code / DeepSeek chat (foreground or background) and trigger its reply in that same session. Use for advice, investigation, code changes, or follow-up; there is no fixed workflow. Messages appear in the original panel when the user switches back. Routing automatically prefers the last successful session for this project, then its last-focused chat. Do not ask routine destination confirmation. Supply session_id to intentionally choose another known session; never guess an ambiguous destination. Visibility never selects the target. Requires exact project_dir and optionally session_id. Returns message_id immediately; await ds_wait_report for completion or a key checkpoint. Do not repeatedly query ds_reply_status or analyze ordinary logs while DS works. Use revision_of when sending corrective feedback; at most three automatic revision rounds. Do not edit the same files concurrently. Existing UI permissions remain in force.',inputSchema:{type:'object',properties:{project_dir:{type:'string'},message:{type:'string'},session_id:{type:'string'},revision_of:{type:'string',description:'Previous message_id when submitting corrective feedback in the same workflow. Maximum three automatic revisions.'},request_id:{type:'string',description:'Optional stable UUID for this logical delivery. Reuse only for identical content after checking uncertain delivery.'}},required:['project_dir','message'],additionalProperties:false},annotations:{readOnlyHint:false}},
 {name:'ds_reply_status',description:'Read the actual visible DS chat reply, tool operations, and completion status for a sent message. Continue the right-side Codex conversation using this reply. You may send a follow-up through ds_send_message when useful.',inputSchema:{type:'object',properties:{message_id:{type:'string'},wait_seconds:{type:'integer',minimum:0,maximum:20}},required:['message_id'],additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'ds_cancel_message',description:'Interrupt a message sent into the live DS conversation, keeping edits already made.',inputSchema:{type:'object',properties:{message_id:{type:'string'}},required:['message_id'],additionalProperties:false},annotations:{readOnlyHint:false}}
];
if(require.main===module){
 const controllers=new Map(),input=readline.createInterface({input:process.stdin}),send=x=>process.stdout.write(JSON.stringify(x)+'\n');
 input.on('line',async line=>{
  let r;try{r=JSON.parse(line);}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}});return;}
  if(!r||typeof r!=='object'||Array.isArray(r)||r.jsonrpc!=='2.0'||typeof r.method!=='string'){send({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}});return;}
  if(r.method==='notifications/cancelled'){controllers.get(r.params?.requestId)?.abort();return;}
  if(r.id===undefined)return;
  let controller;
  try{
   let result;
   if(r.method==='initialize')result={protocolVersion:r.params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'ds-visible-bridge',version:'0.3.0'},instructions:'Use ds_send_message then ds_wait_report. Wait locally for completion or key checkpoints without periodic status/log analysis. On completion verify results; when necessary use bounded revision requests and wait again. Stop automatic retries after three revision rounds or on a decision/blocker. This returns into the waiting Codex turn; it does not wake an ended chat. Automatically route by project/session without routine confirmation. Never start a hidden DS process.'};
   else if(r.method==='tools/list')result={tools:defs};
   else if(r.method==='ping')result={};
   else if(r.method==='tools/call'){
    if(controllers.has(r.id))throw Error('Duplicate request id');controller=new AbortController();controllers.set(r.id,controller);
    try{result={content:[{type:'text',text:JSON.stringify(await call(r.params.name,r.params.arguments,{signal:controller.signal}))}]};}
    catch(error){result={isError:true,content:[{type:'text',text:error.message}]};}
   }else{send({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'Unknown method'}});return;}
   send({jsonrpc:'2.0',id:r.id,result});
  }catch(error){send({jsonrpc:'2.0',id:r.id,error:{code:-32603,message:error.message}});}
  finally{if(controller)controllers.delete(r.id);}
 });
 input.on('close',()=>{for(const controller of controllers.values())controller.abort();});
}
module.exports={call};
