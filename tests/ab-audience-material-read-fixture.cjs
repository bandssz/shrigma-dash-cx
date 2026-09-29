'use strict';
const F=require('./ab-audience-prepare-fixture.cjs'),S=require('../n8n/growth/segment-audience-store.cjs'),R=require('../n8n/growth/ab-audience-material-read.cjs');
async function setup(db){
 const x=await F.setup(db);
 await db.exec(`ALTER TABLE campaigns ADD COLUMN uuid uuid NOT NULL DEFAULT gen_random_uuid(),ADD COLUMN to_send integer NOT NULL DEFAULT 0,
 ADD COLUMN max_subscriber_id integer NOT NULL DEFAULT 0,ADD COLUMN last_subscriber_id integer NOT NULL DEFAULT 0,
 ADD COLUMN archive_slug text,ADD COLUMN archive_template_id integer,ADD COLUMN archive_meta jsonb NOT NULL DEFAULT '{}',ADD COLUMN created_at timestamptz DEFAULT now();
 ALTER TABLE templates ADD COLUMN subject text NOT NULL DEFAULT 'Synthetic subject',ADD COLUMN body_source text,ADD COLUMN is_default boolean NOT NULL DEFAULT false,ADD COLUMN created_at timestamptz DEFAULT now();
 ALTER TABLE lists ADD COLUMN uuid uuid NOT NULL DEFAULT gen_random_uuid(),ADD COLUMN type text NOT NULL DEFAULT 'private',ADD COLUMN description text NOT NULL DEFAULT '',ADD COLUMN created_at timestamptz DEFAULT now(),ADD COLUMN updated_at timestamptz DEFAULT now();
 ALTER TABLE media ADD COLUMN uuid uuid NOT NULL DEFAULT gen_random_uuid(),ADD COLUMN provider text NOT NULL DEFAULT 'filesystem',ADD COLUMN content_type text NOT NULL DEFAULT 'application/pdf',ADD COLUMN thumb text NOT NULL DEFAULT '',ADD COLUMN meta jsonb NOT NULL DEFAULT '{}',ADD COLUMN created_at timestamptz DEFAULT now();`);
 await db.exec('ALTER TABLE public.campaign_lists ADD CONSTRAINT material_cl_campaign_fk FOREIGN KEY(campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE ON UPDATE CASCADE; ALTER TABLE public.campaign_media ADD CONSTRAINT material_cm_campaign_fk FOREIGN KEY(campaign_id) REFERENCES public.campaigns(id) ON DELETE CASCADE ON UPDATE CASCADE;');
 await db.exec(F.read('n8n/growth/ab-audience-material-access.sql'));
 const read=(brand='fish',campaignIds=brand==='fish'?[100,101]:[200,201],options={})=>x.transaction(async tx=>{await tx.query(S.SQL.setup);await tx.query("SELECT set_config('TimeZone','UTC',true),set_config('DateStyle','ISO, YMD',true)");return R.readCampaignMaterials({query:tx.query,brand,campaignIds,...options});});
 return {...x,read};
}
module.exports={setup,read:F.read,uuid:F.uuid};
