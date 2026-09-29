const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
// Extrai só o helper q() do código do nó "Monta SQL" (o resto depende do runtime do n8n).
const src=fs.readFileSync(path.join(__dirname,'../n8n/tiktok/canal_sql.js'),'utf8');
const ini=src.indexOf('const q = s =>'),fim=src.indexOf('\n};',ini)+3;
const q=new Function(src.slice(ini,fim)+';return q;')();
test('texto com $ não deixa $N dentro do SQL (o n8n leria como parâmetro)',()=>{
 for(const t of ['LINHA N40 por R$29','custa $1 ou ${x}','$','a$$b']){const sql=q(t);assert.doesNotMatch(sql,/\$/,t);}
 assert.equal(q("sem cifrão d'água"),"'sem cifrão d''água'");
 assert.equal(q(null),'NULL');
});
test('o literal volta ao texto original no Postgres',async()=>{
 const mod=process.env.CAMPAIGN_PGLITE_MODULE;if(!mod)return;
 const {PGlite}=require(mod);const db=new PGlite();
 for(const t of ["R$29 d'água 🎣",'$1$2','fim$']){
  const r=await db.query(`SELECT ${q(t)}::text AS v, (${q(JSON.stringify({t}))})::jsonb->>'t' AS j`);
  assert.equal(r.rows[0].v,t);assert.equal(r.rows[0].j,t);
 }
});
