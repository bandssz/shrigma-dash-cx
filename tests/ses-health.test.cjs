const test=require('node:test'),assert=require('node:assert/strict');const S=require('../growth-ses.js');
const now=Date.parse('2026-09-15T01:00:00Z');
const brand=marca=>({marca,finalizacao_pendente:0,entregue_sem_gravacao:0,resultado_incerto:0,sem_confirmacao_15min:0,falhas_24h:0,reclamacoes_24h:0});
const fixture=()=>({crm_email_ses:{health:{schema_version:1,checked_at:'2026-09-15T00:59:00Z',collector:{last_poll_ok_at:'2026-09-15T00:59:50Z',last_poll_count:0},queue:{checked_at:'2026-09-15T00:59:50Z',visible:0,inflight:0,delayed:0},pending_ingest_15min:0,conflicts:0,brands:[brand('fish'),brand('aristo')]}}});
test('healthy empty poll is evidence of polling, not a delivery guarantee',()=>{const x=S.health(fixture(),'todas',now);assert.equal(x.alerts.length,2);assert.match(x.alerts[0].text,/Consulta à fila/);assert.equal(x.alerts[0].level,'ok');});
test('delivered but unfinalized messages and recent collector errors stay visible',()=>{const a=fixture();a.crm_email_ses.health.brands[1].entregue_sem_gravacao=108;a.crm_email_ses.health.brands[1].finalizacao_pendente=108;a.crm_email_ses.health.collector.last_error_at='2026-09-15T00:58:00Z';const text=S.health(a,'aristo',now).alerts.map(a=>a.text).join(' ');assert.match(text,/108.*registro incompleto/);assert.match(text,/falha no processamento/);assert.doesNotMatch(S.health(a,'fish',now).alerts.map(a=>a.text).join(' '),/108/);});
test('old, absent, future and malformed diagnostics never imply healthy operation',()=>{for(const change of [a=>delete a.crm_email_ses.health,a=>a.crm_email_ses.health.checked_at='2020-01-01',a=>a.crm_email_ses.health.checked_at='2027-01-01']){const a=fixture();change(a);assert.equal(S.health(a,'todas',now).alerts.some(a=>a.level==='ok'),false);}const a=fixture();a.crm_email_ses.health.collector.last_poll_ok_at=null;assert.equal(S.health(a,'todas',now).alerts.some(a=>a.level==='ok'),false);a.crm_email_ses.health.brands[0].falhas_24h='0';assert.match(S.health(a,'fish',now).alerts.map(a=>a.text).join(' '),/diagnóstico.*indisponível/);});
test('collector interruption and conflicts are global; failures and uncertainty are brand scoped',()=>{const a=fixture(),h=a.crm_email_ses.health;h.collector.last_poll_ok_at='2026-09-15T00:50:00Z';h.conflicts=2;h.brands[0].resultado_incerto=1;h.brands[1].falhas_24h=3;assert.match(S.health(a,'fish',now).alerts.map(a=>a.text).join(' '),/cinco minutos.*2 eventos.*1 envios/s);assert.doesNotMatch(S.health(a,'fish',now).alerts.map(a=>a.text).join(' '),/3 falhas/);});

test('queue backlog warns and stale queue counts do not masquerade as zero',()=>{const a=fixture();a.crm_email_ses.health.queue.visible=300;assert.match(S.health(a,'fish',now).alerts.find(x=>x.text.startsWith('Fila SES')).text,/300 eventos/);a.crm_email_ses.health.queue.error_at='2026-09-15T01:00:00Z';assert.match(S.health(a,'fish',now).alerts.map(x=>x.text).join(' '),/Tamanho da fila sem medição/);});

test('ten-minute cached snapshot never becomes a five-minute collector alarm',()=>{
 const a=fixture(),h=a.crm_email_ses.health;h.checked_at='2026-09-15T00:50:00Z';h.collector.last_poll_ok_at='2026-09-15T00:49:55Z';h.queue.checked_at='2026-09-15T00:49:30Z';
 const x=S.health(a,'fish',now);assert.equal(x.stale,false);assert.equal(x.alerts.some(a=>a.level==='danger'),false);assert.match(x.alerts[0].text,/anteriores à consulta/);assert.match(x.alerts[1].text,/0 eventos/);
 h.collector.last_poll_ok_at='2026-09-15T00:44:00Z';assert.equal(S.health(a,'fish',now).alerts[0].level,'danger');
});
test('stale snapshot preserves factual backlog with its timestamp instead of implying live health',()=>{
 const a=fixture(),h=a.crm_email_ses.health;h.checked_at='2026-09-15T00:40:00Z';h.collector.last_poll_ok_at='2026-09-15T00:39:55Z';h.queue.checked_at='2026-09-15T00:39:30Z';h.brands[0].resultado_incerto=2;
 const x=S.health(a,'fish',now);assert.equal(x.stale,true);assert.equal(x.checked_at,h.checked_at);assert.equal(x.alerts.some(a=>a.level==='ok'),false);assert.match(x.alerts.map(x=>x.text).join(' '),/mais de 15 minutos.*2 envios com resultado incerto/);
});
const path=require('node:path');const {parseHTML}=require(require.resolve('linkedom',{paths:[path.resolve(__dirname,'../../growth-test-tools/node_modules')]}));
const ui={esc:v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'),timestamp:v=>String(v)};
function healthMarkup(a,brand='fish'){return parseHTML(S.healthHtml(a,brand,ui,now)).document;}
function operatorText(doc){const copy=doc.querySelector('.ses-health').cloneNode(true);copy.querySelectorAll('[data-crm-owner-only]').forEach(el=>el.remove());return copy.textContent;}
test('manager health preserves uncertainty, failures and timestamp while queue counts remain owner diagnostics',()=>{
 const a=fixture(),h=a.crm_email_ses.health;h.queue.visible=300;h.collector.last_error_at='2026-09-15T00:58:00Z';h.conflicts=2;h.brands[0].resultado_incerto=7;h.brands[1].resultado_incerto=999;
 const doc=healthMarkup(a),text=operatorText(doc),owner=doc.querySelector('[data-crm-owner-only]');
 assert.match(text,/2026-09-15T00:59:00Z.*Brasília/);assert.match(text,/Há resultados aguardando atualização/);assert.match(text,/Falha ao atualizar resultados/);assert.match(text,/2 confirmações divergentes/);assert.match(text,/7 envios com resultado incerto.*antes de qualquer novo envio/);
 assert.doesNotMatch(text,/300|999|SES|fila|coletor|conciliação|SQL/);assert.match(owner.textContent,/300 eventos/);assert.equal(owner.hasAttribute('open'),false);
});
test('every failed, late or unavailable health check has an operator explanation without changing its severity',()=>{
 const mutations=[a=>delete a.crm_email_ses.health,a=>a.crm_email_ses.health.checked_at='2027-01-01',a=>a.crm_email_ses.health.checked_at='2026-09-15T00:40:00Z',a=>a.crm_email_ses.health.collector.last_poll_ok_at=null,a=>a.crm_email_ses.health.collector.last_poll_ok_at='2026-09-15T00:40:00Z',a=>a.crm_email_ses.health.queue.visible=300,a=>a.crm_email_ses.health.queue.visible=null,a=>a.crm_email_ses.health.pending_ingest_15min=5,a=>a.crm_email_ses.health.conflicts=null,a=>a.crm_email_ses.health.brands[0].falhas_24h='0',a=>Object.assign(a.crm_email_ses.health.brands[0],{finalizacao_pendente:3,entregue_sem_gravacao:2,sem_confirmacao_15min:4,falhas_24h:5,reclamacoes_24h:1})];
 for(const mutate of mutations){const a=fixture();mutate(a);const alerts=S.health(a,'fish',now).alerts.filter(x=>['warning','danger'].includes(x.level));assert.ok(alerts.length);for(const alert of alerts)assert.ok(alert.operator,alert.text);const doc=healthMarkup(a);assert.equal(doc.querySelectorAll('.ses-operational-alerts .ses-health-danger').length,alerts.filter(x=>x.level==='danger').length);assert.doesNotMatch(operatorText(doc),/coletor|SES|fila|SQL/);}
});
test('a ten-minute cached successful poll stays informative and an old poll never claims current delivery',()=>{
 const a=fixture(),h=a.crm_email_ses.health;h.checked_at='2026-09-15T00:50:00Z';h.collector.last_poll_ok_at='2026-09-15T00:49:55Z';h.queue.checked_at='2026-09-15T00:49:30Z';
 let doc=healthMarkup(a);assert.equal(doc.querySelectorAll('.ses-operational-alerts .ses-health-danger').length,0);assert.match(operatorText(doc),/isso não confirma a entrega/);
 h.checked_at='2026-09-15T00:40:00Z';h.collector.last_poll_ok_at='2026-09-15T00:39:55Z';h.queue.checked_at='2026-09-15T00:39:30Z';doc=healthMarkup(a);assert.match(operatorText(doc),/mais de 15 minutos/);assert.doesNotMatch(operatorText(doc),/Atualização consultada/);
});
