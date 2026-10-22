#!/usr/bin/env python3
"""Pré-voo local v3: HTML, wrapper, texto e UTMs. Sem rede ou efeito no emissor."""
import argparse, hashlib, html, json, re, sys
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urlparse, parse_qs, urljoin

STYLE = re.compile(r'<style\b[^>]*>(.*?)</style>', re.I | re.S)
TOKEN = re.compile(r'\{\{.*?\}\}', re.S)
LAYOUT = {'email-container','fluid','stack-pad','stack-col','verlist'}
URL = re.compile(r'https?://[^\s<>\"\']+')
UTMS = ('utm_source','utm_medium','utm_campaign','utm_content','utm_term')
SHORT = {'bit.ly','tinyurl.com','cutt.ly','encurtador.com.br','is.gd','t.co','shorturl.at','rebrand.ly'}
BRANDS = {'fish':'fishermans.com.br','aristo':'oaristocrata.com'}

def css_rules(css, dark=False):
    out=[];start=0;i=0
    while i<len(css):
        if css[i]!='{':i+=1;continue
        selector=css[start:i].strip();depth=1;j=i+1
        while j<len(css) and depth:
            if css[j]=='{':depth+=1
            elif css[j]=='}':depth-=1
            j+=1
        content=css[i+1:j-1]
        if selector.startswith('@'):
            out.extend(css_rules(content,dark or bool(re.search(r'prefers-color-scheme\s*:\s*dark',selector,re.I))))
        else:out.append((selector,dark,content))
        start=j;i=j
    return out

class Markup(HTMLParser):
    def __init__(self, tokens):
        super().__init__(convert_charrefs=True);self.tokens=tokens;self.classes=set();self.images=[];self.links=[];self.active=[];self.tags=[]
    def restore(self,v):
        for k,t in self.tokens.items():v=v.replace(k,t)
        return v
    def handle_starttag(self,tag,attrs):
        a={k:self.restore(v or '') for k,v in attrs};self.classes.update(a.get('class','').split());self.tags.append(tag)
        if tag=='img':self.images.append(a)
        if tag in ('a','v:roundrect') and 'href' in a:self.links.append(a['href'])
        if tag in ('script','iframe','object','embed','form') or any(k.startswith('on') for k in a):self.active.append(tag)
        if any(re.match(r'\s*javascript:',v,re.I) for k,v in a.items() if k in ('href','src')):self.active.append(tag)
    def handle_comment(self,data):
        if re.match(r'\s*\[if\b',data,re.I):
            inner=Markup(self.tokens);inner.feed(re.sub(r'^\s*\[if[^]]*\]>|<!\[endif\]\s*$','',data,flags=re.I))
            self.links.extend(inner.links);self.images.extend(inner.images);self.classes.update(inner.classes);self.active.extend(inner.active)

def parse_markup(source):
    tokens={}
    def mask(m):
        key=f'SHRIGMATOKEN{len(tokens):06d}';tokens[key]=m[0];return key
    parser=Markup(tokens);parser.feed(TOKEN.sub(mask,source));return parser

def destination(raw):
    raw=html.unescape(raw).strip();tracked=False
    m=re.fullmatch(r'\{\{\s*TrackLink\s+("(?:[^"\\]|\\.)*"|`[^`]*`)\s*\}\}',raw,re.S)
    if m:
        raw=json.loads(m[1]) if m[1].startswith('"') else m[1][1:-1];tracked=True
    if raw.endswith('@TrackLink'):raw=raw[:-10];tracked=True
    return raw,tracked

def audit(source, *, brand, text=None, template=None, campaign=None, campaign_id=None, list_ids=None, prohibited=(), modelo=False):
    if brand not in BRANDS:raise ValueError('Informe explicitamente a marca: fish ou aristo.')
    errors=[];warnings=[];checks={};positions={};count=0;pending=[]
    def err(code,message):errors.append({'code':code,'message':message})
    def warn(code,message):warnings.append({'code':code,'message':message})
    combined=source+'\n'+(template or '')
    parser=parse_markup(combined)
    if parser.active:err('ACTIVE_HTML','HTML contém conteúdo ativo ou handlers: '+', '.join(sorted(set(parser.active))))
    ph=sorted(set(re.findall(r'__[A-Z][A-Z0-9_]*__',combined+(text or ''))))
    if ph:err('PLACEHOLDERS','Preencher: '+', '.join(ph))
    unsub=lambda s:len(re.findall(r'\{\{\s*UnsubscribeURL\s*\}\}',s))
    if not unsub(combined):err('UNSUBSCRIBE','Descadastro ausente no HTML/wrapper.')
    if text is not None and not unsub(text):err('UNSUBSCRIBE_TEXT','Descadastro ausente no texto.')
    if text is None:warn('TEXT_NOT_CHECKED','Versão texto não fornecida; não foi conferida.')
    pixels=list(re.finditer(r'\{\{\s*TrackView\s*\}\}',combined));checks['trackview_count']=len(pixels)
    if template is not None:
        if len(pixels)!=1:err('TRACKVIEW_COUNT','Corpo + wrapper devem conter um único TrackView; revisar branches no preview.')
    else:
        if len(pixels)>1:err('TRACKVIEW_COUNT','Mais de um TrackView no corpo.')
        warn('WRAPPER_NOT_CHECKED','Wrapper não fornecido; quantidade final de pixels não confirmada.')
    for label,part in [('HTML',source),('wrapper',template or '')]:
        closing=part.lower().rfind('</body>')
        if closing>=0 and re.search(r'\{\{\s*TrackView\s*\}\}',part[closing:]):err('PIXEL_OUTSIDE_BODY',label+': mover pixel para dentro do documento final.')
        if re.search(r'(?<!\{)\{\s*TrackView\s*\}(?!\})',part):err('COLLAPSED_TEMPLATE',label+': TrackView com chaves colapsadas.')
    for img in parser.images:
        if 'alt' not in img or (not img['alt'].strip() and img.get('role') not in ('presentation','none') and img.get('aria-hidden')!='true'):
            err('IMAGE_ALT','Imagem informativa sem alt descritivo; decorativa requer papel explícito.')
    styles=STYLE.findall(combined);css=re.sub(r'/\*.*?\*/',' ', '\n'.join(styles),flags=re.S);rules=css_rules(css)
    classes=lambda s:set(re.findall(r'\.([A-Za-z][\w-]*)',s))
    dark=set().union(*(classes(s) for s,d,c in rules if d)) if rules else set()
    og=set().union(*(classes(part) for s,d,c in rules for part in s.split(',') if re.search(r'\[data-ogs[bc]\]',part,re.I))) if rules else set()
    missing_dark=sorted(parser.classes-LAYOUT-dark);missing_og=sorted(parser.classes-LAYOUT-og)
    checks.update(style_blocks=len(styles),classes=len(parser.classes),missing_dark=missing_dark,missing_ogsc=missing_og)
    if missing_dark:warn('DARK_COVERAGE','Revisar classes sem regra dark: '+', '.join(missing_dark))
    if missing_og:warn('OGSC_COVERAGE','Revisar classes sem seletor ogsc/ogsb: '+', '.join(missing_og))
    if not re.search(r'display\s*:\s*none',source,re.I):warn('PREHEADER_REVIEW','Confirmar preheader; bloco oculto não foi identificado.')
    if any(t.strip() and t.strip().casefold() in combined.casefold() for t in prohibited):err('PROHIBITED_COPY','Termo proibido encontrado no conteúdo.')
    expected=f"lm-{campaign_id}-l{'-'.join(map(str,sorted(set(list_ids or []))))}" if campaign_id and list_ids else None
    def inspect(raw,field,needs_click):
        nonlocal count
        try:url,tracked=destination(raw)
        except (ValueError,TypeError):err('LINK_EXPRESSION',field+': expressão TrackLink inválida.');return
        if any(t in url for t in ('UnsubscribeURL','MessageURL','OptinURL')) or url.startswith(('mailto:','tel:','#')):return
        if '{{' in url:err('DYNAMIC_LINK',field+': destino dinâmico exige revisão renderizada.');return
        u=urlparse(url)
        if u.scheme not in ('http','https'):
            if url:err('LINK_SCHEME',field+': destino não é URL HTTP(S) absoluta.')
            return
        if u.path.startswith(('/policies/','/politica-de-privacidade','/termos-de-uso')):return
        if (u.hostname or '').lower() in SHORT:err('SHORTENER',field+': verificar destino final do encurtador; não validado offline.')
        if needs_click and not tracked:err('CLICK_TRACKING',field+': link comercial sem TrackLink.')
        if u.username or u.password:err('URL_CREDENTIALS',field+': URL contém credencial embutida.')
        if u.path.startswith('/discount/'):
            red=parse_qs(u.query).get('redirect',[])
            if len(red)!=1:err('COUPON_DESTINATION',field+': cupom exige destino explícito único.');return
            target=urlparse(urljoin(url,red[0]))
            if (target.scheme,target.netloc)!=(u.scheme,u.netloc):err('COUPON_ORIGIN',field+': destino do cupom sai da origem.');return
            u=target
        q=parse_qs(u.query,keep_blank_values=True);count+=1
        for k in UTMS:
            if modelo and k=='utm_term' and not q.get(k):continue
            if len(q.get(k,[]))!=1 or not q[k][0]:err('UTM_MISSING_OR_DUPLICATE',field+': '+k+' ausente/vazio/duplicado.')
        one=lambda k:q.get(k,[''])[0]
        if one('utm_source')!='listmonk':err('UTM_SOURCE',field+': usar utm_source=listmonk.')
        if one('utm_medium')!='campanha':err('UTM_MEDIUM',field+': usar utm_medium=campanha.')
        if campaign and one('utm_campaign')!=campaign:err('UTM_CAMPAIGN',field+': campanha diverge do manifesto.')
        term=one('utm_term')
        if modelo and not term:pending.append(field)
        elif not re.search(r'(?:^|--)lm-[1-9]\d*-l[1-9]\d*(?:-[1-9]\d*)*$',term):err('DISPATCH_ID',field+': termo sem identidade do disparo/listas.')
        elif expected and term!=expected and not term.endswith('--'+expected):err('DISPATCH_ID',field+': ID/listas divergentes do manifesto.')
        if u.hostname not in (BRANDS[brand],'www.'+BRANDS[brand]):err('STORE_SCOPE',field+': destino fora da loja esperada; requer mapeamento específico.')
        content=one('utm_content')
        if content in ('link','alt-link','cupom-auto'):warn('GENERIC_POSITION',field+': nomear utm_content por peça/posição em novos criativos.')
        if content:positions.setdefault(content,set()).add(u.geturl())
    for link in parser.links:inspect(link,'HTML',True)
    if text is not None:
        # Extract TrackLink expressions first; their URL must not be counted a second time.
        expressions=[]
        def hold(m):expressions.append(m[0]);return ' '
        rest=re.sub(r'\{\{\s*TrackLink\s+(?:"(?:[^"\\]|\\.)*"|`[^`]*`)\s*\}\}',hold,text)
        for link in expressions+URL.findall(rest):inspect(link,'texto',False)
    for k,urls in positions.items():
        if len(urls)>1:err('POSITION_COLLISION',k+': mesma posição aponta para destinos diferentes.')
    if count==0:err('NO_COMMERCIAL_LINK','Nenhum link comercial verificável.')
    checks.update(commercial_links=count,positions=sorted(positions),html_sha256=hashlib.sha256(source.encode()).hexdigest(),text_sha256=hashlib.sha256(text.encode()).hexdigest() if text is not None else None)
    if pending:warn('DISPATCH_PENDING','Modo modelo: utm_term (identidade do disparo) fica para a campanha no CRM; conferir antes de agendar.')
    warnings.append({'code':'LOCAL_SCOPE','message':'Pré-voo local não confirma catálogo, headers recebidos, publicação, entrega ou inbox.'})
    return {'schema_version':'email-preflight-v3','ok':not errors,'errors':errors,'warnings':warnings,'checks':checks}

def main(argv=None):
    a=argparse.ArgumentParser(description=__doc__);a.add_argument('html');a.add_argument('--template');a.add_argument('--text');a.add_argument('--brand',choices=BRANDS,required=True);a.add_argument('--campaign');a.add_argument('--campaign-id',type=int);a.add_argument('--list-ids');a.add_argument('--proibidos',default='');a.add_argument('--json',action='store_true');a.add_argument('--modelo',action='store_true',help='peça para Modelos do CRM: identidade do disparo pendente');x=a.parse_args(argv)
    try:
        ids=[int(v) for v in x.list_ids.split(',')] if x.list_ids else None
        if (x.campaign_id is None)!=(ids is None) or x.campaign_id is not None and (x.campaign_id<=0 or not ids or min(ids)<=0):raise ValueError('campaign-id e list-ids devem ser fornecidos juntos, com IDs positivos.')
        result=audit(Path(x.html).read_text(),template=Path(x.template).read_text() if x.template else None,text=Path(x.text).read_text() if x.text else None,brand=x.brand,campaign=x.campaign,campaign_id=x.campaign_id,list_ids=ids,prohibited=x.proibidos.split(','),modelo=x.modelo)
        if x.json:print(json.dumps(result,ensure_ascii=False,indent=2))
        else:
            print('APROVADO LOCALMENTE' if result['ok'] else 'REPROVADO')
            print('SHA256 HTML:',result['checks']['html_sha256'])
            for kind in ('errors','warnings'):
                for item in result[kind]:print(('ERRO' if kind=='errors' else 'REVISAR')+' '+item['code']+': '+item['message'])
        return 0 if result['ok'] else 1
    except (OSError,ValueError) as e:
        print(json.dumps({'ok':False,'error':type(e).__name__,'message':str(e)},ensure_ascii=False));return 2

if __name__=='__main__':sys.exit(main())
