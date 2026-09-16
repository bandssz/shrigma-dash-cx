// Monta a lista de quem cobrar hoje. Uma consulta só; a decisão de quem entra é SQL, não código,
// para caber na cabeça de quem for dar manutenção.
// Duas etapas, dois gargalos diferentes:
//   vitrine_sem_video — aceitou o convite, pôs o produto na vitrine e nunca gravou (o maior volume)
//   amostra_sem_video — recebeu produto de graça e ainda não postou
// O teto diário e o modo vêm de crm_tts_regra, por marca.
const sql = `
WITH r AS (SELECT marca, cobranca_modo, cobranca_max_dia FROM crm_tts_regra),
-- Titulo de anuncio nao cabe em DM: "Sabonete Natural Masculino O Aristocrata 150g 4.9 Estrelas 90mil
-- Avaliacoes" soa como catalogo, nao como gente falando. Corta o rabo de marketing e o nome em 42
-- caracteres, sempre em fronteira de palavra (cortar em "Frescor da" fica pior que nao cortar).
ja AS (  -- quem já levou cobrança nesta etapa não leva de novo, nunca. A PK garante, isto só evita o trabalho.
  SELECT marca, etapa, username FROM crm_tts_cobranca
),
hoje AS (  -- quanto já saiu hoje, por marca, para respeitar o teto
  SELECT marca, count(*)::int AS n FROM crm_tts_cobranca
   WHERE enviado_em >= date_trunc('day', now()) AND NOT dry_run GROUP BY 1
),
vitrine AS (
  SELECT DISTINCT ON (c.marca, c.username)
         c.marca, 'vitrine_sem_video'::text AS etapa, c.username, c.creator_open_id,
         c.colab_id AS referencia,
         -- NUNCA usar co.nome aqui: e o nome INTERNO da campanha ("FEITO JUSTAMENTE PRA VOCE",
         -- "trofeu e grana na linha"). Dentro de uma DM isso soa como se a gente tivesse errado
         -- o destinatario. So o titulo do produto, encurtado.
         COALESCE(nullif(regexp_replace(substring(
           regexp_replace(co.product_title, '\\s*[0-9.,]+\\s*(estrelas?|mil\\s*avalia|avalia).*$', '', 'i')
           from '^.{1,42}(?=\\s|$)'),
           -- o corte pode parar numa preposicao ("Frescor da"); pendurado assim fica pior que cortado antes
           '\\s+(da|de|do|das|dos|e|com|para|pra|em|no|na)$', '', 'i'), ''), 'nossos produtos') AS produto,
         COALESCE(c.nickname, c.username) AS nome
    FROM crm_tts_convite c
    LEFT JOIN crm_tts_colaboracao co ON co.marca = c.marca AND co.colab_id = c.colab_id
   WHERE c.showcase_product_count > 0 AND c.content_product_count = 0
     AND c.creator_open_id IS NOT NULL AND c.creator_open_id <> ''
   ORDER BY c.marca, c.username, c.atualizado_em DESC
),
amostra AS (
  SELECT DISTINCT ON (a.marca, a.username)
         a.marca, 'amostra_sem_video'::text AS etapa, a.username, a.creator_open_id,
         a.application_id AS referencia,
         COALESCE(nullif(regexp_replace(substring(
           regexp_replace(a.product_title, '\\s*[0-9.,]+\\s*(estrelas?|mil\\s*avalia|avalia).*$', '', 'i')
           from '^.{1,42}(?=\\s|$)'),
           -- o corte pode parar numa preposicao ("Frescor da"); pendurado assim fica pior que cortado antes
           '\\s+(da|de|do|das|dos|e|com|para|pra|em|no|na)$', '', 'i'), ''), 'o produto') AS produto,
         COALESCE(cr.nickname, a.username) AS nome
    FROM crm_tts_amostra a
    LEFT JOIN crm_tts_criador cr ON cr.marca = a.marca AND cr.username = a.username
   WHERE a.status IN ('SHIPPED','CONTENT_PENDING')
     AND a.creator_open_id IS NOT NULL AND a.creator_open_id <> ''
   ORDER BY a.marca, a.username, a.atualizado_em DESC
),
alvo AS (SELECT * FROM vitrine UNION ALL SELECT * FROM amostra),
fila AS (
  SELECT a.marca, a.etapa, a.username, a.creator_open_id, a.referencia,
         r.cobranca_modo AS modo,
         -- {nome} e {produto} trocados aqui, no SQL: o que vai pro log e exatamente o que vai na mensagem
         replace(replace(m.texto, '{nome}', a.nome), '{produto}', a.produto) AS texto,
         -- amostra antes de vitrine: quem recebeu produto de graca e a cobranca mais urgente
         row_number() OVER (PARTITION BY a.marca ORDER BY (a.etapa = 'amostra_sem_video') DESC, a.username) AS pos,
         r.cobranca_max_dia - COALESCE((SELECT h.n FROM hoje h WHERE h.marca = a.marca), 0) AS vagas
    FROM alvo a
    JOIN r ON r.marca = a.marca
    JOIN crm_tts_cobranca_modelo m ON m.marca = a.marca AND m.etapa = a.etapa AND m.ativo
    LEFT JOIN ja ON ja.marca = a.marca AND ja.etapa = a.etapa AND ja.username = a.username
   WHERE ja.username IS NULL AND r.cobranca_modo <> 'pausado'
)
-- pos <= vagas: o teto LIMITA a quantidade, nao so abre ou fecha o portao. Sem isto, uma marca com
-- teto 15 e 63 pendentes soltaria os 63 de uma vez no primeiro dia em que ligasse o modo ativo.
SELECT marca, etapa, username, creator_open_id, referencia, modo, texto
  FROM fila WHERE pos <= GREATEST(vagas, 0)
 ORDER BY marca, pos`;
return [{ json: { sql } }];
