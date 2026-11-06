const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/install.cjs','utf8');
function simulate(config,{getFails=false,restore=false}={}){
 const calls=[];
 const proc={argv:['node','install.cjs','--bridge-only',...restore?['--restore']:[]],platform:'win32',versions:process.versions,execPath:process.execPath,env:process.env,stdout:{write(){}}};
 const spawnSync=(exe,args)=>{
  calls.push({exe,args});
  if(exe===process.execPath)return {status:0,stdout:args.includes('--check')?JSON.stringify({installed:true,ownedByThisCopy:true}):'',stderr:''};
  if(args[1]==='get')return getFails?{status:1,stderr:'Permission denied'}:config?{status:0,stdout:JSON.stringify(config)}:{status:1,stderr:"Error: No MCP server named 'ds_worker' found."};
  return {status:0,stdout:'',stderr:''};
 };
 const run=()=>vm.runInNewContext(source,{process:proc,__dirname,console:{log(){}},require:n=>n==='node:fs'?{existsSync:()=>true}:n==='node:child_process'?{spawnSync}:require(n)});
 return {run,calls};
}
test('one-click installer preserves existing foreign MCP entry',()=>{
 const h=simulate({transport:{args:['other-installation/mcp.cjs']}});h.run();
 assert.equal(h.calls.some(c=>c.args[0]==='mcp'&&['add','remove'].includes(c.args[1])),false);
});
test('one-click installer does not overwrite MCP after a failed config read',()=>{
 const h=simulate(null,{getFails:true});assert.throws(h.run,/no registration changed/);
 assert.equal(h.calls.some(c=>c.args[1]==='add'),false);
});
test('uninstaller removes only its own MCP entry',()=>{
 const h=simulate({transport:{args:[path.join(__dirname,'ds-visible-bridge/mcp.cjs')]}},{restore:true});h.run();
 assert.equal(h.calls.filter(c=>c.args[0]==='mcp'&&c.args[1]==='remove').length,1);
 const other=simulate({transport:{args:['unrelated/mcp.cjs']}},{restore:true});other.run();
 assert.equal(other.calls.some(c=>c.args[1]==='remove'),false);
});
