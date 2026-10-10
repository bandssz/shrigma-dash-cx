"use strict";
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),assert=require("node:assert/strict"),test=require("node:test");
const dir=process.env.HEARTBEAT_LOCK_SOURCE_DIR||(fs.existsSync(path.join(__dirname,"prepare.cjs"))?__dirname:path.join(__dirname,"source"));
const m=require(path.join(dir,"prepare.cjs"));
test("fixed apply/restore stages preserve bounded wrapper and refuse original execution",()=>{
 for(const stage of ["apply","restore"]){const p=m.prepare(stage);assert.equal(p.stage,stage);assert.equal(p.executionAvailable,false);assert.equal(p.authorityCreated,false);assert.equal(p.statements.length,8);assert.equal(p.statements[0],"BEGIN ISOLATION LEVEL READ COMMITTED;");assert.equal(p.statements[1],"SET LOCAL statement_timeout='5s';");assert.equal(p.statements[2],"SET LOCAL lock_timeout='500ms';");assert.equal(p.statements[4],"SELECT pg_catalog.set_config('shrigma.heartbeat_lock_2s_expected',$1::text,true) IS NOT NULL AS expected_metadata_bound;");assert.equal(p.statements.at(-1),"COMMIT;");assert.equal(p.sourceSha256,m.ASSETS[stage.toUpperCase()+".atomic.sql"]);assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.statements));assert.throws(()=>m.executeOriginal(p),e=>e.code==="HEARTBEAT_LOCK_ORIGINAL_EXECUTION_NOT_ADMITTED");}
});
test("arbitrary stages and fabricated actor/grant inputs cannot produce prepared SQL",()=>{
 for(const v of [undefined,null,true,{},["apply"],"resume","apply;DROP TABLE campaigns",{stage:"apply",grant:true}])assert.throws(()=>m.prepare(v),e=>e.code==="HEARTBEAT_LOCK_STAGE_REFUSED");
});
test("runtime asset hash drift refuses preparation before yielding an ALTER",()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),"heartbeat-source-drift-"));try{for(const n of ["prepare.cjs",...Object.keys(m.ASSETS)])fs.copyFileSync(path.join(dir,n),path.join(d,n));const x=require(path.join(d,"prepare.cjs"));assert.equal(x.prepare("apply").executionAvailable,false);fs.appendFileSync(path.join(d,"APPLY.atomic.sql"),"\n-- drift\n");assert.throws(()=>x.prepare("apply"),e=>e.code==="HEARTBEAT_LOCK_SOURCE_DRIFT");}finally{fs.rmSync(d,{recursive:true,force:true});}
});
