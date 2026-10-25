'use strict';
// Business definitions for the restricted area, separate from editor audiences.
const crypto=require('node:crypto');
function create(db){
 db.exec('CREATE TABLE IF NOT EXISTS crm_restricted_publics_v1(id TEXT PRIMARY KEY,brand TEXT NOT NULL,owner TEXT NOT NULL,name TEXT NOT NULL,rule_json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS crm_restricted_purchase_source_v1(brand TEXT PRIMARY KEY,coverage_json TEXT NOT NULL)');
 db.exec('CREATE TABLE IF NOT EXISTS crm_restricted_publics_backup_v1(backup_id TEXT PRIMARY KEY,public_id TEXT NOT NULL,brand TEXT NOT NULL,record_json TEXT NOT NULL,backed_at TEXT NOT NULL)');
 return {
  list:brand=>db.prepare('SELECT id,name,rule_json,updated_at FROM crm_restricted_publics_v1 WHERE brand=? ORDER BY updated_at DESC').all(brand).map(x=>({id:x.id,name:x.name,rule:JSON.parse(x.rule_json),updatedAt:x.updated_at})),
  save:({id,brand,owner,name,rule,expectedUpdatedAt})=>{
   db.exec('SAVEPOINT restricted_public_save');try{
    const old=id?db.prepare('SELECT * FROM crm_restricted_publics_v1 WHERE id=? AND brand=?').get(id,brand):null;
    if(id&&!old)throw Object.assign(Error('PAID_PUBLIC_NOT_FOUND'),{code:'PAID_PUBLIC_NOT_FOUND',status:404});
    if(expectedUpdatedAt!==undefined&&old?.updated_at!==expectedUpdatedAt)throw Object.assign(Error('PAID_PUBLIC_VERSION_CHANGED'),{code:'PAID_PUBLIC_VERSION_CHANGED',status:409});
    const key=id||crypto.randomUUID(),updatedAt=new Date(Math.max(Date.now(),old?Date.parse(old.updated_at)+1:0)).toISOString();
    if(old)db.prepare('INSERT INTO crm_restricted_publics_backup_v1 VALUES(?,?,?,?,?)').run(crypto.randomUUID(),id,brand,JSON.stringify(old),updatedAt);
    db.prepare('INSERT INTO crm_restricted_publics_v1 VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,rule_json=excluded.rule_json,updated_at=excluded.updated_at WHERE brand=excluded.brand').run(key,brand,owner,name,JSON.stringify(rule),updatedAt);db.exec('RELEASE restricted_public_save');return {id:key,brand,name,rule,updatedAt};
   }catch(e){db.exec('ROLLBACK TO restricted_public_save; RELEASE restricted_public_save');throw e;}
  },
  coverage:brand=>{const r=db.prepare('SELECT coverage_json FROM crm_restricted_purchase_source_v1 WHERE brand=?').get(brand);return r?JSON.parse(r.coverage_json):null;},
  setCoverage:(brand,value)=>db.prepare('INSERT INTO crm_restricted_purchase_source_v1 VALUES(?,?) ON CONFLICT(brand) DO UPDATE SET coverage_json=excluded.coverage_json').run(brand,JSON.stringify(value))
 };
}
module.exports={create};
