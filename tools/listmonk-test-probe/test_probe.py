import copy
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

import probe
import upstream


class ProbeGuards(unittest.TestCase):
    def env(self):
        return {'GITHUB_ACTIONS':'true','CI':'true','RUNNER_OS':'Linux','RUNNER_ARCH':'X64',
                'LISTMONK_TEST_PROBE_ISOLATED':'1','PROBE_EGRESS_RESTRICTED':'1','PROBE_UID':'999'}

    def test_runner_rejects_local_root_missing_firewall_and_external_configuration(self):
        with patch('probe.os.getuid', return_value=999):
            probe.require_ci(self.env())
            for key in self.env():
                env=self.env();env.pop(key)
                with self.assertRaises(ValueError): probe.require_ci(env)
            for key in ('PGHOST','PGPASSWORD','LISTMONK_DB_HOST'):
                with self.assertRaisesRegex(ValueError,'EXTERNAL_CONFIG'): probe.require_ci({**self.env(),key:'not-used'})
        with patch('probe.os.getuid', return_value=0):
            with self.assertRaises(ValueError): probe.require_ci(self.env())

    def test_urls_require_exact_loopback_origin_without_identity_or_redirect(self):
        origin='http://127.0.0.1:4321'
        self.assertEqual(probe.local_url(origin+'/link/test',origin),origin+'/link/test')
        for url in ('https://127.0.0.1:4321/','http://localhost:4321/','http://127.0.0.1:4322/',
                    'http://user@127.0.0.1:4321/','http://example.invalid/','http://127.0.0.1:4321/#x'):
            with self.assertRaises(ValueError): probe.local_url(url,origin)
        self.assertIsNone(probe.NoRedirect().redirect_request(None,None,307,'',{},'http://example.invalid/'))
        with self.assertRaisesRegex(ValueError,'PROBE_ROUTE_FORBIDDEN'):
            probe.request(origin,'/api/campaigns/1/status',{'status':'running'})

    def test_payload_single_synthetic_recipient_and_request_only_subject(self):
        p=probe.payload('known@example.invalid','known-json','http://127.0.0.1:4321',2)
        self.assertEqual(p['subscribers'],['known@example.invalid']);self.assertEqual(p['subject'],'[TESTE] known-json')
        self.assertEqual(p['template_id'],2);self.assertEqual(p['lists'],[1]);self.assertNotIn('send_at',p)
        for bad in ('known@real.example','known@example.invalid,other@example.invalid','user@EXAMPLE.INVALID'):
            with self.assertRaises(ValueError): probe.payload(bad,'case','http://127.0.0.1:4321')
        self.assertEqual(probe.literal("x'y"),"'x''y'")

    def test_mime_checks_actual_wrapping_and_personalized_render(self):
        message={'sender':'probe@example.invalid','recipients':['known@example.invalid'],'subject':'[TESTE] case',
                 'body':'WRAPPER-STORED REQUEST-BODY case · Synthetic known'}
        self.assertEqual(probe.mime_proof(message,'case','known@example.invalid','WRAPPER-STORED')['wrapper'],'WRAPPER-STORED')
        for field,value in [('body','WRAPPER-OVERRIDE REQUEST-BODY case'),('body','WRAPPER-STORED STORED-BODY'),
                            ('body','WRAPPER-STORED REQUEST-BODY case {{ .Subscriber.Name }}'),('subject','case'),
                            ('recipients',['known@example.invalid','extra@example.invalid'])]:
            with self.assertRaises(ValueError): probe.mime_proof({**message,field:value},'case','known@example.invalid','WRAPPER-STORED')

    def test_identity_unchanged_is_separate_from_measured_tracking_counters(self):
        before={'subscriber_count':3,'subscriber_hash':'a','subscription_hash':'b','campaign_count':1,
                'campaign':{'status':'draft','config_hash':'c','started_at':None,'sent':0},'views':0}
        after=copy.deepcopy(before);after['views']=1
        probe.unchanged(before,after)
        for mutate in (lambda a:a.update(subscriber_count=4),lambda a:a['campaign'].update(config_hash='different'),
                       lambda a:a['campaign'].update(status='running')):
            bad=copy.deepcopy(after);mutate(bad)
            with self.assertRaises(ValueError): probe.unchanged(before,bad)

    def test_smtp_settings_have_only_loopback_sink_and_no_notifications(self):
        sql=probe.settings(4322,'http://127.0.0.1:4321')
        self.assertIn('"host": "127.0.0.1"',sql);self.assertIn('"max_msg_retries": 0',sql)
        self.assertIn("value='[]'::jsonb WHERE key='app.notify_emails'",sql)
        self.assertNotIn('smtp.gmail',sql);self.assertNotIn('api_key',sql)
        self.assertIn('database="listmonk_test_probe"',probe.config(4321))
        self.assertNotIn('password=""',probe.config(4321))

    def test_fixture_never_schedules_and_contains_missing_vs_suppressed_controls(self):
        sql=(Path(__file__).parent/'fixture.sql').read_text()
        self.assertNotIn('absent@example.invalid',sql);self.assertNotIn('external@example.invalid',sql)
        self.assertIn("'blocklisted'",sql);self.assertIn("'unsubscribed'",sql);self.assertIn("'draft'",sql)
        self.assertNotIn("'scheduled'",sql);self.assertNotIn('crm_ab_',sql)

    def test_html_url_extraction_decodes_attributes_without_fetching(self):
        self.assertEqual(probe.Links('<a href="http://127.0.0.1:9/link/x?a=1&amp;b=2">x</a><img src="http://127.0.0.1:9/campaign/x">').urls,
                         ['http://127.0.0.1:9/link/x?a=1&b=2','http://127.0.0.1:9/campaign/x'])

    def test_official_pin_and_rejection_of_untrusted_archives(self):
        self.assertEqual(upstream.LOCK['release']['sha256'],'08f44f8f2c598cbef76c948dcb319df235296a07d49a49be3253d65c16d26ff0')
        self.assertEqual(upstream.LOCK['commit'],'1b5e8d38c778e869003486d3c38bc7a964661e91')
        with self.assertRaises(Exception): upstream.extract(b'not an archive')


if __name__ == '__main__': unittest.main()
