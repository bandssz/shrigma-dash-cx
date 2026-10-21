'use strict';
const test=require('node:test'),a=require('node:assert/strict');
const {createNativeCatalog,SQL}=require('../services/crm-campaign/native-catalog.cjs');
const auth={actor:'panel:synthetic-original',caps:['read_content','submission']};
function fixture({brand='fish',proofAuth=auth}={}){const calls=[],metadata={read_at:'2026-10-21T13:00:00Z',templates:[{id:116,name:'Synthetic original layout',type:'campaign',version:'a'.repeat(32),available:true}],initiatives:[{utm_campaign:'synthetic-original',key:'original'}]};const port=createNativeCatalog({request:async path=>{calls.push({path});return [{id:16,name:'Aristo real id',status:'active',tags:['aristo']},{id:17,name:'Fish real id',status:'active',tags:['fish']},{id:99,name:'Mixed',status:'active',tags:['aristo','fish']},{id:100,name:'Retired',status:'active',tags:['fish','aposentada']}];},query:async(sql,args)=>{calls.push({sql,args});return {rows:[{result:{auth:proofAuth,metadata}}]};}});return {calls,metadata,port,input:{key:'synthetic-original-key',auth,command:{acao:'campanha_catalogo',brand}}};}
for(const brand of ['aristo','fish'])test(brand+': API16 lists retain real ids/names; complete layout and initiative metadata comes from original pool',async()=>{
 const f=fixture({brand}),r=await f.port.execute(f.input);a.equal(r.status,200);a.equal(r.body.brand,brand);a.deepEqual(r.body.lists.map(l=>l.id),[brand==='aristo'?16:17]);a.deepEqual(r.body.templates,f.metadata.templates);a.deepEqual(r.body.initiatives,f.metadata.initiatives);a.equal(r.body.read_at,f.metadata.read_at);a.equal(f.calls.length,2);a.equal(f.calls[0].path,'/api/lists?minimal=true&per_page=all');a.deepEqual(f.calls[1].args,['synthetic-original-key',auth.actor,brand]);
});
test('read capability is required before Listmonk I/O; submission is not submit or read',async()=>{
 const f=fixture();await a.rejects(f.port.execute({...f.input,auth:{...auth,caps:['submission']}}),e=>e.status===403);a.deepEqual(f.calls,[]);
});
test('same-statement identity revocation prevents catalog disclosure',async()=>{
 for(const proofAuth of [null,{...auth,actor:'panel:other'},{...auth,caps:[]}]){const f=fixture({proofAuth});await a.rejects(f.port.execute(f.input),e=>e.status===403);}
});
test('empty metadata remains empty; no guessed default layout is inserted',async()=>{
 const f=fixture();f.metadata.templates=[];f.metadata.initiatives=[];const r=await f.port.execute(f.input);a.deepEqual(r.body.templates,[]);a.deepEqual(r.body.initiatives,[]);
});
test('business SELECT projection has no credential reads, writes, claims or history access',()=>{
 a.match(SQL,/FROM public.templates/);a.match(SQL,/FROM public.crm_familia_campanha/);a.match(SQL,/md5\(to_jsonb\(t\)::text\)/);a.doesNotMatch(SQL,/\b(INSERT|UPDATE|DELETE|FOR SHARE|FOR UPDATE|crm_dash_chave|shrigma_template_key_v2|lease|request_hash)\b/i);
});
