import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('worker_patch_graph_cache', HERE / 'worker_patch.py')
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class GraphCacheBuildTest(unittest.TestCase):
    def inputs(self, repo):
        graph = worker.LOCK['graph_cache']
        transforms, overlays = {}, {}
        source = HERE / 'overlay/graph-cache'
        for relative in graph['transforms']:
            transforms[relative] = ((source / relative).read_bytes(), b'base')
        for relative in graph['overlay']:
            overlays[relative] = ((source / relative).read_bytes(), None)
        for relative in graph['runtime_sources']['repo']:
            target = repo / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((HERE.parent.parent / relative).read_bytes())
        return transforms, overlays

    def test_runtime_identity_is_exact_and_every_input_is_covered(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            transforms, overlays = self.inputs(repo)
            digest, sources = worker.graph_runtime_sha(repo, transforms, overlays)
            graph = worker.LOCK['graph_cache']
            self.assertEqual(digest, graph['runtime_sha256'])
            expected = {'listmonk/' + x for x in graph['runtime_sources']['worker']} | set(graph['runtime_sources']['repo'])
            self.assertEqual(set(sources), expected)
            self.assertFalse(graph['enabled_by_default'])

            first = graph['runtime_sources']['worker'][0]
            group = transforms if first in transforms else overlays
            original = group[first]
            group[first] = (original[0] + b'\n', original[1])
            changed, _ = worker.graph_runtime_sha(repo, transforms, overlays)
            self.assertNotEqual(changed, digest)

    def test_repo_source_drift_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            transforms, overlays = self.inputs(repo)
            relative = next(iter(worker.LOCK['graph_cache']['runtime_sources']['repo']))
            (repo / relative).write_bytes(b'drift')
            with self.assertRaisesRegex(ValueError, 'repo source drift'):
                worker.graph_runtime_sha(repo, transforms, overlays)

    def test_overlay_and_transform_bytes_match_lock(self):
        graph = worker.LOCK['graph_cache']
        root = HERE / 'overlay/graph-cache'
        for relative, pins in graph['transforms'].items():
            self.assertEqual(worker.sha((root / relative).read_bytes()), pins['sha256'])
        for relative, expected in graph['overlay'].items():
            self.assertEqual(worker.sha((root / relative).read_bytes()), expected)


if __name__ == '__main__':
    unittest.main()
