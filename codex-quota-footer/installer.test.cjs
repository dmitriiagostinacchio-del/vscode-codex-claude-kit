const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
function setup(kind){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vscode-kit-install-')),pkg=path.join(root,'package'),extension=path.join(root,'extension');fs.mkdirSync(pkg);fs.mkdirSync(extension);
 const source=kind==='bridge'?path.join(__dirname,'../ds-visible-bridge'):__dirname;
 fs.copyFileSync(path.join(source,'install.cjs'),path.join(pkg,'install.cjs'));
 fs.copyFileSync(path.join(source,kind==='bridge'?'host-addon.cjs':'quota-footer.js'),path.join(pkg,kind==='bridge'?'host-addon.cjs':'quota-footer.js'));
 let target,original;
 if(kind==='bridge'){target=path.join(extension,'extension.js');original='let zre;let c,e={subscriptions:[]};zre=c,e.subscriptions.push(c);';}
 else{
  const assets=path.join(extension,'webview/assets');fs.mkdirSync(assets,{recursive:true});
  for(const name of ['app-initial-13f932cb2f13.js','app-scope-2dce3358324c.js','app-server-client-signals-46e112ab39dd.js','await-rpc-request-70d86d45a758.js'])fs.writeFileSync(path.join(assets,name),'');
  target=path.join(assets,'composer-sidebar-shortcut-9fbf14e71a8d.js');original='children:[V==null?p:V.leadingControl,I===`multiline`&&m!=null?';
 }
 fs.writeFileSync(target,original);
 const run=(...args)=>spawnSync(process.execPath,[path.join(pkg,'install.cjs'),...args],{env:{...process.env,[kind==='bridge'?'CLAUDE_EXTENSION_DIR':'CODEX_EXTENSION_DIR']:extension},encoding:'utf8',windowsHide:true});
 return {root,pkg,extension,target,original,run};
}
for(const kind of ['bridge','quota'])test(kind+': install/idempotence/restore/reinstall/tamper protection',()=>{
 const f=setup(kind);
 assert.equal(f.run('--check').status,0);
 let r=f.run();assert.equal(r.status,0,r.stderr);const patched=fs.readFileSync(f.target,'utf8');assert.notEqual(patched,f.original);
 assert.equal(f.run().status,0);assert.equal(fs.readFileSync(f.target,'utf8'),patched);
 assert.equal(f.run('--restore').status,0);assert.equal(fs.readFileSync(f.target,'utf8'),f.original);
 assert.equal(f.run().status,0);
 fs.appendFileSync(f.target,'\n// unrelated later edit');
 assert.notEqual(f.run('--restore').status,0);assert.match(fs.readFileSync(f.target,'utf8'),/unrelated later edit/);
 assert.notEqual(f.run().status,0);
});
for(const kind of ['bridge','quota'])test(kind+': unsupported build stays untouched',()=>{
 const f=setup(kind);fs.writeFileSync(f.target,'unknown build');assert.notEqual(f.run().status,0);assert.equal(fs.readFileSync(f.target,'utf8'),'unknown build');
});
