'use strict';
// Pure functions-isolate relay. Never prints or logs DTOs; caller publishes projection only.
(function(scope){
 const PROCS=Object.freeze({createComposeService:'execute_mutation',inspectComposeService:'execute_query',getDockerContainers:'execute_query',listDomains:'execute_query',updateComposeSourceInline:'execute_destructive',updateComposeEnv:'execute_destructive',createDomain:'execute_mutation',deleteDomain:'execute_destructive',deployComposeService:'execute_destructive',stopComposeService:'execute_destructive',startComposeService:'execute_mutation'});
 const NAMES={execute_query:'mcp__easypanel__execute_query',execute_mutation:'mcp__easypanel__execute_mutation',execute_destructive:'mcp__easypanel__execute_destructive'};
 const exact=(v,ks)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===ks.length&&ks.every(k=>{const d=Object.getOwnPropertyDescriptor(v,k);return !!d&&d.enumerable&&Object.hasOwn(d,'value');});
 // UTF8 size without Buffer/TextEncoder (absent in the functions isolate).
 const bytes=s=>{let n=0;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);if(c<128)n++;else if(c<2048)n+=2;else if(c>=0xd800&&c<=0xdbff){const d=s.charCodeAt(++i);if(!(d>=0xdc00&&d<=0xdfff))throw Error('READ_STDIO_RELAY_UNKNOWN');n+=4;}else if(c>=0xdc00&&c<=0xdfff)throw Error('READ_STDIO_RELAY_UNKNOWN');else n+=3;}return n;};
 const privateInput=input=>{if(!input||Object.getPrototypeOf(input)!==Object.prototype)throw Error();const stack=[input];let count=0;while(stack.length){const v=stack.pop();if(++count>4096)throw Error();for(const [k,x]of Object.entries(v)){if(/^(?:env)$|password|token|secret|scram|privatekey/i.test(k)&&x!==''&&x!==null&&x!==undefined)return true;if(x&&typeof x==='object')stack.push(x);}}return false;};
 function createFunctionsRelay({enabled=false,nativeApproved=false,tools=null,allowedQueries=[],allowedMutations=[],timeoutMs=15000,readPublic,writeToNode,retainPrivate}={}){
  if(typeof enabled!=='boolean'||typeof nativeApproved!=='boolean'||!Number.isSafeInteger(timeoutMs)||timeoutMs<10||timeoutMs>60000)throw Error('READ_STDIO_RELAY_UNKNOWN');
  const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
  if(!Array.isArray(allowedQueries)||!Array.isArray(allowedMutations)||allowedQueries.length>16||allowedMutations.length>16)throw Error('READ_STDIO_RELAY_UNKNOWN');
  const scopes={execute_query:allowedQueries.map(canonical),execute_mutation:allowedMutations.map(canonical),execute_destructive:allowedMutations.map(canonical)};
  let seq=0,closed=false,busy=false,interrupt=null;
  const projection=state=>Object.freeze({schema:'read-stdio-relay-result-v1',seq,state});
  function abort(){closed=true;if(interrupt)interrupt();return projection('unknown');}
  async function step(raw){
   if(!enabled)return Object.freeze({schema:'read-stdio-relay-result-v1',state:'disabled',seq:0});
   if(closed||busy){abort();return projection('unknown');}
   busy=true;let timer,stop;
   const stopped=new Promise(resolve=>{stop=()=>resolve(projection('unknown'));interrupt=stop;});
   timer=setTimeout(abort,timeoutMs);
   const work=(async()=>{let q,result;try{
    if(typeof raw!=='string'||bytes(raw)>4097)throw Error();
    q=JSON.parse(raw.trim());if(!Number.isSafeInteger(q?.seq)||q.seq!==seq+1||q.schema!=='read-stdio-request-v1'||q.kind!=='mcp')throw Error();seq=q.seq;
    if(!nativeApproved)throw Error();
    // There is no helper dispatch, regardless of supplied callbacks or approval.
    {
     const isPrivate=q.visibility==='private';if(!exact(q,['schema','seq','kind','visibility','executor',isPrivate?'args':'file'])||!['public','private'].includes(q.visibility))throw Error();
     let args;if(isPrivate){args=q.args;if(bytes(JSON.stringify(q))>4096||typeof retainPrivate!=='function')throw Error();}
     else{if(typeof readPublic!=='function')throw Error();const r=await readPublic(q.file);if(closed)throw Error();if(!exact(r,['schema','seq','executor','args','bytes','sha256'])||r.schema!=='read-stdio-public-readback-v1'||r.seq!==seq||r.executor!==q.executor||r.bytes!==q.file?.bytes||r.sha256!==q.file?.sha256)throw Error();args=r.args;}
     if(closed)throw Error();
     if(!exact(args,['procedure','input'])||PROCS[args.procedure]!==q.executor||!NAMES[q.executor]||typeof tools?.[NAMES[q.executor]]!=='function'||typeof retainPrivate!=='function'||privateInput(args.input)!==isPrivate)throw Error();
     if(!isPrivate&&args.procedure==='updateComposeEnv'&&args.input?.env!=='')throw Error();
     if(!scopes[q.executor].includes(canonical(args)))throw Error();
     if(isPrivate)retainPrivate(seq,args);
     result=await tools[NAMES[q.executor]]({procedure:args.procedure,input:args.input});if(closed)throw Error();retainPrivate(seq,{kind:'mcp-response',value:result});
    }
    if(closed)throw Error();
    const response=JSON.stringify({schema:'read-stdio-response-v1',seq,ok:true,result});if(bytes(response)>1048576||typeof writeToNode!=='function')throw Error();await writeToNode(response+'\n');if(closed)throw Error();
    return projection('responded');
   }catch{abort();return projection('unknown');}})();
   try{return await Promise.race([work,stopped]);}finally{clearTimeout(timer);busy=false;if(interrupt===stop)interrupt=null;}
  }
  return Object.freeze({step,abort});
 }
 scope.READ_STDIO_FUNCTIONS_RELAY=createFunctionsRelay;
 if(typeof module==='object'&&module.exports)module.exports={createFunctionsRelay};
})(globalThis);
