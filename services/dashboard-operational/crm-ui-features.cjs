'use strict';
// Local release configuration only. No source/customer records or executor.
const crypto=require('node:crypto');
const KEYS=Object.freeze(['campaignPeriods','automationBrandCount','metricAvailabilityLabels','campaignAdvanced','campaignScheduleSummary','campaignJsonImport','campaignTestRecipient','emailPreviewLayouts','whatsappTemplatePreview']);
const BRANDS=['fish','aristo'],MODES=['off','qa','all'];
const QA=new Set(['felipebandeira+codex@oaristocrata.com',...BRANDS.flatMap(b=>['leitura','edicao'].map(m=>`qa.crm+${b}.${m}@shrigma.com.br`))]);
const fail=(code,status=400)=>{throw Object.assign(Error(code),{code,status});};
function create({db,authorizeAdmin,authorizeUser,now=Date.now}){
 db.exec("CREATE TABLE IF NOT EXISTS crm_ui_release_flags_v1(brand TEXT NOT NULL,feature TEXT NOT NULL,mode TEXT NOT NULL,changed_by TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(brand,feature))");
 function config(){const states=Object.fromEntries(BRANDS.map(b=>[b,Object.fromEntries(KEYS.map(k=>[k,'off']))]));for(const r of db.prepare('SELECT brand,feature,mode FROM crm_ui_release_flags_v1 ORDER BY brand,feature').all()){if(!BRANDS.includes(r.brand)||!KEYS.includes(r.feature)||!MODES.includes(r.mode))fail('CRM_FEATURE_CONFIG_INVALID',503);states[r.brand][r.feature]=r.mode;}return{states,revision:crypto.createHash('sha256').update(JSON.stringify(states)).digest('hex')};}
 function read(context,brand){if(!BRANDS.includes(brand))fail('CRM_FEATURE_BRAND',400);const user=authorizeUser({...context,area:'growth',productFront:'growth',brand,edit:false}),c=config(),qa=user.role==='superadmin'||QA.has(String(user.email||'').toLowerCase());if(user.role!=='superadmin'&&!(user.viewBrands||user.brands||[]).includes(brand))fail('CRM_FEATURE_BRAND_DENIED',403);return{schema:'crm-ui-features-v1',brand,revision:c.revision,flags:Object.fromEntries(KEYS.map(k=>[k,c.states[brand][k]==='all'||c.states[brand][k]==='qa'&&qa]))};}
 function inspect(context){authorizeAdmin({...context,method:'POST'});return{schema:'crm-ui-feature-settings-v1',...config(),keys:KEYS,modes:MODES};}
 function update(context,body){const user=authorizeAdmin(context);if(!body||Object.getPrototypeOf(body)!==Object.prototype||Object.keys(body).sort().join(',')!=='brand,expectedRevision,feature,mode'||!BRANDS.includes(body.brand)||!KEYS.includes(body.feature)||!MODES.includes(body.mode)||!/^[a-f0-9]{64}$/.test(body.expectedRevision||''))fail('CRM_FEATURE_INPUT');if(db.isTransaction)fail('CRM_FEATURE_BUSY',409);db.exec('BEGIN IMMEDIATE');try{const before=config();if(before.revision!==body.expectedRevision)fail('CRM_FEATURE_CONFLICT',409);db.prepare('INSERT INTO crm_ui_release_flags_v1(brand,feature,mode,changed_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(brand,feature) DO UPDATE SET mode=excluded.mode,changed_by=excluded.changed_by,updated_at=excluded.updated_at').run(body.brand,body.feature,body.mode,user.id,now());const after=config();db.exec('COMMIT');return{schema:'crm-ui-feature-settings-v1',...after,changed:{brand:body.brand,feature:body.feature,before:before.states[body.brand][body.feature],after:body.mode}};}catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}}
 return Object.freeze({read,inspect,update});
}
const restrictedUser=user=>user?.role==='superadmin'||QA.has(String(user?.email||'').toLowerCase());
module.exports={create,KEYS,BRANDS,restrictedUser};
