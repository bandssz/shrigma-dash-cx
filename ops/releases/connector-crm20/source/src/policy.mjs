import {createHash, randomUUID} from 'node:crypto';
import {z} from 'zod';

export const BRANDS = Object.freeze({aristo: 'oaristocrata.com', fish: 'fishermans.com.br'});
export const INTERNAL_DOMAINS = Object.freeze(['oaristocrata.com', 'fishermans.com.br', 'shrigma.com.br']);
export const PROTECTED_IDS = Object.freeze([188, 189, 190, 191]);
export const sha = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value ?? null);
}
export class Refusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function deny(code, message) { throw new Refusal(code, message); }
export const operationId = z.uuid();
export const campaignId = z.number().int().positive();
const shortText = z.string().min(1).max(500).refine(s => !/[\r\n\0]/.test(s));
const bodyText = z.string().min(1).max(200000);
const ids = z.array(campaignId).min(1).max(100).refine(v => new Set(v).size === v.length);
export const draftSchema = z.strictObject({
  name: shortText, subject: shortText, from_email: shortText, reply_to: shortText,
  lists: ids, template_id: campaignId, body: bodyText, altbody: z.string().max(200000).default('')
});
export const patchSchema = draftSchema.partial().extend({altbody:z.string().max(200000).optional()}).required({from_email: true, reply_to: true});
export const baseSchema = {brand: z.enum(['aristo', 'fish'])};
export const mutationSchema = {...baseSchema, operation_id: operationId, campaign_id: campaignId, revision: z.uuid()};
export const TOOLS = Object.freeze({
  listmonk_campaign_get: z.strictObject({...baseSchema, campaign_id: campaignId}),
  listmonk_lists_get: z.strictObject(baseSchema),
  listmonk_templates_get: z.strictObject(baseSchema),
  listmonk_draft_create: z.strictObject({...baseSchema, operation_id: operationId, draft: draftSchema}),
  listmonk_draft_update: z.strictObject({...mutationSchema, patch: patchSchema}),
  listmonk_campaign_test: z.strictObject({...mutationSchema, recipient: z.string().max(254)}),
  listmonk_campaign_schedule: z.strictObject({...mutationSchema, send_at: z.string().max(40)}),
  listmonk_campaign_to_draft: z.strictObject(mutationSchema),
  listmonk_campaign_pause: z.strictObject(mutationSchema),
  listmonk_operation_get: z.strictObject({operation_id: operationId})
});
export function identity(user, brand) {
  if (!user || user.active !== true) deny('ANALYST_REVOKED', 'Acesso individual desativado ou não provisionado.');
  if (!(brand in BRANDS) || user.brand !== brand) deny('BRAND_FORBIDDEN', 'Esta marca não pertence ao seu acesso.');
  return user;
}
export function mailbox(input, displayName = false) {
  if (typeof input !== 'string' || /[\r\n\0]/.test(input)) deny('ADDRESS_INVALID', 'Endereço inválido.');
  let address = input;
  if (displayName && input.includes('<')) {
    const m = /^(?:[^<>\r\n]{1,100})?\s*<([^<>]+)>$/.exec(input);
    if (!m) deny('ADDRESS_INVALID', 'Remetente inválido.');
    address = m[1];
  }
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(address) || address.length > 254) deny('ADDRESS_INVALID', 'Informe exatamente um endereço, sem cabeçalhos adicionais.');
  return address.toLowerCase();
}
export function validateDraft(input, user) {
  const parsed = draftSchema.safeParse(input);
  if (!parsed.success) deny('DRAFT_FIELDS_REQUIRED', 'Rascunho exige from_email na raiz, reply_to, listas, template, assunto, nome e corpo válidos.');
  const d = parsed.data;
  if (d.lists.some(id => !user.listIds.includes(id))) deny('LIST_BRAND_FORBIDDEN', 'Todas as listas devem pertencer à sua marca e ao seu acesso.');
  if (!user.templateIds.includes(d.template_id)) deny('TEMPLATE_BRAND_FORBIDDEN', 'Template não autorizado para esta marca.');
  const from = mailbox(d.from_email, true), reply = mailbox(d.reply_to);
  if (from.split('@')[1] !== BRANDS[user.brand] || !user.fromEmails.includes(from)) deny('FROM_BRAND_FORBIDDEN', 'Remetente deve estar na raiz do payload e autorizado para o domínio da marca.');
  if (!user.replyToEmails.includes(reply)) deny('REPLY_TO_FORBIDDEN', 'Reply-To deve ser explícito e autorizado para esta marca.');
  return {...d, reply_to: reply, lists: [...d.lists].sort((a,b) => a-b)};
}
export function draftFromRemote(campaign) {
  if (!campaign || !Number.isSafeInteger(campaign.id) || typeof campaign.uuid !== 'string' || campaign.type !== 'regular' || campaign.messenger !== 'email' || campaign.content_type !== 'html') deny('CAMPAIGN_SHAPE_UNSUPPORTED', 'A campanha não corresponde ao formato nativo criado por este conector.');
  const headers = campaign.headers;
  if(['media','attachments'].some(key=>campaign[key]!==undefined&&campaign[key]!==null&&(!Array.isArray(campaign[key])||campaign[key].length!==0)))deny('CAMPAIGN_MEDIA_UNSUPPORTED','Mídia e anexos fora do formato admitido; nenhuma ação executada.');
  if (!Array.isArray(headers) || headers.length !== 1 || Object.keys(headers[0] || {}).join('|') !== 'Reply-To') deny('REPLY_TO_REQUIRED', 'A campanha precisa de um único Reply-To explícito.');
  if (!Array.isArray(campaign.lists)) deny('CAMPAIGN_LISTS_UNCONFIRMED', 'As listas não foram comprovadas.');
  return {name: campaign.name, subject: campaign.subject, from_email: campaign.from_email,
    reply_to: headers[0]['Reply-To'], lists: campaign.lists.map(x => typeof x === 'number' ? x : x.id),
    template_id: campaign.template_id, body: campaign.body, altbody: campaign.altbody ?? ''};
}
export function snapshot(campaign, user) {
  const draft = validateDraft(draftFromRemote(campaign), user);
  if (!['draft','scheduled','running','paused','finished','cancelled'].includes(campaign.status)) deny('CAMPAIGN_STATUS_UNCONFIRMED', 'Estado da campanha desconhecido.');
  return {...draft, status: campaign.status, send_at: campaign.send_at ?? null};
}
export function contentFingerprint(value) {
  const {status, send_at, ...content} = value;
  return sha(content);
}
export function payload(draft, sendAt = null, attribs = undefined, tags = undefined) {
  return {name: draft.name, subject: draft.subject, from_email: draft.from_email,
    lists: draft.lists, template_id: draft.template_id, body: draft.body, altbody: draft.altbody,
    type: 'regular', messenger: 'email', content_type: 'html', headers: [{'Reply-To': draft.reply_to}],
    send_at: sendAt, ...(attribs ? {attribs} : {}), ...(tags ? {tags} : {})};
}
export function scheduleTime(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !z.iso.datetime({offset:true}).safeParse(value).success || !Number.isFinite(Date.parse(value))) deny('SCHEDULE_OFFSET_REQUIRED', 'Agendamento exige data válida e completa com fuso.');
  if (Date.parse(value) - now < 900000) deny('SCHEDULE_TOO_SOON', 'Agende com pelo menos15 minutos de folga no relógio do servidor.');
  return new Date(value).toISOString();
}
export function recipient(email, user) {
  const normalized = mailbox(email);
  if (!INTERNAL_DOMAINS.includes(normalized.split('@')[1])) deny('TEST_EXTERNAL_RECIPIENT', 'Teste permitido somente nos três domínios internos.');
  const id = user.testRecipients[normalized];
  if (!Number.isSafeInteger(id) || id < 1) deny('TEST_RECIPIENT_NOT_REGISTERED', 'O destinatário interno precisa estar cadastrado no registro de testes desta marca.');
  return {email: normalized, id};
}
export function activeSubscriber(subscriber, target, user) {
  if (!subscriber || subscriber.id !== target.id || typeof subscriber.email !== 'string' || mailbox(subscriber.email) !== target.email || subscriber.status !== 'enabled') deny('TEST_SUBSCRIBER_INACTIVE', 'Destinatário inexistente, inativo ou bloqueado.');
  if (!Array.isArray(subscriber.lists) || !subscriber.lists.some(l => user.listIds.includes(l.id) && l.subscription_status === 'confirmed' && l.status === 'active')) deny('TEST_SUBSCRIPTION_INACTIVE', 'O destinatário precisa de assinatura confirmada em lista ativa desta marca.');
}
export function diff(before, after) {
  return Object.keys({...before, ...after}).sort().filter(k => canonical(before?.[k] ?? null) !== canonical(after?.[k] ?? null)).map(field => ({field, before: before?.[field] ?? null, after: after?.[field] ?? null}));
}
export const newRevision = () => randomUUID();
