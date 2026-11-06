const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto'),net=require('node:net');
const uuid=()=>crypto.randomUUID(),tick=()=>new Promise(r=>setImmediate(r));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function harness({lock=false,sidebar=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ds-bridge-audit-')),project=path.join(root,'project');fs.mkdirSync(project);
 let blocked=lock,dispatches=0,fail=false;const originalSend=()=>{};
 const comms={channels:new Map([['ch',{sessionId:'session',cwd:project,atRest:true}]]),send:originalSend,fromClient(){},transportMessage(){dispatches++;if(fail)throw Error('Injected transport failure');},async interruptClaude(){}};
 const panel={visible:true,title:'Test'},manager={allComms:new Set([comms]),panelComms:new Map(sidebar?[]:[[panel,comms]])};
 if(sidebar){manager.sidebarComms=comms;manager.sidebarChatShows=()=> 'session';manager.webviews=new Set([{comms,isChatSurface:true,isVisible:()=>true}]);}
 const context={subscriptions:[]},mod={exports:{}};
 const localFs={...fs,renameSync(a,b){if(blocked)throw Object.assign(Error('Injected EPERM'),{code:'EPERM'});fs.renameSync(a,b);}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/host-addon.cjs','utf8'),{require:n=>n==='node:fs'?localFs:require(n),exports:mod.exports,module:mod,__dirname:root,process,console:{warn(){}},AbortController,setTimeout,clearTimeout,setInterval,clearInterval});
 mod.exports.attach(context,manager,{workspace:{workspaceFolders:[{uri:{fsPath:project}}]}});
 const mcp={exports:{}};vm.runInNewContext(fs.readFileSync(__dirname+'/mcp.cjs','utf8'),{require,module:mcp,exports:mcp.exports,__dirname:root,process,console,setTimeout,clearTimeout});
 const desc=async()=>{for(let i=0;i<50;i++){const p=path.join(root,'state','window-'+process.pid+'.json');if(fs.existsSync(p))return JSON.parse(fs.readFileSync(p));await new Promise(r=>setTimeout(r,10));}throw Error('No descriptor');};
 async function rpc(req,badToken=false){const d=await desc();return new Promise((resolve,reject)=>{const s=net.createConnection(d.pipe);let data='';s.setEncoding('utf8');s.on('connect',()=>s.write(JSON.stringify({...req,token:badToken?'wrong':d.token})+'\n'));s.on('data',b=>{data+=b;if(data.includes('\n')){s.destroy();resolve(JSON.parse(data.split('\n')[0]));}});s.on('error',reject);});}
 const send=(extra={})=>rpc({action:'send',message:'audit',project_dir:project,request_id:uuid(),...extra});
 const emit=(m)=>comms.send({type:'io_message',channelId:'ch',message:m});
 return {root,project,comms,manager,panel,rpc,send,emit,call:mcp.exports.call,dispatches:()=>dispatches,unblock:()=>blocked=false,fail:()=>fail=true,
  close(){for(const d of context.subscriptions)d.dispose();assert.equal(comms.send,originalSend);}};
}
test('visible delivery, busy guard, capture tools/result and stable request ID',async()=>{
 const h=harness();try{
  const info=await h.rpc({action:'info'});assert.equal(info.result.sessions.length,1);
  const id=uuid(),sent=await h.send({request_id:id});assert.equal(sent.result.status,'running');
  assert.match((await h.send()).error,/busy/);
  assert.equal((await h.send({request_id:id})).result.message_id,id);assert.equal(h.dispatches(),1);
  assert.match((await h.send({request_id:id,message:'different'})).error,/different/);
  h.emit({type:'assistant',message:{content:[{type:'text',text:'partial'},{type:'tool_use',name:'Read',input:{file_path:'sample.js'}}]}});
  h.emit({type:'result',is_error:false,subtype:'success',result:'AUDIT_OK'});
  const r=(await h.rpc({action:'status',message_id:id})).result;assert.equal(r.status,'completed');assert.equal(r.reply,'AUDIT_OK');assert.equal(r.tools[0].name,'Read');
 }finally{h.close();}
});
test('sidebar detection, closed surfaces excluded and ambiguous sessions refused',async()=>{
 const h=harness({sidebar:true});try{
  assert.equal((await h.rpc({action:'info'})).result.sessions[0].surface,'sidebar');
  h.manager.webviews.clear();assert.equal((await h.rpc({action:'info'})).result.sessions.length,0);
  assert.match((await h.send()).error,/found 0/);
  h.manager.panelComms.set(h.panel,h.comms);h.comms.channels.set('ch2',{sessionId:'other',cwd:h.project,atRest:true});
  assert.match((await h.send()).error,/found 2/);assert.equal((await h.send({session_id:'other'})).result.session_id,'other');
 }finally{h.close();}
});
test('background editor receives messages, replies and follow-up without being revealed',async()=>{
 const h=harness();try{
  h.panel.visible=false;
  const info=(await h.rpc({action:'info'})).result;
  assert.equal(info.visible_surfaces,0);assert.equal(info.open_surfaces,1);assert.equal(info.sessions[0].visible,false);
  const first=await h.call('ds_send_message',{project_dir:h.project,session_id:'session',message:'background first'});
  h.emit({type:'result',result:'background reply'});
  assert.equal((await h.call('ds_reply_status',{message_id:first.message_id})).reply,'background reply');
  const next=await h.call('ds_send_message',{project_dir:h.project,session_id:'session',message:'background follow-up'});
  assert.equal(next.status,'running');assert.equal(h.dispatches(),2);assert.equal(h.panel.visible,false);
 }finally{h.close();}
});
test('background sidebar supports exact session routing and refuses closed channels',async()=>{
 const h=harness({sidebar:true});try{
  h.manager.webviews=new Set([{comms:h.comms,isChatSurface:true,isVisible:()=>false}]);
  h.comms.channels.set('other-channel',{sessionId:'other-session',cwd:h.project,atRest:true});
  h.manager.sidebarChatShows=()=> 'other-session';
  const info=(await h.rpc({action:'info'})).result;assert.equal(info.sessions.length,2);assert.equal(info.visible_surfaces,0);
  assert.match((await h.send()).error,/found 2/);
  const sent=await h.send({session_id:'session'});assert.equal(sent.result.session_id,'session');
  h.comms.channels.delete('ch');assert.match((await h.send({session_id:'session'})).error,/found 0/);
  h.manager.allComms.delete(h.comms);assert.equal((await h.rpc({action:'info'})).result.sessions.length,0);
 }finally{h.close();}
});
test('automatic routing selects last-focused session then pins successful target in background',async()=>{
 const h=harness();try{
  const other={...h.comms,channels:new Map([['other',{sessionId:'other-session',cwd:h.project,atRest:true}]])};
  const otherPanel={visible:false,title:'Other'};h.manager.allComms.add(other);h.manager.panelComms.set(otherPanel,other);
  h.panel.visible=false;h.manager.lastFocusedChatSurface={comms:h.comms};
  await h.rpc({action:'info'});
  const first=await h.call('ds_send_message',{project_dir:h.project,message:'auto choose'});assert.equal(first.session_id,'session');
  h.emit({type:'result',result:'done'});
  h.manager.lastFocusedChatSurface={comms:other};
  const follow=await h.call('ds_send_message',{project_dir:h.project,message:'stay on original target'});assert.equal(follow.session_id,'session');
  h.comms.channels.get('ch').atRest=false;
  await assert.rejects(h.call('ds_send_message',{project_dir:h.project,message:'do not silently switch busy target'}),/busy/);
 }finally{h.close();}
});
test('manual intervention stops attribution; malformed observer data cannot break native send',async()=>{
 const h=harness();try{
  const id=(await h.send()).result.message_id;
  h.comms.fromClient({type:'io_message',channelId:'ch',message:{type:'user'}});
  h.emit({type:'result',result:'unrelated'});
  assert.equal((await h.rpc({action:'status',message_id:id})).result.status,'user_intervened');
  const second=(await h.send()).result.message_id;
  assert.doesNotThrow(()=>h.emit({type:'assistant',message:{content:{bad:true}}}));
  h.emit({type:'result',is_error:true,subtype:'error'});
  assert.equal((await h.rpc({action:'status',message_id:second})).result.status,'failed');
 }finally{h.close();}
});
test('file locks preserve live result and retry persistence',async()=>{
 const h=harness({lock:true});try{
  const id=(await h.send()).result.message_id;
  h.emit({type:'result',result:'saved later'});
  assert.equal((await h.rpc({action:'status',message_id:id})).result.reply,'saved later');
  h.unblock();await new Promise(r=>setTimeout(r,350));
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.root,'messages',id+'.json'))).status,'completed');
 }finally{h.close();}
});
test('transport failure, missing channel, authentication and project boundaries',async()=>{
 const h=harness();try{
  assert.match((await h.rpc({action:'info'},true)).error,/Unauthorized/);
  assert.match((await h.send({project_dir:path.join(h.root,'wrong')})).error,/not open/);
  h.fail();const first=await h.send();assert.equal(first.result.status,'delivery_uncertain');
  h.comms.transportMessage=()=>{};const second=(await h.send()).result.message_id;h.comms.channels.clear();
  assert.equal((await h.rpc({action:'status',message_id:second})).result.status,'interrupted');
 }finally{h.close();}
});
test('completion racing with cancellation is not overwritten',async()=>{
 const h=harness();try{
  const id=(await h.send()).result.message_id;
  h.comms.interruptClaude=async()=>h.emit({type:'result',result:'completed before interrupt'});
  assert.equal((await h.rpc({action:'cancel',message_id:id})).result.status,'completed');
 }finally{h.close();}
});
test('MCP reads live status during file lock and reports disconnected windows honestly',async()=>{
 const h=harness({lock:true});let closed=false;try{
  await tick();const sent=await h.call('ds_send_message',{project_dir:h.project,message:'from MCP'});
  h.emit({type:'result',result:'live without disk'});
  assert.equal((await h.call('ds_reply_status',{message_id:sent.message_id})).reply,'live without disk');
  h.unblock();await new Promise(r=>setTimeout(r,300));
  const pending=await h.call('ds_send_message',{project_dir:h.project,message:'pending'});
  h.close();closed=true;
  // Simulate an abrupt host exit leaving an old running snapshot.
  const file=path.join(h.root,'messages',pending.message_id+'.json');
  fs.writeFileSync(file,JSON.stringify({...pending,status:'running'}));
  assert.equal((await h.call('ds_reply_status',{message_id:pending.message_id})).status,'disconnected');
  await assert.rejects(h.call('ds_cancel_message',{message_id:pending.message_id}),/not connected/);
 }finally{if(!closed)h.close();}
});
test('event wait ignores ordinary log updates, then returns a checkpoint once and completion',async()=>{
 const h=harness();try{
  const id=(await h.send()).result.message_id;let settled=false;
  const waiting=h.call('ds_wait_report',{message_id:id,wait_seconds:5}).then(r=>{settled=true;return r;});
  await pause(60);
  for(let i=0;i<10;i++)h.emit({type:'assistant',message:{content:[{type:'text',text:'ordinary progress '+i}]}});
  h.emit({type:'assistant',message:{content:[{type:'text',text:'[DS_EVENT:wrong-id:blocked] should not wake'}]}});
  await pause(40);assert.equal(settled,false);
  h.emit({type:'assistant',message:{content:[{type:'text',text:'[DS_EVENT:'+id+':decision] Need a decision'}]}});
  const checkpoint=await waiting;assert.equal(checkpoint.report_type,'checkpoint');assert.equal(checkpoint.event_cursor,1);assert.equal(checkpoint.reply,'Need a decision');assert.equal(checkpoint.tools.length,0);
  let secondSettled=false;const second=h.call('ds_wait_report',{message_id:id,after_event:1,wait_seconds:5}).then(r=>{secondSettled=true;return r});await pause(60);
  h.emit({type:'assistant',message:{content:[{type:'text',text:'[DS_EVENT:'+id+':decision] Need a decision'}]}});await pause(40);assert.equal(secondSettled,false);
  h.emit({type:'result',result:'final result'});const done=await second;assert.equal(done.report_type,'completed');assert.equal(done.reply,'final result');assert.equal(done.events.length,0);
 }finally{h.close();}
});
test('cancelling a report wait leaves the DS task running and a later wait can finish',async()=>{
 const h=harness();try{
  const id=(await h.send()).result.message_id,controller=new AbortController();
  const waiting=h.call('ds_wait_report',{message_id:id,wait_seconds:5},{signal:controller.signal});
  const rejected=assert.rejects(waiting,/cancelled/);await pause(80);controller.abort();await rejected;
  assert.equal((await h.rpc({action:'status',message_id:id})).result.status,'running');
  const waitingAgain=h.call('ds_wait_report',{message_id:id,wait_seconds:5});await pause(60);h.emit({type:'result',result:'still completed'});assert.equal((await waitingAgain).report_type,'completed');
 }finally{h.close();}
});
test('event wait timeout is honest and disconnection/intervention resolve promptly',async()=>{
 const h=harness();let closed=false;try{
  const id=(await h.send()).result.message_id;
  assert.equal((await h.call('ds_wait_report',{message_id:id,wait_seconds:0})).report_type,'wait_timeout');
  await assert.rejects(h.call('ds_wait_report',{message_id:id,wait_seconds:7201}),/0–7200/);
  const waiting=h.call('ds_wait_report',{message_id:id,wait_seconds:5});await pause(60);
  h.comms.fromClient({type:'io_message',channelId:'ch',message:{type:'user'}});assert.equal((await waiting).report_type,'user_intervened');
  const next=(await h.send()).result.message_id;const disconnected=h.call('ds_wait_report',{message_id:next,wait_seconds:5});await pause(60);h.close();closed=true;
  assert.equal((await disconnected).report_type,'interrupted');
 }finally{if(!closed)h.close();}
});
test('revision chain preserves workflow and stops after three automatic correction rounds',async()=>{
 const h=harness();try{
  let previous=(await h.send()).result;const workflow=previous.workflow_id;
  for(let i=1;i<=3;i++){h.emit({type:'result',result:'needs review'});previous=(await h.send({revision_of:previous.message_id})).result;assert.equal(previous.revision,i);assert.equal(previous.workflow_id,workflow);}
  h.emit({type:'result',result:'still not done'});assert.match((await h.send({revision_of:previous.message_id})).error,/Three automatic revision/);
 }finally{h.close();}
});
test('MCP cancellation notification aborts only the event wait',async()=>{
 const h=harness();let child;try{
  const id=(await h.send()).result.message_id;
  const script=path.join(h.root,'mcp.cjs');fs.copyFileSync(__dirname+'/mcp.cjs',script);
  child=require('node:child_process').spawn(process.execPath,[script],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const responses=await new Promise((resolve,reject)=>{
   let buffer='',items=[];const timer=setTimeout(()=>{child.kill();reject(Error('Cancellation response timed out'));},3000);
   child.on('error',reject);child.stdout.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){items.push(JSON.parse(buffer.slice(0,n)));buffer=buffer.slice(n+1);}if(items.some(r=>r.id===1)&&items.some(r=>r.id===2)){clearTimeout(timer);resolve(items);}});
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'ds_wait_report',arguments:{message_id:id,wait_seconds:30}}})+'\n');
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:1}})+'\n');
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'ping'})+'\n');
  });
  assert.equal(responses.find(r=>r.id===1).result.isError,true);assert.match(responses.find(r=>r.id===1).result.content[0].text,/cancelled/);
  assert.equal((await h.rpc({action:'status',message_id:id})).result.status,'running');
 }finally{child?.stdin.end();child?.kill();h.close();}
});
test('native permission requests return a checkpoint without exposing inputs or approving tools',async()=>{
 const h=harness();try{
  const id=(await h.send()).result.message_id;
  const waiting=h.call('ds_wait_report',{message_id:id,wait_seconds:5});await pause(60);
  h.comms.send({type:'request',channelId:'ch',requestId:'approval-1',request:{type:'tool_permission_request',toolName:'Bash',inputs:{secret:'do-not-return'}}});
  const r=await waiting;assert.equal(r.report_type,'checkpoint');assert.equal(r.events[0].kind,'approval_required');assert.match(r.reply,/Bash/);assert.doesNotMatch(JSON.stringify(r),/do-not-return/);
  assert.equal((await h.rpc({action:'status',message_id:id})).result.status,'running');
 }finally{h.close();}
});
