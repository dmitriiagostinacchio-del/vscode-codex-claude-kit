'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
function configure(text){
 const match=/^\[mcp_servers\.ds_worker\][^\r\n]*\r?\n/m.exec(text);
 if(!match)throw Error('ds_worker MCP section not found; register it first.');
 const from=match.index+match[0].length,tail=text.slice(from),next=tail.search(/^\s*\[/m),to=next<0?text.length:from+next;
 let section=text.slice(from,to);
 const values=[...section.matchAll(/^\s*tool_timeout_sec\s*=.*$/gm)];
 if(values.length>1)throw Error('Duplicate tool_timeout_sec settings; inspect configuration.');
 if(values.length)section=section.replace(/^\s*tool_timeout_sec\s*=.*$/m,'tool_timeout_sec = 7500');
 else section='tool_timeout_sec = 7500\n'+section;
 return text.slice(0,from)+section+text.slice(to);
}
if(require.main===module){
 const file=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'config.toml');
 const before=fs.readFileSync(file,'utf8'),after=configure(before);
 if(before===after){console.log('DS report timeout already configured.');process.exit(0);}
 const backups=path.join(__dirname,'.local');fs.mkdirSync(backups,{recursive:true,mode:0o700});
 const backup=path.join(backups,'config-before-wait-'+Date.now()+'.toml');fs.writeFileSync(backup,before,{mode:0o600,flag:'wx'});
 const tmp=file+'.ds-wait-'+process.pid+'.tmp';let created=false;
 try{fs.writeFileSync(tmp,after,{mode:0o600,flag:'wx'});created=true;if(fs.readFileSync(file,'utf8')!==before)throw Error('Configuration changed during update; refusing to overwrite.');fs.renameSync(tmp,file);created=false;}
 finally{if(created)fs.unlinkSync(tmp);}
 console.log('Configured ds_worker tool timeout to 7500 seconds. Reload Codex/VS Code.');
}
module.exports={configure};
