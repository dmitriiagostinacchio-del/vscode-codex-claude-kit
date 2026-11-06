'use strict';
// Version-pinned adapter. No separate model process is launched.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const STATE=path.join(__dirname,'state'),RUNS=path.join(__dirname,'messages');
for(const d of [STATE,RUNS])fs.mkdirSync(d,{recursive:true,mode:0o700});
exports.attach=function(context,manager,vscode){
 const token=crypto.randomBytes(24).toString('hex'),windowId=crypto.randomUUID();
 const pipe='\\\\.\\pipe\\codex-ds-visible-'+process.pid+'-'+crypto.randomBytes(5).toString('hex');
 const descriptor=path.join(STATE,'window-'+process.pid+'.json'),jobs=new Map(),installed=new Map();
 const roots=()=>vscode.workspace.workspaceFolders?.map(f=>f.uri.fsPath)||[];
 const norm=p=>path.resolve(p).toLowerCase();
 const pendingSaves=new Map();let retryTimer=null,disposed=false;
 function flushSaves(){
  retryTimer=null;
  for(const [file,pending]of pendingSaves){
   const tmp=file+'.'+process.pid+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
   try{fs.writeFileSync(tmp,pending.record,{mode:0o600});fs.renameSync(tmp,file);pendingSaves.delete(file);}
   catch(error){try{fs.unlinkSync(tmp);}catch{}pending.failures++;if(pending.failures===1||pending.failures%60===0)console.warn('[DS bridge] Status save deferred: '+error.message);}
  }
  if(pendingSaves.size&&!disposed){retryTimer=setTimeout(flushSaves,250);retryTimer.unref?.();}
 }
 function publicJob(job){const {comms,...record}=job;return record;}
 function save(job){
  job.updated_at=new Date().toISOString();
  const file=path.join(RUNS,job.message_id+'.json');
  pendingSaves.set(file,{record:JSON.stringify(publicJob(job),null,2),failures:pendingSaves.get(file)?.failures||0});
  if(retryTimer===null)flushSaves();
 }
 function end(job,status,error){if(job.status!=='running')return;job.status=status;job.ended_at=new Date().toISOString();if(error)job.error=error;save(job);}
 function surfaces(){
  const list=[],seen=new Set();
  for(const s of manager.webviews||[])if(s.isChatSurface&&s.isVisible()&&!seen.has(s.comms)){
   seen.add(s.comms);list.push({comms:s.comms,title:'Claude Code',surface:s.comms===manager.sidebarComms?'sidebar':'editor'});
  }
  for(const [panel,comms]of manager.panelComms||[])if(panel.visible&&!seen.has(comms)){seen.add(comms);list.push({comms,title:panel.title,surface:'editor'});}
  return list;
 }
 function channels(){return surfaces().flatMap(s=>[...s.comms.channels.entries()]
  .filter(([,ch])=>s.surface!=='sidebar'||!manager.sidebarChatShows?.()||ch.sessionId===manager.sidebarChatShows())
  .map(([id,ch])=>({...s,ch,channel_id:id,session_id:ch.sessionId,project_dir:ch.cwd,busy:ch.atRest!==true})));}
 function observe(comms,event){
  for(const job of jobs.values())if(job.status==='running'&&job.comms===comms&&event.channelId===job.channel_id){
   const m=event.message;
   if(event.type==='io_message'&&m){
    if(m.type==='assistant')for(const b of m.message?.content||[]){
     if(b.type==='text')job.reply=(job.reply+'\n'+String(b.text||'')).trim().slice(-1000000);
     if(b.type==='tool_use'&&job.tools.length<2000)job.tools.push({name:b.name,file_path:b.input?.file_path});
    }
    if(m.type==='result'){
     if(typeof m.result==='string')job.reply=m.result.slice(-1000000);
     job.result_subtype=m.subtype;end(job,m.is_error||m.subtype?.startsWith('error')?'failed':'completed');
    }else save(job);
   }
   if(event.type==='close_channel')end(job,'interrupted',event.error||'The visible conversation channel closed.');
  }
 }
 function wire(){
  for(const [comms,old]of installed)if(!manager.allComms.has(comms)){
   comms.send=old.originalSend;comms.fromClient=old.originalFromClient;installed.delete(comms);
  }
  for(const job of jobs.values())if(job.status==='running'&&(!manager.allComms.has(job.comms)||!job.comms.channels.has(job.channel_id)))end(job,'interrupted','The original conversation is no longer connected.');
  for(const comms of manager.allComms){if(installed.has(comms))continue;
   const originalSend=comms.send,originalFromClient=comms.fromClient;
   comms.fromClient=function(event){
    try{if(event.type==='io_message'&&event.message?.type==='user')for(const job of jobs.values())if(job.status==='running'&&job.comms===comms&&job.channel_id===event.channelId)end(job,'user_intervened','A person added a new message. Later replies are not attributed to the earlier bridge request.');}
    catch(error){console.warn('[DS bridge] Observer error: '+error.message);}
    return originalFromClient.call(this,event);
   };
   comms.send=function(event){try{observe(comms,event);}catch(error){console.warn('[DS bridge] Observer error: '+error.message);}return originalSend.call(this,event);};
   installed.set(comms,{originalSend,originalFromClient});
  }
  if(jobs.size>100)for(const [id,job]of jobs){if(jobs.size<=100)break;if(job.status!=='running')jobs.delete(id);}
 }
 async function dispatch(req){
  wire();
  if(req.action==='info')return {version:'0.2.0',window_id:windowId,mode:'existing-visible-Claude-Code-session',roots:roots(),visible_surfaces:surfaces().length,sessions:channels().map(({comms,ch,...info})=>info)};
  if(req.action==='send'){
   if(typeof req.message!=='string'||!req.message.trim()||req.message.length>40000)throw Error('message must contain 1–40000 characters.');
   if(!path.isAbsolute(req.project_dir||''))throw Error('project_dir must be absolute.');
   if(!roots().some(r=>norm(r)===norm(req.project_dir)))throw Error('This VS Code window is not open on the requested project.');
   if(!/^[0-9a-f-]{36}$/i.test(req.request_id||''))throw Error('request_id must be a UUID.');
   const existing=jobs.get(req.request_id);
   if(existing){if(existing.message!==req.message||norm(existing.project_dir)!==norm(req.project_dir)||(req.session_id&&existing.session_id!==req.session_id))throw Error('request_id already used for different content.');return publicJob(existing);}
   if(fs.existsSync(path.join(RUNS,req.request_id+'.json')))throw Error('request_id belongs to an earlier delivery. Read its status before sending again.');
   let candidates=channels().filter(s=>norm(s.project_dir||'')===norm(req.project_dir));
   if(req.session_id)candidates=candidates.filter(s=>s.session_id===req.session_id);
   if(candidates.length!==1)throw Error('Expected exactly one visible live session; found '+candidates.length+'. Select the intended chat; if needed send one manual message to start its channel.');
   const target=candidates[0];
   if(target.busy||[...jobs.values()].some(j=>j.status==='running'&&j.comms===target.comms&&j.channel_id===target.channel_id))throw Error('The visible conversation is busy. Wait until it finishes.');
   const job={message_id:req.request_id,window_id:windowId,session_id:target.session_id,channel_id:target.channel_id,project_dir:req.project_dir,status:'running',message:req.message,reply:'',tools:[],created_at:new Date().toISOString(),comms:target.comms};
   jobs.set(job.message_id,job);save(job);
   const message={type:'user',session_id:target.session_id||'',uuid:crypto.randomUUID(),parent_tool_use_id:null,message:{role:'user',content:[{type:'text',text:'【来自 Codex 的协作消息】\n'+req.message}]}};
   try{
    target.comms.send({type:'io_message',channelId:target.channel_id,message,done:false});
    const result=target.comms.transportMessage(target.channel_id,message,false,true);
    if(result?.then)result.catch(error=>end(job,'delivery_uncertain','Transport failed; inspect the original chat before retrying: '+error.message));
   }catch(error){end(job,'delivery_uncertain','Delivery could not be confirmed; inspect the original chat: '+error.message);}
   return publicJob(job);
  }
  if(req.action==='status'||req.action==='cancel'){
   const job=jobs.get(req.message_id);if(!job)throw Error('Message not owned by this live window.');
   if(req.action==='cancel'&&job.status==='running'){
    await job.comms.interruptClaude(job.channel_id);
    end(job,'cancel_requested','Interrupt requested. Check the visible chat; existing edits are retained.');
   }
   return publicJob(job);
  }
  throw Error('Unknown action');
 }
 const server=net.createServer(socket=>{
  socket.setEncoding('utf8');socket.setTimeout?.(10000,()=>socket.destroy());let buffer='',handled=false;
  socket.on('data',data=>{
   if(handled)return;buffer+=data;if(buffer.length>160000){handled=true;socket.destroy();return;}
   const p=buffer.indexOf('\n');if(p<0)return;handled=true;let req;
   try{req=JSON.parse(buffer.slice(0,p));if(!req||typeof req!=='object'||typeof req.token!=='string'||req.token!==token)throw Error('Unauthorized');}
   catch(error){socket.end(JSON.stringify({error:error.message})+'\n');return;}
   Promise.resolve(dispatch(req)).then(result=>socket.end(JSON.stringify({result})+'\n'),error=>socket.end(JSON.stringify({error:error.message})+'\n'));
  });socket.on('error',()=>{});
 });
 server.on?.('error',error=>console.warn('[DS bridge] Local pipe unavailable: '+error.message));
 server.listen(pipe,()=>{try{fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid,window_id:windowId,pipe,token,roots:roots(),version:'0.2.0'},null,2),{mode:0o600});}catch(error){console.warn('[DS bridge] Discovery unavailable: '+error.message);server.close();}});
 const timer=setInterval(()=>{try{wire();}catch(error){console.warn('[DS bridge] Refresh failed: '+error.message);}},250);wire();
 context.subscriptions.push({dispose(){
  disposed=true;clearInterval(timer);if(retryTimer!==null)clearTimeout(retryTimer);retryTimer=null;server.close();
  for(const [comms,old]of installed){comms.send=old.originalSend;comms.fromClient=old.originalFromClient;}
  for(const job of jobs.values())end(job,'interrupted','VS Code window reloaded.');flushSaves();
  try{fs.unlinkSync(descriptor);}catch{}
 }});
};
