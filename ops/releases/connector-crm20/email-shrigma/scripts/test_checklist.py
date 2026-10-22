"""Regression of observable preflight behavior; synthetic content only."""
import contextlib, io, unittest
from checklist import audit, main
BASE='https://oaristocrata.com/products/kit?variant=10&utm_source=listmonk&utm_medium=campanha&utm_campaign=teste&utm_content=abertura-cta1&utm_term=a--lm-987-l123'
def body(url=BASE):return '''<html><head><style>.body{color:black}@media(prefers-color-scheme:dark){.body{color:white}}[data-ogsc] .body,[data-ogsb] .body{color:white}</style></head><body class='body'><div style='display:none'>Preview</div><a href='{{ TrackLink "'''+url+'''" }}'>Kit</a><a href='{{ UnsubscribeURL }}'>Sair</a>{{ TrackView }}</body></html>'''
def check(h,**kw):return audit(h,text=BASE+'\n{{ UnsubscribeURL }}',template='{{ template "content" . }}',**{'brand':'aristo',**kw})
class Preflight(unittest.TestCase):
 def test_valid_single_quote_attributes_and_variant(self):self.assertTrue(check(body(),brand='aristo',campaign='teste',campaign_id=987,list_ids=[123])['ok'])
 def test_bad_source_and_missing_text_utm_fail(self):
  r=audit(body(BASE.replace('listmonk','email')),brand='aristo',text='https://oaristocrata.com/products/kit\n{{ UnsubscribeURL }}',template='{{ template "content" . }}')
  self.assertFalse(r['ok']);self.assertIn('UTM_SOURCE',{e['code'] for e in r['errors']});self.assertIn('UTM_MISSING_OR_DUPLICATE',{e['code'] for e in r['errors']})
 def test_duplicate_pixel_in_wrapper_fails(self):self.assertFalse(audit(body(),brand='aristo',text=BASE+' {{ UnsubscribeURL }}',template='{{ template "content" . }}{{ TrackView }}')['ok'])
 def test_decorative_empty_alt_allowed_informative_missing_rejected(self):
  self.assertTrue(check(body().replace('</body>',"<img role='presentation' alt='' src='https://example.org/decor.png'></body>"))['ok'])
  self.assertFalse(check(body().replace('</body>',"<img src='https://example.org/product.png'></body>"))['ok'])
 def test_vml_alias_same_destination_allowed(self):
  extra='<!--[if mso]><v:roundrect href=\'{{ TrackLink "'+BASE+'" }}\'>Kit</v:roundrect><![endif]-->'
  self.assertTrue(check(body().replace('</body>',extra+'</body>'))['ok'])
 def test_same_position_different_destinations_rejected(self):
  r=check(body().replace('</body>',"<a href='"+BASE.replace('/kit?','/other?')+"@TrackLink'>Other</a></body>"))
  self.assertIn('POSITION_COLLISION',{e['code'] for e in r['errors']})
 def test_real_id_mismatch_rejected(self):self.assertFalse(check(body(),campaign_id=999,list_ids=[123])['ok'])
 def test_coupon_target_is_checked(self):
  from urllib.parse import quote
  coupon='https://oaristocrata.com/discount/OFF?redirect='+quote(BASE.replace('https://oaristocrata.com',''),safe='')
  self.assertTrue(check(body(coupon))['ok'])
 def test_active_html_and_incomplete_build_rejected(self):
  r=check(body().replace('</body>',"<img src=x onerror='bad()'>__FALTA_1__</body>"));codes={e['code'] for e in r['errors']};self.assertIn('ACTIVE_HTML',codes);self.assertIn('PLACEHOLDERS',codes)
 def test_unknown_wrapper_is_not_asserted_verified(self):
  r=audit(body(),brand='aristo',text=BASE+' {{ UnsubscribeURL }}');self.assertIn('WRAPPER_NOT_CHECKED',{e['code'] for e in r['warnings']})
 def test_explicit_brand_is_required_by_api_and_cli(self):
  with self.assertRaises(TypeError):audit(body())
  for brand in (None,'','olivas'):
   with self.subTest(brand=brand),self.assertRaises(ValueError):audit(body(),brand=brand)
  with contextlib.redirect_stderr(io.StringIO()) as err,self.assertRaises(SystemExit) as caught:main(['not-read.html','--json'])
  self.assertEqual(caught.exception.code,2);self.assertIn('--brand',err.getvalue())
 def test_cross_brand_replication_rejects_origin_links_in_html_text_and_vml(self):
  for target,origin in [('aristo','fish'),('fish','aristo')]:
   domains={'aristo':'oaristocrata.com','fish':'fishermans.com.br'}
   target_url=BASE.replace('oaristocrata.com',domains[target]);origin_url=BASE.replace('oaristocrata.com',domains[origin])
   valid=audit(body(target_url),brand=target,text=target_url+'\n{{ UnsubscribeURL }}',template='{{ template "content" . }}')
   self.assertTrue(valid['ok'])
   cases=[(body(origin_url),target_url),(body(target_url),origin_url),(body(target_url).replace('</body>','<!--[if mso]><v:roundrect href=\'{{ TrackLink "'+origin_url.replace('abertura-cta1','origem-vml')+'" }}\'>Origem</v:roundrect><![endif]--></body>'),target_url)]
   for html,text in cases:
    with self.subTest(target=target,html_origin=domains[origin] in html,text_origin=domains[origin] in text):
     r=audit(html,brand=target,text=text+'\n{{ UnsubscribeURL }}',template='{{ template "content" . }}')
     self.assertFalse(r['ok']);self.assertIn('STORE_SCOPE',{e['code'] for e in r['errors']})
 def test_modelo_mode_accepts_pending_dispatch_identity(self):
  url=BASE.replace('&utm_term=a--lm-987-l123','')
  r=audit(body(url),brand='aristo',text=url+'\n{{ UnsubscribeURL }}',template='{{ template "content" . }}',modelo=True)
  self.assertTrue(r['ok']);self.assertIn('DISPATCH_PENDING',{w['code'] for w in r['warnings']})
  self.assertFalse(audit(body(url),brand='aristo',text=url+'\n{{ UnsubscribeURL }}',template='{{ template "content" . }}')['ok'])
 def test_modelo_mode_still_rejects_malformed_term(self):
  url=BASE.replace('a--lm-987-l123','inventado')
  self.assertIn('DISPATCH_ID',{e['code'] for e in audit(body(url),brand='aristo',text=url+'\n{{ UnsubscribeURL }}',template='{{ template "content" . }}',modelo=True)['errors']})
if __name__=='__main__':unittest.main()
