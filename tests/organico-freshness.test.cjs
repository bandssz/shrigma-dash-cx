'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),F=require(path.join(root,'organico-freshness.js'));
const now=Date.parse('2026-10-09T15:00:00Z'),stamp=minutes=>new Date(now-minutes*60000).toISOString();
const data=()=>({cx_story:[{marca:'fishermans',ultima_coleta:stamp(3000)},{marca:'aristocrata',ultima_coleta:stamp(5)},{marca:'olivas',ultima_coleta:stamp(10)}],organico_attribution:{coverage:[{marca:'fish',checked_at:stamp(20)},{marca:'aristo',checked_at:stamp(1)},{marca:'olivas',checked_at:stamp(2)}]}});
function element(){const classes=new Set();return {textContent:'',title:'',classes,classList:{toggle:(k,on)=>classes[on?'add':'delete'](k)}};}
test('Fish retains its stale collection even when other brands are recent',()=>{
 const e=element(),r=F.render(data(),'fish',e,now);
 assert.equal(r.groups.length,1);assert.equal(r.groups[0].stories.state,'stale');assert.equal(r.groups[0].stories.ageMinutes,3000);
 assert.match(e.textContent,/Fishermans.*sem atualização/);assert.doesNotMatch(e.title,/Aristocrata|Olivas/);assert(e.classes.has('velho'));
});
test('consolidated view keeps missing and stale brands visible',()=>{
 const p=data(),e=element();F.render(p,'todas',e,now);assert.match(e.textContent,/Fishermans.*sem atualização/);
 for(const name of ['Aristocrata','Fishermans','Olivas'])assert(e.title.includes(name));
 p.cx_story=p.cx_story.filter(r=>r.marca!=='fishermans');p.organico_attribution.coverage=p.organico_attribution.coverage.filter(r=>r.marca!=='fish');
 assert.equal(F.select(p,'todas',now).groups[1].stories.state,'unknown');
});
test('future or invalid collection timestamps never certify freshness',()=>{
 for(const invalid of [stamp(-1),'not-date','2026-02-30T12:00:00Z']){
  const p={cx_story:[{marca:'fish',ultima_coleta:stamp(1)},{marca:'fish',ultima_coleta:invalid}]};
  assert.equal(F.select(p,'fish',now).groups[0].stories.state,'unknown');
 }
});
test('post publication and cache generation cannot certify post collection',()=>{
 const p=data();p._cache_gerado_em=stamp(0);p.cx_post=[{marca:'fish',publicado_em:stamp(0),coletado_em:stamp(0)}];
 const before=JSON.stringify(p),g=F.select(p,'fish',now).groups[0];
 assert.deepEqual(g.posts,{state:'unknown',checkedAt:null,ageMinutes:null});assert.equal(JSON.stringify(p),before);
 assert.equal(F.select(p,'constructor',now).selected,'unknown');
});
test('brand switches reuse payload and preserve original thresholds',()=>{
 const e=element(),p=data();F.render(p,'fish',e,now);assert.match(e.textContent,/Fishermans/);
 F.render(p,'aristo',e,now);assert.match(e.textContent,/Aristocrata/);assert.doesNotMatch(e.title,/Fishermans|Olivas/);
 for(const [minutes,state] of [[90,'fresh'],[91,'aging'],[1560,'aging'],[1561,'stale']]){
  assert.equal(F.select({cx_story:[{marca:'fish',ultima_coleta:stamp(minutes)}]},'fish',now).groups[0].stories.state,state);
 }
});
test('distributed script and HTML CSP carry the new brand reader together',()=>{
 const html=fs.readFileSync(path.join(root,'organico.html'),'utf8'),js=fs.readFileSync(path.join(root,'assets/panels/organico.js'),'utf8');
 assert.match(html,/OrganicFreshness.render\(API,MARCA,/);assert(js.includes('OrganicFreshness'));
 for(const m of html.matchAll(/<script\s*>([\s\S]*?)<\/script>/g)){
  const digest=crypto.createHash('sha256').update(m[1]).digest('base64');assert(html.includes("'sha256-"+digest+"'"));new vm.Script(m[1]);
 }
 const hash=crypto.createHash('sha256').update(js).digest('hex').slice(0,12);
 assert(html.includes('assets/panels/organico.js?v='+hash));new vm.Script(js);
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'tools/panel-build/manifest.json')));
 assert.equal(manifest.organico.scripts.filter(p=>p==='organico-freshness.js').length,1);
 assert(!manifest.growth.scripts.includes('organico-freshness.js'));
});
