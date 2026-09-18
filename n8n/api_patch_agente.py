#!/usr/bin/env python3
"""Acrescenta os blocos `cx_agente` e `cx_handoff` à API de leitura do dashboard (workflow mfP48DvaKeCt2r2p):
  - nó "Consulta payload" (Postgres): dois pares novos no json_build_object, antes de 'cx_tempo';
  - nó "Recorta por painel" (Code): as duas chaves na whitelist do painel cx.
Protocolo: GET → backup em ~/work/n8n-snap/ → PUT → GET → diff campo a campo (só os dois nós, só o campo esperado).
Uso: export N8N_KEY='…'; python3 api_patch_agente.py            (idempotente: se já tem o bloco, não faz nada)
"""
import json, os, sys, time, urllib.request, urllib.error

BASE = 'https://n8n-n8n.tazdb8.easypanel.host/api/v1'
WF = 'mfP48DvaKeCt2r2p'
KEY = os.environ.get('N8N_KEY') or sys.exit('exporta N8N_KEY')

def api(method, path, body=None):
    req = urllib.request.Request(BASE + path, method=method, headers={'X-N8N-API-KEY': KEY, 'Content-Type': 'application/json'},
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=120) as r: return json.load(r)
    except urllib.error.HTTPError as e: sys.exit(f'{method} {path} → HTTP {e.code}: {e.read().decode()[:500]}')

BLOCO = """  -- Por agente (18/09): cx_agente_dia — fechamentos por pessoa separando DESCARTE (0 msg humana) de EFETIVO; maduro/resolutivo/voltou
  -- só sobre efetivos (7 dias); mensagens somadas (média = soma ÷ efetivos na tela); CSAT 2/6/10 do ticket fechado. 120 dias.
  'cx_agente', (CASE WHEN '{{ $('Busca painel').first().json.efetivo }}' IN ('cx','todos') THEN (SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.dia, t.marca), '[]'::json) FROM (
      SELECT marca, agente_id, agente_nome, to_char(dia,'YYYY-MM-DD') AS dia, fechados, descartes, efetivos, maduros, resolutivos, voltaram,
             msgs_humanas, msgs_cliente, csat_avaliados, csat_bom, csat_ruim, coletado_em
      FROM cx_agente_dia WHERE dia > current_date - 120) t) ELSE '[]'::json END),
  -- Chegam ao humano (18/09): cx_handoff_dia — tickets por marca × canal × dia de criação e quantos foram para pessoa (denominador da capacidade). 120 dias.
  'cx_handoff', (CASE WHEN '{{ $('Busca painel').first().json.efetivo }}' IN ('cx','todos') THEN (SELECT coalesce(json_agg(row_to_json(t) ORDER BY t.dia, t.marca, t.canal), '[]'::json) FROM (
      SELECT marca, canal, to_char(dia,'YYYY-MM-DD') AS dia, tickets, chegam_humano, wismo, coletado_em
      FROM cx_handoff_dia WHERE dia > current_date - 120) t) ELSE '[]'::json END),
"""
ANC_SQL = "  'cx_tempo', (CASE WHEN"
ANC_WL = "'cx_tempo',"

antes = api('GET', f'/workflows/{WF}')
snap = os.path.expanduser('~/work/n8n-snap'); os.makedirs(snap, exist_ok=True)
bk = os.path.join(snap, f"{WF}_backup_{time.strftime('%Y%m%d-%H%M%S')}.json")
json.dump(antes, open(bk, 'w'), ensure_ascii=False, indent=1)
print(f"backup: {bk}  ({antes['name']} · ativo={antes['active']} · {len(antes['nodes'])} nós)")

nodes = json.loads(json.dumps(antes['nodes']))
mud = {}
for n in nodes:
    if n['name'] == 'Consulta payload':
        q = n['parameters']['query']
        if "'cx_agente'," in q: print('Consulta payload: já tem cx_agente'); continue
        assert q.count(ANC_SQL) == 1, 'âncora cx_tempo não é única no SQL'
        n['parameters']['query'] = q.replace(ANC_SQL, BLOCO + ANC_SQL); mud['Consulta payload'] = 'query'
    if n['name'] == 'Recorta por painel':
        js = n['parameters']['jsCode']
        if "'cx_agente'" in js: print('Recorta por painel: já tem cx_agente'); continue
        assert js.count(ANC_WL) == 1, 'âncora cx_tempo não é única na whitelist'
        n['parameters']['jsCode'] = js.replace(ANC_WL, "'cx_agente','cx_handoff'," + ANC_WL); mud['Recorta por painel'] = 'jsCode'
if not mud: sys.exit('nada a fazer')

api('PUT', f'/workflows/{WF}', {'name': antes['name'], 'nodes': nodes, 'connections': antes['connections'], 'settings': antes.get('settings', {})})
print('PUT ok:', mud)

depois = api('GET', f'/workflows/{WF}')
erros = []
a_por = {n['name']: n for n in antes['nodes']}; d_por = {n['name']: n for n in depois['nodes']}
if set(a_por) != set(d_por): erros.append(f'conjunto de nós mudou: {set(a_por) ^ set(d_por)}')
for nome in sorted(set(a_por) & set(d_por)):
    a, d = a_por[nome], d_por[nome]
    for c in sorted((set(a) | set(d)) - {'position'}):
        if a.get(c) != d.get(c):
            if c == 'parameters':
                sub = sorted(k for k in set(a['parameters']) | set(d['parameters']) if a['parameters'].get(k) != d['parameters'].get(k))
                print(f"  nó '{nome}': parameters mudou em {sub}")
                if not (nome in mud and sub == [mud[nome]]): erros.append(f"mudança inesperada em '{nome}'.parameters {sub}")
            else:
                print(f"  nó '{nome}': campo '{c}' mudou"); erros.append(f"mudança inesperada em '{nome}'.{c}")
if antes['connections'] != depois['connections']: erros.append('connections mudaram')
else: print('  connections: iguais')
if antes['active'] != depois['active']: erros.append(f"active mudou: {antes['active']} → {depois['active']}")
else: print(f"  active: {depois['active']} (igual)")
for nome, campo in mud.items():
    if d_por[nome]['parameters'][campo] != {n['name']: n for n in nodes}[nome]['parameters'][campo]: erros.append(f'{nome}.{campo} gravado difere do enviado')
if erros:
    print('\nPROBLEMAS:'); [print(' -', e) for e in erros]; print(f'restaurar: PUT do backup {bk}'); sys.exit(1)
print('\nOK — só o esperado mudou.')
