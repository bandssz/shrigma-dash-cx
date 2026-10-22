#!/usr/bin/env python3
"""Execute public source transforms, without importing builder/apply/runtime."""
import ast
import unittest
from pathlib import Path

HERE=Path(__file__).resolve().parent
FILES=HERE.parents[1]
WORKER=FILES/'tools/listmonk-regular-build/worker_patch.py'
class SourceTransformTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  tree=ast.parse(WORKER.read_bytes())
  cls.ns={}
  exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef)],type_ignores=[]),'pinned-source-functions','exec'),cls.ns)
 def test_actual_pipe_builder(self):
  source=(HERE/'fixtures/pipe.upstream.go').read_text()
  after=self.ns['patch_pipe'](source)
  self.assertIn('phase', (FILES/'tools/listmonk-regular-build/overlay/listmonk/internal/manager/regular_pause_diagnostic.go').read_text())
  self.assertEqual(after.count('finalizeErr = store.FinalizeRegularDelivery(p.camp.ID)'),1)
  self.assertIn('if finalizeErr == nil {',after)
  self.assertIn('regularPauseFinalizeUnavailable, finalizeErr)',after)
 def test_transform_refuses_drift(self):
  source=(HERE/'fixtures/pipe.upstream.go').read_text().replace('func (p *pipe) NextSubscribers()', 'func (p *pipe) ChangedSubscribers()')
  with self.assertRaises(ValueError):self.ns['patch_pipe'](source)
 def test_scanner_logs_only_after_commit(self):
  source=(HERE/'fixtures/manager-store.original.go').read_text()
  for transform in ('patch_manager_store','patch_batch_manager_store'):
   after=self.ns[transform](source)
   a=after.index('if err := tx.Commit(); err != nil {')
   b=after.index('logCommittedRegularQuarantine(quarantine)')
   self.assertLess(a,b)
   self.assertIn('return nil, campaignScanError(campaignScanCommit, err)',after[a:b])
   self.assertEqual(after.count('logCommittedRegularQuarantine(quarantine)'),1)
 def test_no_sql_change_from_logging(self):
  # Removing the sole post-commit call yields exact current public candidate
  # store bytes. This is a golden comparison, not reconstructed SQL semantics.
  after=self.ns['patch_batch_manager_store']((HERE/'fixtures/manager-store.original.go').read_text())
  before=(HERE/'fixtures/manager-store.batch.before.go').read_text()
  self.assertEqual(after.replace('\tlogCommittedRegularQuarantine(quarantine)\n',''),before)
 def test_existing_smtp_diagnostics_byte_equal(self):
  before=(HERE/'fixtures/regular_delivery.before.go').read_text()
  after=(FILES/'tools/listmonk-regular-build/overlay/listmonk/internal/manager/regular_delivery.go').read_text()
  marker='// regularGuardedDiagnosticLine contains only public campaign/dispatch identity'
  self.assertEqual(before[before.index(marker):],after[after.index(marker):])
if __name__=='__main__':unittest.main()
