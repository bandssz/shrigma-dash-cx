'use strict';
const fs=require('node:fs'),path=require('node:path');
const {setupWorkerLease}=require('./segment-regular-worker-lease-fixture.cjs');
const Selection=require('../n8n/growth/segment-listmonk-selection.cjs');
const read=f=>fs.readFileSync(path.resolve(__dirname,'..',f),'utf8');
async function setupOperationGuard(db){
 const f=await setupWorkerLease(db),exec=sql=>typeof db.exec==='function'?db.exec(sql):db.query(sql);
 await db.query("UPDATE campaigns SET status='draft',sent=0,last_subscriber_id=0,started_at=NULL");
 await exec(read('n8n/growth/campaign-write-guard.sql'));
 const old=read('n8n/growth/segment-campaign-binding.sql').match(/EXECUTE \$ddl\$(CREATE FUNCTION crm_audience_v2\.campaign_send_guard\(\)[\s\S]*?)\$ddl\$;/);
 if(!old)throw Error('ORIGINAL_BINDING_GUARD_REQUIRED');
 await exec(old[1]);
 await exec('CREATE TRIGGER shrigma_audience_campaign_send_guard_v1 BEFORE UPDATE OR DELETE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION crm_audience_v2.campaign_send_guard()');
 const install=()=>exec(read('n8n/growth/segment-regular-operation-guard.sql'));
 const scan=()=>db.query(Selection.section(f.workerQuery.source,'next-campaigns').text,[[],[]]);
 // This helper simulates the future trusted scheduling transaction. It is not
 // an admission API and receives no grant or production operator identity.
 const schedule=async cid=>{
  await db.query('BEGIN');try{
   await db.query("SELECT set_config('shrigma.campaign_writer',$1,true)",[String(cid)]);
   await db.query("UPDATE campaigns SET status='scheduled' WHERE id=$1",[cid]);
   await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}
 };
 return {...f,install,scan,schedule};
}
module.exports={setupOperationGuard};
