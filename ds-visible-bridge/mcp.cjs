'use strict';
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),readline=require('node:readline'),crypto=require('node:crypto');
const STATE=path.join(__dirname,'state'),RUNS=path.join(__dirname,'messages');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function rpc(d,request){return new Promise((resolve,reject)=>{
 const socket=net.createConnection(d.pipe);socket.setEncoding('utf8');let b='',settled=false;
 function finish(error,result){if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(result);}
 const timer=setTimeout(()=>finish(Error('VS Code bridge timed out. Delivery may be uncertain; inspect the original conversation before retrying.')),8000);
 socket.once('connect',()=>socket.write(JSON.stringify({...request,token:d.token})+'\n'));
 socket.on('data',data=>{b+=data;if(b.length>4000000)return finish(Error('Bridge response too large'));if(b.includes('\n'))try{const r=JSON.parse(b.split('\n')[0]);finish(r.error?Error(r.error):null,r.result);}catch(error){finish(error);}});
 socket.on('error',error=>finish(error));socket.on('close',()=>{if(!settled)finish(Error('Bridge connection closed before its receipt. Inspect the original conversation before retrying.'));});
});}
async function windows(){const result=[];for(const file of fs.existsSync(STATE)?fs.readdirSync(STATE):[]){if(!/^window-\d+\.json$/.test(file))continue;try{const d=JSON.parse(fs.readFileSync(path.join(STATE,file),'utf8'));const info=await rpc(d,{action:'info'});result.push({d,info});}catch{}}return result;}
const norm=p=>path.resolve(p).toLowerCase();
async function call(name,a={}){
 if(name==='ds_visible_sessions')return {mode:'visible-middle-chat',windows:(await windows()).map(w=>w.info),instructions:'Send messages to the real middle Claude Code conversation. No separate DS process is started. The conversation handles its normal permissions. Choose when to delegate naturally; no fixed plan/execute workflow is required.'};
 if(name==='ds_send_message'){
  if(!path.isAbsolute(a.project_dir||''))throw Error('project_dir must be absolute.');
  const list=(await windows()).filter(w=>w.info.roots.some(r=>norm(r)===norm(a.project_dir))&&(!a.session_id||w.info.sessions.some(s=>s.session_id===a.session_id)));
  if(list.length!==1)throw Error('Expected one VS Code window on this project. Reload the project window if the bridge is not loaded. Found '+list.length);
  const request_id=a.request_id||crypto.randomUUID();
  if(!/^[0-9a-f-]{36}$/i.test(request_id))throw Error('request_id must be a UUID');
  try{return await rpc(list[0].d,{...a,action:'send',request_id});}
  catch(error){throw Error(error.message+' Request ID: '+request_id+'. Do not blindly resend; read ds_reply_status for this ID first.');}
 }
 if(name==='ds_reply_status'||name==='ds_cancel_message'){
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
 {name:'ds_visible_sessions',description:'Inspect the actual visible middle Claude Code / DeepSeek chat sessions in VS Code. This is the live GUI conversation bridge, not a background worker.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'ds_send_message',description:'Send a collaboration message directly into the existing visible middle Claude Code / DeepSeek chat and trigger its reply in that same session. Use for advice, investigation, code changes, or follow-up; there is no fixed workflow. The user sees the real message and execution in the middle panel. Requires exact project_dir and optionally session_id. Returns message_id immediately; poll ds_reply_status for completion and return. Do not edit the same files concurrently. Existing UI permissions remain in force.',inputSchema:{type:'object',properties:{project_dir:{type:'string'},message:{type:'string'},session_id:{type:'string'},request_id:{type:'string',description:'Optional stable UUID for this logical delivery. Reuse only for identical content after checking uncertain delivery.'}},required:['project_dir','message'],additionalProperties:false},annotations:{readOnlyHint:false}},
 {name:'ds_reply_status',description:'Read the actual visible DS chat reply, tool operations, and completion status for a sent message. Continue the right-side Codex conversation using this reply. You may send a follow-up through ds_send_message when useful.',inputSchema:{type:'object',properties:{message_id:{type:'string'},wait_seconds:{type:'integer',minimum:0,maximum:20}},required:['message_id'],additionalProperties:false},annotations:{readOnlyHint:true}},
 {name:'ds_cancel_message',description:'Interrupt a message sent into the live DS conversation, keeping edits already made.',inputSchema:{type:'object',properties:{message_id:{type:'string'}},required:['message_id'],additionalProperties:false},annotations:{readOnlyHint:false}}
];
if(require.main===module){const input=readline.createInterface({input:process.stdin}),send=x=>process.stdout.write(JSON.stringify(x)+'\n');input.on('line',async line=>{let r;try{r=JSON.parse(line);}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}});return;}if(!r||typeof r!=='object'||Array.isArray(r)||r.jsonrpc!=='2.0'||typeof r.method!=='string'){send({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid request'}});return;}if(r.id===undefined)return;let result;try{if(r.method==='initialize')result={protocolVersion:r.params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'ds-visible-bridge',version:'0.2.0'},instructions:'This bridge controls the existing middle DS chat. Send a message with ds_send_message and poll ds_reply_status; do not launch a separate hidden model. Delegate flexibly according to the conversation.'};else if(r.method==='tools/list')result={tools:defs};else if(r.method==='ping')result={};else if(r.method==='tools/call'){try{result={content:[{type:'text',text:JSON.stringify(await call(r.params.name,r.params.arguments))}]};}catch(error){result={isError:true,content:[{type:'text',text:error.message}]};}}else{send({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'Unknown method'}});return;}send({jsonrpc:'2.0',id:r.id,result});}catch(error){send({jsonrpc:'2.0',id:r.id,error:{code:-32603,message:error.message}});}});}
module.exports={call};
