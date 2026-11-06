'use strict';
// Version-pinned adapter. No separate model process is launched.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto');
const STATE=path.join(__dirname,'state'),RUNS=path.join(__dirname,'messages');
for(const d of [STATE,RUNS])fs.mkdirSync(d,{recursive:true,mode:0o700});
exports.attach=function(context,manager,vscode){
 const token=crypto.randomBytes(24).toString('hex'),windowId=crypto.randomUUID();
 const pipe='\\\\.\\pipe\\codex-ds-visible-'+process.pid+'-'+crypto.randomBytes(5).toString('hex');
 const descriptor=path.join(STATE,'window-'+process.pid+'.json'),jobs=new Map(),installed=new Map(),routes=new Map(),waiters=new Map();
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
  for(const waiter of waiters.get(job.message_id)||[])if(job.status!=='running'||(job.events||[]).some(e=>e.seq>waiter.cursor))waiter.finish(false);
 }
 function report(job,cursor,timeout=false){
  const events=(job.events||[]).filter(e=>e.seq>cursor),checkpoint=events.at(-1)??null;
  return {message_id:job.message_id,workflow_id:job.workflow_id,revision:job.revision,session_id:job.session_id,project_dir:job.project_dir,status:job.status,
   report_type:timeout?'wait_timeout':job.status==='running'?'checkpoint':job.status,event_cursor:job.events?.at(-1)?.seq||0,
   events,reply:job.status==='running'?(checkpoint?.summary||''):job.reply.slice(-14000),reply_truncated:job.status!=='running'&&job.reply.length>14000,
   tool_count:job.tools.length,tools:job.status==='running'?[]:job.tools.slice(-30),error:job.error};
 }
 function checkpoint(job,kind,summary,key){
  key=crypto.createHash('sha256').update(key).digest('hex');
  if(job.status!=='running'||job.events.some(e=>e.key===key)||job.events.length>=50)return;
  job.events.push({seq:job.events.length+1,kind,summary:String(summary).slice(0,4000),key,at:new Date().toISOString()});save(job);
 }
 function end(job,status,error){if(job.status!=='running')return;job.status=status;job.ended_at=new Date().toISOString();if(error)job.error=error;save(job);}
 function surfaces(){
  const list=[],seen=new Set();
  for(const s of manager.webviews||[])if(s.isChatSurface&&manager.allComms.has(s.comms)&&!seen.has(s.comms)){
   seen.add(s.comms);list.push({comms:s.comms,title:'Claude Code',surface:s.comms===manager.sidebarComms?'sidebar':'editor',visible:Boolean(s.isVisible())});
  }
  for(const [panel,comms]of manager.panelComms||[])if(manager.allComms.has(comms)&&!seen.has(comms)){seen.add(comms);list.push({comms,title:panel.title,surface:'editor',visible:Boolean(panel.visible)});}
  return list;
 }
 function channels(){return surfaces().flatMap(s=>[...s.comms.channels.entries()]
  .map(([id,ch])=>({...s,ch,channel_id:id,session_id:ch.sessionId,project_dir:ch.cwd,busy:ch.atRest!==true,
   last_focused:s.comms===manager.lastFocusedChatSurface?.comms,
   preferred:routes.get(norm(ch.cwd||''))?.comms===s.comms&&routes.get(norm(ch.cwd||''))?.channel_id===id})));}
 function observe(comms,event){
  for(const job of jobs.values())if(job.status==='running'&&job.comms===comms&&event.channelId===job.channel_id){
   const m=event.message;
   if(event.type==='request'&&event.request?.type==='tool_permission_request')checkpoint(job,'approval_required','Claude Code 正在等待工具权限审批：'+String(event.request.toolName||'未知工具'),'permission:'+event.requestId);
   if(event.type==='request'&&event.request?.type==='user_dialog_request')checkpoint(job,'decision','Claude Code 正在等待用户对话输入：'+String(event.request.dialogKind||'对话'),'dialog:'+event.requestId);
   if(event.type==='io_message'&&m){
    if(m.type==='assistant')for(const b of m.message?.content||[]){
     if(b.type==='text'){
      const text=String(b.text||'');job.reply=(job.reply+'\n'+text).trim().slice(-1000000);
      const prefix='[DS_EVENT:'+job.message_id+':';
      for(const line of text.split(/\r?\n/))if(line.startsWith(prefix)){
       const rest=line.slice(prefix.length),cut=rest.indexOf(']'),kind=rest.slice(0,cut),summary=rest.slice(cut+1).trim();
       if(cut>0&&['blocked','decision','failure','milestone'].includes(kind)&&summary)checkpoint(job,kind,summary,line);
      }
     }
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
 async function dispatch(req,signal){
  wire();
  if(req.action==='info')return {version:'0.3.0',window_id:windowId,window_focused:vscode.window?.state?.focused===true,mode:'existing-open-Claude-Code-session',roots:roots(),open_surfaces:surfaces().length,visible_surfaces:surfaces().filter(s=>s.visible).length,sessions:channels().map(({comms,ch,...info})=>info)};
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
   if(!req.session_id&&candidates.length>1){
    const preferred=candidates.filter(s=>s.preferred),focused=candidates.filter(s=>s.last_focused),active=candidates.filter(s=>s.session_id===manager.activeSessionId);
    if(preferred.length===1)candidates=preferred;else if(focused.length===1)candidates=focused;else if(active.length===1)candidates=active;
   }
   if(candidates.length!==1)throw Error('Expected exactly one determinable open live session; found '+candidates.length+'. Codex should inspect ds_visible_sessions and supply the intended session_id from task context; do not guess. If no channel exists, the chat must first be started manually.');
   const target=candidates[0];
   if(target.busy||[...jobs.values()].some(j=>j.status==='running'&&j.comms===target.comms&&j.channel_id===target.channel_id))throw Error('The conversation is busy. Wait until it finishes.');
   let parent=null;
   if(req.revision_of){
    if(!/^[0-9a-f-]{36}$/i.test(req.revision_of))throw Error('Invalid revision_of');
    parent=jobs.get(req.revision_of);
    if(!parent)try{parent=JSON.parse(fs.readFileSync(path.join(RUNS,req.revision_of+'.json'),'utf8'));}catch{}
    if(!parent||norm(parent.project_dir)!==norm(req.project_dir)||parent.session_id!==target.session_id)throw Error('Revision must refer to the same project and DS session.');
    if(parent.status==='running')throw Error('Previous revision is still running. Wait for its completion.');
    if((parent.revision||0)>=3)throw Error('Three automatic revision rounds reached. Report unresolved issues instead of looping indefinitely.');
   }
   const job={message_id:req.request_id,window_id:windowId,session_id:target.session_id,channel_id:target.channel_id,project_dir:req.project_dir,status:'running',message:req.message,reply:'',tools:[],events:[],created_at:new Date().toISOString(),comms:target.comms};
   job.workflow_id=parent?.workflow_id||parent?.message_id||job.message_id;job.revision=parent?(parent.revision||0)+1:0;
   jobs.set(job.message_id,job);save(job);
   const protocol='\n\n【协作汇报约定】独立处理任务，普通进度无需逐条汇报。遇到阻塞、需要决策、重要失败或约定里程碑时，用单独一行输出 [DS_EVENT:'+job.message_id+':类型] 简短结论；类型仅用 blocked、decision、failure、milestone。不要把每次读写工具当作里程碑。需要决策或阻塞时停止继续修改并说明问题。完成后汇总改动、验证结果和未解决项，不再转派。';
   const message={type:'user',session_id:target.session_id||'',uuid:crypto.randomUUID(),parent_tool_use_id:null,message:{role:'user',content:[{type:'text',text:'【来自 Codex 的协作消息】\n'+req.message+protocol}]}};
   try{
    target.comms.send({type:'io_message',channelId:target.channel_id,message,done:false});
    const result=target.comms.transportMessage(target.channel_id,message,false,true);
    if(result?.then)result.catch(error=>end(job,'delivery_uncertain','Transport failed; inspect the original chat before retrying: '+error.message));
   }catch(error){end(job,'delivery_uncertain','Delivery could not be confirmed; inspect the original chat: '+error.message);}
   if(job.status==='running'||job.status==='completed')routes.set(norm(req.project_dir),{comms:target.comms,channel_id:target.channel_id});
   return publicJob(job);
  }
  if(req.action==='wait_event'){
   const job=jobs.get(req.message_id);if(!job)throw Error('Message not owned by this live window.');
   const seconds=req.wait_seconds??3600,cursor=req.after_event??0;
   if(!Number.isInteger(seconds)||seconds<0||seconds>7200||!Number.isInteger(cursor)||cursor<0)throw Error('Invalid event wait bounds');
   if(job.status!=='running'||job.events.some(e=>e.seq>cursor)||seconds===0)return report(job,cursor,seconds===0&&job.status==='running'&&!job.events.some(e=>e.seq>cursor));
   return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(Error('Event wait cancelled'));return;}
    const set=waiters.get(job.message_id)||new Set();waiters.set(job.message_id,set);
    let timer,settled=false;
    function cleanup(){clearTimeout(timer);set.delete(waiter);if(!set.size)waiters.delete(job.message_id);signal?.removeEventListener('abort',abort);}
    function abort(){if(settled)return;settled=true;cleanup();reject(Error('Event wait cancelled'));}
    const waiter={cursor,finish(timeout){if(settled)return;settled=true;cleanup();resolve(report(job,cursor,timeout));}};
    set.add(waiter);signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>waiter.finish(true),seconds*1000);
   });
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
   const controller=new AbortController();socket.once('close',()=>controller.abort());
   if(req.action==='wait_event')socket.setTimeout?.(0);
   Promise.resolve(dispatch(req,controller.signal)).then(result=>{if(!socket.destroyed)socket.end(JSON.stringify({result})+'\n');},error=>{if(!socket.destroyed)socket.end(JSON.stringify({error:error.message})+'\n');});
  });socket.on('error',()=>{});
 });
 server.on?.('error',error=>console.warn('[DS bridge] Local pipe unavailable: '+error.message));
 server.listen(pipe,()=>{try{fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid,window_id:windowId,pipe,token,roots:roots(),version:'0.3.0'},null,2),{mode:0o600});}catch(error){console.warn('[DS bridge] Discovery unavailable: '+error.message);server.close();}});
 const timer=setInterval(()=>{try{wire();}catch(error){console.warn('[DS bridge] Refresh failed: '+error.message);}},250);wire();
 context.subscriptions.push({dispose(){
  disposed=true;clearInterval(timer);if(retryTimer!==null)clearTimeout(retryTimer);retryTimer=null;server.close();
  for(const [comms,old]of installed){comms.send=old.originalSend;comms.fromClient=old.originalFromClient;}
  for(const job of jobs.values())end(job,'interrupted','VS Code window reloaded.');flushSaves();
  try{fs.unlinkSync(descriptor);}catch{}
 }});
};
