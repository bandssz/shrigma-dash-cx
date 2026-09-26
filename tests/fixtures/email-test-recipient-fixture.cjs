'use strict';
const fs=require('node:fs'),path=require('node:path'),{setup,uuid,GEC}=require('./email-test-fixture.cjs');
const GEE=require('../../growth-email-expressions.js'),ENP=require('../../n8n/growth/email-native-preview.cjs'),ETR=require('../../n8n/growth/email-test-recipient-protocol.cjs'),{digest}=require('../../n8n/growth/template-operation-receipt.cjs');
const deps={GEC,GEE,ENP,digest};
async function fixture(options={}){const f=await setup(options);await f.db.exec("ALTER TABLE subscribers ADD COLUMN name text NOT NULL DEFAULT 'Fixture';ALTER TABLE subscribers ADD COLUMN uuid uuid NOT NULL DEFAULT '20000000-0000-4000-8000-000000000001';");for(const file of ['email-native-test.sql','email-test-recipient.sql'])await f.db.exec(fs.readFileSync(path.join(__dirname,'../../n8n/growth',file),'utf8'));await f.db.query('SELECT crm_email_test_enable_v2(true)');
 f.prepare=async(recipient='tester@fishermans.com.br',actor='panel:manager',draft_id='d_fixture',expected_version=1)=>(await f.db.query('SELECT crm_email_test_prepare_v2($1,$2) r',[actor,{draft_id,expected_version,recipient}])).rows[0].r;
 f.plan=async(recipient='tester@fishermans.com.br',actor='panel:manager',draft_id='d_fixture',expected_version=1)=>{const e=await f.prepare(recipient,actor,draft_id,expected_version);let p=ETR.prepare(e,{statusCode:200,body:{data:e.snapshot?.native}},deps);p=ETR.rendered(p,{statusCode:200,body:'<html><body><p>Exemplo fictício</p></body></html>'},deps);if(p.eligible){const proof=(await f.db.query('SELECT crm_email_test_preview_finish_v2($1,$2,$3) r',[actor,p.preview_token,p])).rows[0].r;if(!proof.eligible)throw Error('fixture preview: '+proof.code);}return p;};
 f.v2request=(n,p)=>({draft_id:p.draft_id,expected_version:p.version,recipient:p.recipient,preview_token:p.preview_token,idempotency_key:uuid(n),confirm:'enviar_teste'});
 f.v2claim=async(n,p=null,actor='panel:manager',request=null)=>{p||=await f.plan();return(await f.db.query('SELECT crm_email_test_claim_v2($1,$2,$3) r',[actor,request||f.v2request(n,p),p])).rows[0].r;};
 return f;}
module.exports={fixture,uuid,GEC,GEE,ENP,ETR,deps};
