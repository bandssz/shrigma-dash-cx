'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {initialDraft,prepareMcp}=require('./mcp_campaign_cli.cjs');
const now=Date.now(),time=new Date(now).toISOString(),rev='12345678-1234-4123-8123-123456789abc';
function fixture(brand='aristo'){
  const domain=brand==='fish'?'fishermans.com.br':'oaristocrata.com',list=brand==='fish'?5102:5101;
  const d={schema_version:'crm-campaign-v1',brand,channel:'email',initiative:{key:'teste-ficticio',name:'Teste fictício'},utm_campaign:brand+'-teste',name:'Rascunho fictício',subject:'Oferta fictícia',from_email:'Equipe <contato@'+domain+'>',reply_to:'contato@'+domain,list_ids:[list],template_id:5501,html:'<a href=\'{{ TrackLink "https://'+domain+'/products/kit?variant=10&utm_content=cta1" }}\'>Kit</a>{{ UnsubscribeURL }}',text:'https://'+domain+'/products/kit?variant=10&utm_content=texto\n{{ UnsubscribeURL }}',tags:['contexto-local'],send_at:null};
  const receipt=result=>({received_at:time,result});
  return{d,r:{brand,campaign:receipt({campaign_id:5987,revision:rev,content_matches_saved_revision:true,campaign:{name:d.name,subject:d.subject,from_email:d.from_email,reply_to:d.reply_to,lists:[list],template_id:d.template_id,body:d.html,altbody:d.text,status:'draft',send_at:null},counts:{sent:0,to_send:null,views:null,clicks:null,bounces:null},delivery_not_proven:true}),lists:receipt({brand,observed_at:time,statistics_refresh_at:null,lists:[{id:list,name:'Lista fictícia',subscriber_count:5}]}),templates:receipt({brand,templates:[{id:5501,name:'Wrapper fictício',type:'campaign',body:'{{ template "content" . }}{{ TrackView }}'}]})}};
}
test('both brands keep routing and shared tracking with exact MCP fields',()=>{
  for(const brand of ['fish','aristo']){
    const{d,r}=fixture(brand),first=initialDraft(d),prepared=prepareMcp(d,r,now);
    assert.deepEqual(Object.keys(first).sort(),['brand','draft','operation_id']);
    assert.deepEqual(Object.keys(first.draft).sort(),['altbody','body','from_email','lists','name','reply_to','subject','template_id']);
    assert.deepEqual(Object.keys(prepared.update.patch).sort(),Object.keys(first.draft).sort());
    assert.equal(prepared.update.campaign_id,5987);assert.equal(prepared.update.revision,rev);
    assert.match(prepared.definition.html,new RegExp('lm-5987-l'+d.list_ids[0]));assert.match(prepared.definition.text,/variant=10/);
    assert.equal(prepared.manifest.native_updated_at_available,false);assert.equal(prepared.manifest.native_started_at_available,false);
    assert.equal(prepared.manifest.statistics_refresh_at,null);assert.equal(prepared.manifest.remote_saved,false);
    assert.equal(prepared.manifest.initiative_mapping,'not_provided_by_mcp');assert.equal(prepared.wrapper,r.templates.result.templates[0].body);
    assert.deepEqual(prepareMcp(prepared.definition,r,now).definition,prepared.definition);
    for(const key of ['headers','attribs','tags','body_source','send_at','access_key','token'])assert(!Object.hasOwn(prepared.update.patch,key));
  }
});
test('rejects brand crossover, old receipts and unknown count instead of inventing fields',()=>{
  const{d,r}=fixture();const bad=change=>{const x=structuredClone(r);change(x);assert.throws(()=>prepareMcp(d,x,now));};
  bad(x=>x.brand='fish');bad(x=>x.lists.result.brand='fish');bad(x=>x.templates.result.brand='fish');
  bad(x=>x.campaign.received_at='2020-01-01T00:00:00Z');bad(x=>x.templates.received_at='2020-01-01T00:00:00Z');bad(x=>x.lists.result.observed_at='2020-01-01T00:00:00Z');
  bad(x=>x.campaign.result.counts.sent=null);bad(x=>delete x.campaign.result.counts.sent);
  bad(x=>delete x.lists.result.lists[0].subscriber_count);bad(x=>x.lists.result.lists.push(x.lists.result.lists[0]));
});
test('refuses a changed revision, started/scheduled campaign, protected IDs and list mismatch',()=>{
  const{d,r}=fixture();for(const change of [x=>x.content_matches_saved_revision=false,x=>x.revision='not-a-revision',x=>x.campaign.status='running',x=>x.counts.sent=1,x=>x.campaign.send_at=time,x=>x.campaign.lists=[9999],x=>x.campaign_id=188,x=>x.campaign.from_email='Equipe <contato@fishermans.com.br>']){const x=structuredClone(r);change(x.campaign.result);assert.throws(()=>prepareMcp(d,x,now));}
});
test('refused and uncertain transport responses cannot become a prepared mutation',()=>{
  const{d,r}=fixture();for(const result of [{refused:true,code:'FIRST_REAL_USE_APPROVAL_REQUIRED'},{state:'uncertain'},{error:'CONNECTOR_READ_OR_LEDGER_UNCONFIRMED'},{isError:true}]){const x=structuredClone(r);x.campaign.result=result;assert.throws(()=>prepareMcp(d,x,now),/UNCONFIRMED/);}
});
test('uses the server body limit and requires an admitted campaign template',()=>{
  const{d,r}=fixture();assert.throws(()=>initialDraft({...d,html:d.html+'x'.repeat(200001)}),/MCP_CONTENT_LIMIT/);
  const x=structuredClone(r);x.templates.result.templates[0].type='tx';assert.throws(()=>prepareMcp(d,x,now));
  const y=structuredClone(r);y.templates.result.templates=[];assert.throws(()=>prepareMcp(d,y,now));
});
test('rejects line breaks or NUL in MCP short fields before writing arguments',()=>{
  const{d,r}=fixture();for(const change of [{name:'A\nB'},{name:'A\0B'},{subject:'Oferta\0teste'}]){assert.throws(()=>initialDraft({...d,...change}),/MCP_SHORT_TEXT_INVALID/);assert.throws(()=>prepareMcp({...d,...change},r,now),/MCP_SHORT_TEXT_INVALID/);}
});
test('CLI creates separate offline artifacts and never overwrites an intention',()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'shrigma-mcp-skill-'));
  try{
    const{d,r}=fixture(),input=path.join(temp,'campaign.json'),receipts=path.join(temp,'receipts.json'),out=path.join(temp,'prepared');
    fs.writeFileSync(input,JSON.stringify(d));fs.writeFileSync(receipts,JSON.stringify(r));
    const args=[path.join(__dirname,'mcp_campaign_cli.cjs'),'prepare',input,'--receipts',receipts,'--out-dir',out];
    const one=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(one.status,0,one.stderr);
    const saved=fs.readFileSync(path.join(out,'mcp-update.json'),'utf8'),manifest=JSON.parse(fs.readFileSync(path.join(out,'tracking-manifest.json')));
    assert.equal(manifest.remote_saved,false);assert.equal(fs.readdirSync(out).length,6);
    const two=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(two.status,1);assert.match(two.stderr,/OUTPUT_EXISTS/);assert.equal(fs.readFileSync(path.join(out,'mcp-update.json'),'utf8'),saved);
    const draftOut=path.join(temp,'new-draft'),draft=spawnSync(process.execPath,[path.join(__dirname,'mcp_campaign_cli.cjs'),'draft',input,'--out-dir',draftOut],{encoding:'utf8'});
    assert.equal(draft.status,0,draft.stderr);assert.equal(JSON.parse(draft.stdout).tracking_pending,true);
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
module.exports={fixture,now};
