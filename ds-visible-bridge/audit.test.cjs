const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),crypto=require('node:crypto'),net=require('node:net');
const uuid=()=>crypto.randomUUID(),tick=()=>new Promise(r=>setImmediate(r));
function harness({lock=false,sidebar=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ds-bridge-audit-')),project=path.join(root,'project');fs.mkdirSync(project);
 let blocked=lock,dispatches=0,fail=false;const originalSend=()=>{};
 const comms={channels:new Map([['ch',{sessionId:'session',cwd:project,atRest:true}]]),send:originalSend,fromClient(){},transportMessage(){dispatches++;if(fail)throw Error('Injected transport failure');},async interruptClaude(){}};
 const panel={visible:true,title:'Test'},manager={allComms:new Set([comms]),panelComms:new Map(sidebar?[]:[[panel,comms]])};
 if(sidebar){manager.sidebarComms=comms;manager.sidebarChatShows=()=> 'session';manager.webviews=new Set([{comms,isChatSurface:true,isVisible:()=>true}]);}
 const context={subscriptions:[]},mod={exports:{}};
 const localFs={...fs,renameSync(a,b){if(blocked)throw Object.assign(Error('Injected EPERM'),{code:'EPERM'});fs.renameSync(a,b);}};
 vm.runInNewContext(fs.readFileSync(__dirname+'/host-addon.cjs','utf8'),{require:n=>n==='node:fs'?localFs:require(n),exports:mod.exports,module:mod,__dirname:root,process,console:{warn(){}},setTimeout,clearTimeout,setInterval,clearInterval});
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
