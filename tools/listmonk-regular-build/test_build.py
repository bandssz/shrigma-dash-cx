import importlib.util
import copy
from pathlib import Path
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("regular_guarded_build", HERE / "build.py")
build = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build)


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.original_lock = build.LOCK
        build.LOCK = copy.deepcopy(build.LOCK)

    def tearDown(self):
        build.LOCK = self.original_lock

    def fixture(self, root, section):
        for relative in build.LOCK[section]["files"]:
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if section == "smtppool" and relative == "pool.go":
                body = (b"type conn struct {\n\tconn *smtp.Client\n\n\t// lastActivity\n}\n"
                        b"return &conn{\n\t\tconn: sm,\n\t}, nil\n")
            else:
                body = (section + ":" + relative).encode("utf-8")
            target.write_bytes(body)
            build.LOCK[section]["files"][relative] = build.sha256(body)
        if section == "smtppool":
            original = (root / "pool.go").read_bytes()
            build.LOCK["transforms"]["smtppool/pool.go"] = build.sha256(build.patch_pool(original))

    def test_exact_inputs_apply_idempotently_and_drift_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            listmonk = base / "listmonk"
            smtppool = base / "smtppool"
            listmonk.mkdir()
            smtppool.mkdir()
            self.fixture(listmonk, "listmonk")
            self.fixture(smtppool, "smtppool")

            first = build.apply(listmonk, smtppool)
            self.assertEqual(first["status"], "CANDIDATE_LOCAL_ONLY_NOT_DEPLOYED")
            self.assertEqual(first["overlay"]["smtppool"]["pool.go"]["status"], "transformed")
            self.assertTrue(all(item["status"] == "created" for section, group in first["overlay"].items()
                                for name, item in group.items()
                                if not (section == "smtppool" and name == "pool.go")))
            second = build.apply(listmonk, smtppool)
            self.assertTrue(all(item["status"] == "unchanged" for group in second["overlay"].values() for item in group.values()))

            (smtppool / "pool.go").write_text("drift", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "upstream drift"):
                build.apply(listmonk, smtppool)

    def test_overlay_conflict_is_rejected_before_other_outputs_are_created(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            listmonk = base / "listmonk"
            smtppool = base / "smtppool"
            listmonk.mkdir()
            smtppool.mkdir()
            self.fixture(listmonk, "listmonk")
            self.fixture(smtppool, "smtppool")
            conflict = smtppool / "guarded.go"
            conflict.write_text("existing", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "refusing to overwrite"):
                build.apply(listmonk, smtppool)
            self.assertFalse((listmonk / "internal/messenger/email/regular_guarded.go").exists())


if __name__ == "__main__":
    unittest.main()
