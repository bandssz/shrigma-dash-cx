'use strict';
// Transport-only QUERY demo. No adapter authority, stage, native tools, PG or network.
const B=require('./stdio-bridge.cjs');
function unwrap(r){if(!r||r.isError===true)throw Error();let v=r.structuredContent;if(v===undefined){if(!Array.isArray(r.content)||r.content.length!==1||r.content[0]?.type!=='text'||typeof r.content[0].text!=='string')throw Error();v=JSON.parse(r.content[0].text);}if(v?.procedure!=='listDomains'||!Array.isArray(v.result)||v.result.length>10000)throw Error();return v.result.length;}
async function main(){
 const a=process.argv.slice(2),synthetic=a.length===2&&a[0]==='--synthetic',readonly=a.length===4&&a[0]==='--readonly-list-domains';
 if(!synthetic&&!readonly){process.stdout.write('{"schema":"read-stdio-demo-v1","state":"disabled"}\n');return;}
 const input=synthetic?{projectName:'synthetic-project',serviceName:'synthetic-service'}:{projectName:a[2],serviceName:a[3]};B.inputShape('listDomains',input);
 const bridge=B.createStdioBridge({enabled:true,directory:a[1],materialize:q=>{if(q.executor!=='execute_query'||q.procedure!=='listDomains'||q.input!==input)throw Error();return{procedure:'listDomains',input};},timeoutMs:15000});
 try{
  const count=unwrap(await bridge.execute({executor:'execute_query',procedure:'listDomains',input}));if(synthetic&&count!==0)throw Error();
  process.stdout.write(JSON.stringify({schema:'read-stdio-demo-v1',state:synthetic?'confirmed-synthetic':'received-list-domains',domainCount:count,mutationSent:false})+'\n');
 }catch{process.stdout.write('{"schema":"read-stdio-demo-v1","state":"unknown","mutationSent":false}\n');process.exitCode=1;}
 finally{bridge.close();process.stdin.destroy();}
}
module.exports=Object.freeze({unwrap});
if(require.main===module)main().catch(()=>{process.stderr.write('READ_STDIO_DEMO_REFUSED\n');process.exitCode=1;});
