'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const args=new Set(process.argv.slice(2)),restore=args.has('--restore'),check=args.has('--check');
if(args.has('--bridge-only')&&args.has('--quota-only'))throw Error('Choose one component or omit both flags.');
if(process.platform!=='win32')throw Error('This release supports native Windows only.');
if(Number(process.versions.node.split('.')[0])<22)throw Error('Install Node.js 22 or newer first.');
const folders=args.has('--bridge-only')?['ds-visible-bridge']:args.has('--quota-only')?['codex-quota-footer']:['ds-visible-bridge','codex-quota-footer'];
function run(exe,argv){return spawnSync(exe,argv,{encoding:'utf8',windowsHide:true});}
function installPart(folder){
 const script=path.join(__dirname,folder,'install.cjs');
 if(restore){
  const status=run(process.execPath,[script,'--check']);
  if(status.status===0){
   const current=JSON.parse(status.stdout);
   if(!current.installed){console.log(folder+': not installed; skipped.');return;}
   if(!current.ownedByThisCopy)throw Error(folder+': another installation owns this patch. Restore it from its original directory.');
  }
 }
 const r=run(process.execPath,[script,...check?['--check']:restore?['--restore']:[]]);
 if(r.stdout)process.stdout.write(r.stdout);
 if(r.status!==0)throw Error(folder+' failed. Earlier components may already have changed; no unrelated settings were overwritten.\n'+(r.stderr||r.error?.message||''));
}
for(const folder of folders)installPart(folder);
if(folders.includes('ds-visible-bridge')&&!check&&!args.has('--no-mcp')){
 const extension=process.env.CODEX_EXTENSION_DIR||path.join(os.homedir(),'.vscode/extensions/openai.chatgpt-26.1021.22027');
 const codex=path.join(extension,'bin/windows-x86_64/codex.exe'),entry=path.join(__dirname,'ds-visible-bridge/mcp.cjs');
 if(!fs.existsSync(codex)){
  console.log('Codex CLI not found; MCP registration skipped. Use: codex mcp add ds_worker -- node "'+entry+'"');
 }else{
  const current=run(codex,['mcp','get','ds_worker','--json']);
  if(current.status!==0&&!/No MCP server named ['"]ds_worker['"] found/.test(current.stderr||''))throw Error('Cannot verify existing MCP entry; no registration changed.');
  let config=null;if(current.status===0)try{config=JSON.parse(current.stdout)}catch{throw Error('Existing MCP configuration could not be parsed; no registration changed.');}
  const transport=config?.transport??config;
  const owned=Array.isArray(transport?.args)&&transport.args.some(a=>typeof a==='string'&&path.resolve(a).toLowerCase()===entry.toLowerCase());
  if(config&&!owned)console.log('An existing ds_worker entry belongs to another installation; preserved. Restore/remove it there before registering this copy.');
  else if(restore&&owned){const r=run(codex,['mcp','remove','ds_worker']);if(r.status!==0)throw Error('MCP removal failed');console.log('Removed this package\'s MCP entry.');}
  else if(!restore&&!config){const r=run(codex,['mcp','add','ds_worker','--',process.execPath,entry]);if(r.status!==0)throw Error('MCP registration failed; configure it manually.');console.log('Registered ds_worker MCP.');}
 }
}
if(!check)console.log('Reload VS Code after finishing. Keep this folder in its final location.');
