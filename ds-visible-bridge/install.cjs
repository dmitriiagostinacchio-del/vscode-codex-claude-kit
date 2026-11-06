const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const file=path.join(process.env.CLAUDE_EXTENSION_DIR||path.join(require('node:os').homedir(),'.vscode/extensions/anthropic.claude-code-2.1.318'),'extension.js');
const backup=path.join(__dirname,'extension-2.1.318.original.js');
const mark='/* codex-ds-visible-bridge-v1 */';
if(process.argv.includes('--check')){const source=fs.readFileSync(file,'utf8');console.log(JSON.stringify({extension:'anthropic.claude-code-2.1.318',installed:source.includes(mark),ownedByThisCopy:source.includes(JSON.stringify(path.join(__dirname,'host-addon.cjs'))),addonFound:fs.existsSync(path.join(__dirname,'host-addon.cjs')),backupFound:fs.existsSync(backup)}));process.exit(0);}
if(process.argv.includes('--restore')){if(!fs.existsSync(backup))throw Error('Original backup is missing');const expected=fs.readFileSync(path.join(__dirname,'patched-sha256.txt'),'utf8').trim();if(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==expected)throw Error('The plugin changed after installation. Refusing to overwrite it.');const original=fs.readFileSync(path.join(__dirname,'original-sha256.txt'),'utf8').trim();if(crypto.createHash('sha256').update(fs.readFileSync(backup)).digest('hex')!==original)throw Error('Original backup checksum mismatch');fs.copyFileSync(backup,file);console.log('Original Claude Code extension restored. Reload VS Code.');process.exit(0);}
let source=fs.readFileSync(file,'utf8');if(source.includes(mark)){
 if(!source.includes(JSON.stringify(path.join(__dirname,'host-addon.cjs'))))throw Error('Another bridge installation owns this plugin. Restore it there before installing this copy.');
 const expected=fs.readFileSync(path.join(__dirname,'patched-sha256.txt'),'utf8').trim();
 if(crypto.createHash('sha256').update(source).digest('hex')!==expected)throw Error('Plugin changed after installation. Refusing to claim new ownership.');
 console.log('Visible bridge already installed; addon source updates apply after reload.');process.exit(0);}
const needle='zre=c,e.subscriptions.push(c)';if(source.split(needle).length!==2)throw Error('Unsupported extension build: refusing to patch.');
if(fs.existsSync(backup)){
 if(!fs.readFileSync(file).equals(fs.readFileSync(backup)))throw Error('Existing backup differs from plugin; inspect before installing again.');
}else fs.copyFileSync(file,backup);
fs.writeFileSync(path.join(__dirname,'original-sha256.txt'),crypto.createHash('sha256').update(source).digest('hex')+'\n');
const addon=path.join(__dirname,'host-addon.cjs');
source=source.replace(needle,'zre=c,'+mark+'(()=>{try{require('+JSON.stringify(addon)+').attach(e,c,Oe)}catch(err){t.error("Visible bridge could not start: "+String(err))}})(),e.subscriptions.push(c)');
fs.writeFileSync(path.join(__dirname,'patched-sha256.txt'),crypto.createHash('sha256').update(source).digest('hex')+'\n');
fs.writeFileSync(file,source);console.log('Experimental visible-session bridge installed. Reload the project window.');
