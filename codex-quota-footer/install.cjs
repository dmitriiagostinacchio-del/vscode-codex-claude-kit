const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.join(process.env.CODEX_EXTENSION_DIR||path.join(require('node:os').homedir(),'.vscode/extensions/openai.chatgpt-26.1021.22027'),'webview/assets');
const target=path.join(root,'composer-sidebar-shortcut-9fbf14e71a8d.js');
const backup=path.join(__dirname,'composer-sidebar-shortcut.before-quota.js');
const marker="import {CodexQuotaFooter as LocalCodexQuotaFooter} from './local-codex-quota-footer.js';";
const before='children:[V==null?p:V.leadingControl,I===`multiline`&&m!=null?';
const after='children:[V==null?p:V.leadingControl,(0,X.jsx)(LocalCodexQuotaFooter,{}),I===`multiline`&&m!=null?';
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
let source=fs.readFileSync(target,'utf8');
const manifestFile=path.join(__dirname,'installed.json');
if(process.argv.includes('--check')){console.log(JSON.stringify({extension:'openai.chatgpt-26.1021.22027',installed:source.includes(marker),ownedByThisCopy:fs.existsSync(manifestFile)&&fs.existsSync(backup),componentFound:fs.existsSync(path.join(root,'local-codex-quota-footer.js')),backupFound:fs.existsSync(backup)}));process.exit(0);}
if(process.argv.includes('--restore')){
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  if(sha(source)!==manifest.patchedHash)throw Error('Plugin changed after installation. Restore stopped to preserve later edits.');
  if(manifest.originalHash&&sha(fs.readFileSync(backup))!==manifest.originalHash)throw Error('Backup checksum mismatch');
  fs.copyFileSync(backup,target);
  console.log('Restored pre-quota plugin. Reload VS Code to apply.');
}else{
  for(const dependency of ['app-initial-13f932cb2f13.js','app-scope-2dce3358324c.js','app-server-client-signals-46e112ab39dd.js','await-rpc-request-70d86d45a758.js'])if(!fs.existsSync(path.join(root,dependency)))throw Error('Unsupported extension: missing '+dependency);
  if(!source.includes(marker)){
    if(source.split(before).length!==2)throw Error('Unsupported composer layout. No plugin files changed.');
    if(fs.existsSync(backup)&&sha(fs.readFileSync(backup))!==sha(source))throw Error('Existing backup differs from plugin. Inspect before reinstalling.');
    if(!fs.existsSync(backup))fs.writeFileSync(backup,source);
    source=marker+'\n'+source.replace(before,after);
  }else{
    if(!fs.existsSync(manifestFile)||!fs.existsSync(backup))throw Error('Another installation owns this quota patch. Restore it there first.');
    if(sha(source)!==JSON.parse(fs.readFileSync(manifestFile,'utf8')).patchedHash)throw Error('Plugin changed after installation. Refusing to claim later edits.');
  }
  fs.copyFileSync(path.join(__dirname,'quota-footer.js'),path.join(root,'local-codex-quota-footer.js'));
  fs.writeFileSync(target,source);
  fs.writeFileSync(manifestFile,JSON.stringify({target,originalHash:sha(fs.readFileSync(backup)),patchedHash:sha(source),installedAt:new Date().toISOString()},null,2));
  console.log('Installed quota footer; refresh 60s; remaining percentages. Reload VS Code to apply.');
}
