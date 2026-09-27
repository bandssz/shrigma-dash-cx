'use strict';
const fs=require('node:fs'),N=require('../n8n/growth/journey-graph-native.cjs'),base=require('./journey-graph-release-fixture.cjs');
const sql=fs.readFileSync(require.resolve('../n8n/growth/journey-graph-native.sql'),'utf8');
async function install(db){
 const f=await base.install(db);
 await db.exec("ALTER TABLE public.templates ADD COLUMN is_default boolean NOT NULL DEFAULT false;ALTER TABLE public.templates ADD COLUMN updated_at timestamptz DEFAULT clock_timestamp();CREATE SEQUENCE public.synthetic_native_id START 1000;ALTER TABLE public.templates ALTER COLUMN id SET DEFAULT nextval('public.synthetic_native_id');");
 await db.exec(sql);const cache=new Map(),calls={create:0,read:0};let sequence=1000;
 const nativeCreate=async(body,options)=>{calls.create++;if(options.cacheTarget!=='fixture-single-instance')throw Error('wrong synthetic instance');const t=(await f.query('INSERT INTO templates(name,type,subject,body,body_source,is_default) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[body.name,body.type,body.subject,body.body,body.body_source,body.is_default??false])).rows[0];cache.set(t.id,{...t});return {status:200,body:{data:t}};};
 const nativeRead=async id=>{calls.read++;return {status:200,body:{data:cache.get(id)}};};
 const settings={query:f.query,nativeCreate,nativeRead,cacheTarget:'fixture-single-instance'};
 const provider=N.createNativeProvider(settings),actor='panel:synthetic';
 return {...f,sql,cache,calls,settings,native:provider,newProvider:options=>N.createNativeProvider({...settings,...options}),
  async release(b='fish'){return f.provider.prepare(actor,await f.request(b));},
  requestFor(r){return {request_id:base.id(sequence++),brand:r.brand,release_id:r.id,expected_material_sha256:r.material_sha256};},
  async prepared(b='fish'){const release=await this.release(b),request=this.requestFor(release),receipt=await provider.prepare(actor,request);return {release,request,receipt};}
 };
}
module.exports={install,sql,id:base.id};
