// Nicho do influ, link gerado no cadastro e lente de receita por link — contra Postgres real (PGlite).
// Schema de crm_influ copiado da produção em 24/09/2026 (colunas e constraints).
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {PGlite}=require(process.env.CAMPAIGN_PGLITE_MODULE||'@electric-sql/pglite');
(async()=>{
 const db=new PGlite(); let checks=0;
 await db.exec(`
  CREATE TABLE crm_influ(marca text NOT NULL, influ text NOT NULL, nome text NOT NULL DEFAULT '', handle text NOT NULL DEFAULT '',
    comissao_pct numeric, ativo boolean NOT NULL DEFAULT true, desde date, obs text NOT NULL DEFAULT '',
    atualizado_em timestamptz NOT NULL DEFAULT now(), seguidores integer, porte text, modelo text, contato text,
    PRIMARY KEY(marca,influ),
    CONSTRAINT ck_crm_influ_marca CHECK (marca = ANY (ARRAY['aristo','fish','olivas'])));
  CREATE TABLE crm_influ_pedido(marca text, order_id text, influ text, pago boolean, receita_base numeric);
  CREATE TABLE crm_organico_attribution_order_v2(marca text, order_id text, dia date, model text,
    utm_medium text, utm_content text, receita_liquida numeric);`);
 const sql=fs.readFileSync(path.join(__dirname,'../n8n/influs/influ-nicho-link.sql'),'utf8');
 await db.exec(sql); await db.exec(sql); checks++; // idempotente: aplicar de novo não falha nem duplica constraint
 assert.equal((await db.query("SELECT count(*)::int n FROM pg_constraint WHERE conname='crm_influ_nicho_normalizado'")).rows[0].n,1); checks++;

 // --- nicho: só entra normalizado ---------------------------------------------------------
 await db.exec("INSERT INTO crm_influ(marca,influ,nicho) VALUES('aristo','ursobranco','pesca esportiva'),('aristo','capivara',NULL),('fish','peixe1','pesca')");
 for(const ruim of ['Pesca','  pesca','pesca  esportiva','p','x'.repeat(41)]){
   await assert.rejects(db.query("UPDATE crm_influ SET nicho=$1 WHERE influ='capivara'",[ruim]),/crm_influ_nicho_normalizado/); checks++;
 }
 await db.query("UPDATE crm_influ SET nicho='lifestyle' WHERE influ='capivara'"); checks++;

 // --- link: função pura de marca + slug ---------------------------------------------------
 const link=async(m,s)=>(await db.query('SELECT crm_influ_link_v1($1,$2) AS l',[m,s])).rows[0].l;
 assert.equal(await link('aristo','ursobranco'),'https://oaristocrata.com/?utm_source=influenciador&utm_medium=influs&utm_campaign=aristo-influs&utm_content=ursobranco'); checks++;
 assert.equal(await link('fish','peixe1'),'https://fishermans.com.br/?utm_source=influenciador&utm_medium=influs&utm_campaign=fish-influs&utm_content=peixe1'); checks++;
 assert.equal(await link('olivas','azeite'),'https://olivasdocampo.com.br/?utm_source=influenciador&utm_medium=influs&utm_campaign=olivas-influs&utm_content=azeite'); checks++;
 assert.equal(await link('aristo','Com Espaco'),null); checks++;
 assert.equal(await link('xpto','ursobranco'),null); checks++;

 // --- lente de link -----------------------------------------------------------------------
 await db.exec(`INSERT INTO crm_influ_pedido VALUES('aristo','1','ursobranco',true,90);
  INSERT INTO crm_organico_attribution_order_v2 VALUES
   ('aristo','gid://shopify/Order/1','2026-09-10','last_click','influs','ursobranco',100),   -- conta, com cupom
   ('aristo','gid://shopify/Order/2','2026-09-11','last_click','influs','ursobranco',50),    -- conta, sem cupom
   ('aristo','gid://shopify/Order/3','2026-09-12','last_click','INFLUS','URSOBRANCO',20),   -- caixa não importa
   ('aristo','gid://shopify/Order/4','2026-09-12','last_click','organico','ursobranco',999),-- outro portão: fora
   ('aristo','gid://shopify/Order/5','2026-09-12','last_non_direct','influs','ursobranco',999),-- outro modelo: fora
   ('fish','gid://shopify/Order/6','2026-09-12','last_click','influs','ursobranco',999),     -- slug é da Aristo: fora
   ('aristo','gid://shopify/Order/7','2026-08-01','last_click','influs','ursobranco',999),   -- fora da janela
   ('aristo','gid://shopify/Order/8','2026-09-12','last_click','influs','ninguem',999);      -- slug inexistente: fora`);
 const lente=(await db.query("SELECT * FROM crm_influ_link_receita_v1('2026-09-01','2026-09-30')")).rows;
 assert.equal(lente.length,1); checks++;
 const u=lente[0];
 assert.equal(u.marca,'aristo'); assert.equal(u.influ,'ursobranco'); checks++;
 assert.equal(u.pedidos,3); checks++;
 assert.equal(Number(u.receita),170); checks++;
 assert.equal(u.pedidos_sem_cupom,2); checks++;       // o pedido 1 usou cupom: não soma com a lente de cupom
 assert.equal(Number(u.receita_sem_cupom),70); checks++;
 assert.equal((await db.query("SELECT count(*)::int n FROM crm_influ_link_receita_v1('2026-10-01','2026-10-31')")).rows[0].n,0); checks++;
 console.log(`influ-nicho-link-postgres: ${checks} verificações ok`);
})().catch(e=>{console.error(e);process.exit(1)});
