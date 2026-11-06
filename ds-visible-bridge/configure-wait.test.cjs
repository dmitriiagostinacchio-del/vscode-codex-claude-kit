const {test}=require('node:test'),assert=require('node:assert/strict');
const {configure}=require('./configure-wait.cjs');
test('long report timeout changes only the ds_worker table and is idempotent',()=>{
 const prefix='model = "example"\n[mcp_servers.other]\ntool_timeout_sec = 15\n';
 const suffix='[mcp_servers.ds_worker.tools.ds_send_message]\napproval_mode = "approve"\n[desktop]\nsetting = true\n';
 const input=prefix+'[mcp_servers.ds_worker]\ncommand = "node"\nargs = ["mcp.cjs"]\n\n'+suffix;
 const output=configure(input);assert.ok(output.startsWith(prefix));assert.ok(output.endsWith(suffix));assert.match(output,/\[mcp_servers.ds_worker\]\ntool_timeout_sec = 7500\ncommand/);assert.equal(configure(output),output);
});
test('timeout update supports CRLF, rejects missing/duplicate settings and preserves secrets verbatim',()=>{
 const input='[mcp_servers.ds_worker]\r\ncommand = "node"\r\ntool_timeout_sec = 60 # old\r\n[mcp_servers.other.env]\r\nSECRET = "unchanged-test-placeholder"\r\n';
 const output=configure(input);assert.match(output,/tool_timeout_sec = 7500/);assert.ok(output.endsWith('[mcp_servers.other.env]\r\nSECRET = "unchanged-test-placeholder"\r\n'));
 assert.throws(()=>configure('[desktop]\nx=true\n'),/not found/);
 assert.throws(()=>configure('[mcp_servers.ds_worker]\ntool_timeout_sec=1\ntool_timeout_sec=2\n'),/Duplicate/);
});
