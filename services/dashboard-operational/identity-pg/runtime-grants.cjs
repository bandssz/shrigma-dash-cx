'use strict';
// Offline derivation from exact admitted source SQL. This emits metadata only;
// it never executes GRANT, uses a connection or inspects application rows.
const R=require('./protocol.cjs').registry(),M=require('./sql-map.cjs');
function describe(){const names=new Set(R.tables.map(t=>t.name)),matrix=new Map([...names].map(n=>[n,new Set()]));
 for(const s of R.statements.filter(s=>s.api==='prepare'&&s.kind==='query')){
  const ts=M.tokens(s.sql),op=ts[0].text.toUpperCase();
  for(let i=0;i<ts.length;i++){const token=ts[i],previous=ts[i-1]?.text.toUpperCase();if(token.kind!=='word'||!names.has(token.text))continue;
   if(['FROM','JOIN'].includes(previous))matrix.get(token.text).add('SELECT');
   if(['INTO','UPDATE'].includes(previous)||op==='DELETE'&&previous==='FROM'){
    const privileges=matrix.get(token.text);privileges.add(op);
    if(op==='INSERT'&&ts.some((t,j)=>t.text.toUpperCase()==='DO'&&ts[j+1]?.text.toUpperCase()==='UPDATE'))privileges.add('UPDATE');
   }
  }
 }
 return [...matrix].map(([table,p])=>({table,privileges:[...p].sort()}));
}
module.exports={describe};
if(require.main===module)require('node:fs').writeFileSync(require('node:path').join(__dirname,'runtime-grants.json'),JSON.stringify({schema:'dashboard-pg-runtime-grants-v1',registrySha256:R.registrySha256,relations:describe()},null,2)+'\n');
