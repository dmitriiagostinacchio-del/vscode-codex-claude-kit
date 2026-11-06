const {test}=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),path=require('node:path');
test('MCP malformed input does not kill the server or pollute stdout',async()=>{
 const p=spawn(process.execPath,[path.join(__dirname,'mcp.cjs')],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);
 const exited=new Promise((resolve,reject)=>{p.on('exit',resolve);p.on('error',reject)});
 p.stdin.end('not-json\nnull\n[]\n'+JSON.stringify({jsonrpc:'2.0',id:3,method:'ping'})+'\n'+JSON.stringify({jsonrpc:'2.0',id:4,method:'tools/list'})+'\n');
 assert.equal(await exited,0,err);
 const responses=out.trim().split('\n').map(x=>JSON.parse(x));
 assert.equal(responses[0].error.code,-32700);assert.equal(responses[1].error.code,-32600);assert.equal(responses[2].error.code,-32600);
 assert.deepEqual(responses.find(x=>x.id===3).result,{});
 const tools=responses.find(x=>x.id===4).result.tools;assert.equal(tools.length,4);
 assert.ok(tools.find(x=>x.name==='ds_send_message').inputSchema.properties.request_id);
});
