#!/usr/bin/env python3
"""Validate ONLY the new snapshot/auth delta on pinned sources; never run Listmonk."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
BASE_REVISION = "a908beed2860fb90a1b3891f85e64cbc8040ab22"
APPROVED_REVISION = "72457f2851b59b76b57a5dc5da421c6774f06b67"
BASE_PINS = {
    ".github/workflows/crm-regular-worker-tests.yml": "2493f75bdeff320ea806bf19a3c3f0ce93b2c03bcd712795d77f78cb28602e03",
    "tools/listmonk-regular-package/build.py": "0cb3fac9bca102016fd3f57fa3f691b6b09d7e351e3f4af52b2a88e9a4dc4c68",
    "tools/listmonk-regular-package/bootstrap.py": "73e4d2020bd200c95b66f1e89f80e3ea3f19fb19e9766104a1a4246a1e1d92dd",
    "tools/listmonk-regular-build/build.py": "6a6b718be5ae3c28dbe354d3ed9975b33c42873958b267fa96be0805b53b8e02",
    "tools/listmonk-regular-build/worker_patch.py": "5c66983a7b909b34fc8cd15beb2d2f35da17573d713bada830bd66d62202e117",
    "tools/listmonk-regular-build/upstream.lock.json": "54c02aeeafd35d3d87c395b7eebac7ba104b6eda64f870e24eadfea4800dbea8",
    "tools/listmonk-ab-build/build.py": "d01eef16aaeb5a35de3b9e653d195e28632a1280368b3ef790fdc9f7bd97cb20",
    "tools/listmonk-ab-build/upstream.lock.json": "0a9ac24af323a04b08b4590a8ca9d039655ace77a9532256efd4b640dbec6d9a",
}
APPROVED_PINS = {
    "tools/listmonk-regular-build/worker_patch.py": "ca2220feba597bde4929190969d14f65da409811f6c10f7147310919366bc0b8",
    "tools/listmonk-regular-build/upstream.lock.json": "55bf90d2e0cb3e8a8a57ea51d1d6d39645f1e75a2b477edb67a9fac9656cccee",
    "tools/listmonk-regular-build/overlay/listmonk/cmd/campaign_scan_diagnostic_test.go": "b7f8df4f254a3b626502c4e7a2fdea029d6c9785b19627d5394de24cde280c18",
    ".github/workflows/campaign-scan-diagnostic.yml": "8da55176d0fe189273bc4b15fb6f3d8d83fc0baaa43028dcad6c0bb03675f50b",
    "tools/campaign-scan-diagnostic/ci_validate.py": "1a41301c58f732ee15eb5df89fb1ff2a275a39e8aa70c0890e90daf1bc9ad6aa",
}
DELTA_PINS = {
    "tools/listmonk-regular-build/worker_patch.py": "d4088409d31ca1efc46834a653f55b99a4ee8ee701b6e3edc130ff8cd06ec9ed",
    "tools/listmonk-regular-build/upstream.lock.json": "be92b523d39468818306d2da1fb756ef573842b26a54b16d7463f96507429318",
    "tools/listmonk-regular-build/overlay/listmonk/cmd/campaign_scan_snapshot.go": "f3daeff29a25dd38e6005df0e5eb09efbb7f3bbace8fb269507b2329532f3238",
    "tools/listmonk-regular-build/overlay/listmonk/cmd/campaign_scan_snapshot_http.go": "a3d5aaef275f88ffd17e1e655cdbbad8a0c959b24d947a8158e426352071822f",
    "tests/listmonk-campaign-scan-snapshot/campaign_scan_snapshot_test.go": "9a2e53dac70e5652dbbe4fb5c26b219deb34cde6d87bfd0a6540352175d886c3",
}
GO_MOD_SHA = "c3c0ba9b03709c32ba81b716e758150580ddcb64930403dc4dc07fb49c57b982"
GO_SUM_SHA = "a1c63b917fa644a526e117c51a8ab8da38899e4b8123ce30152a25b836f25700"
APPROVED_STORE_SHA = "bfcf483044a64d6e6f50f2f655859f5cf88f86e579e8fdea4a03dd6771761184"
HELPER_SHA = "235c8c6e037f687155432de74a93bb67206dff676ff591460c6307ad40c5486b"
TEST_RELATIVE = "tests/listmonk-campaign-scan-snapshot/campaign_scan_snapshot_test.go"
EXPECTED_TESTS = [
    "TestCampaignScanSnapshotEmptyAndNoReadMutation",
    "TestCampaignScanSnapshotWrappedDriverAndClosedJSON",
    "TestCampaignScanSnapshotFiniteStateVocabulary",
    "TestCampaignScanSnapshotRejectInvalidRecords",
    "TestCampaignScanSnapshotConcurrentCopies",
    "TestCampaignScanSnapshotOriginalTokenAuthAndPermission",
    "TestCampaignScanSnapshotRepeatedNativeReadDoesNotCapture",
    "TestCampaignScanSnapshotPinnedDriverInRealStoreHarness",
]
REAL_STORE_HARNESS = '''package main

import (
    "encoding/json"
    "strings"
    "testing"
    "time"

    "github.com/jmoiron/sqlx"
    "github.com/lib/pq"
)

// Match the original main.go declaration without its init() or a connection.
var db *sqlx.DB

func TestCampaignScanSnapshotPinnedDriverInRealStoreHarness(t *testing.T) {
    if db != nil {
        t.Fatal("snapshot CI must leave the real-store database unopened")
    }
    var snapshot campaignScanSnapshotStore
    cause := snapshotWrappedFailure{&pq.Error{
        Code: "57014", Message: "synthetic private connection payload",
        Detail: "synthetic statement and customer payload",
    }}
    snapshot.recordAt(campaignScanSelect, cause, time.Date(2026, 10, 8, 14, 0, 0, 0, time.UTC))
    got := snapshot.read()
    if got == nil || got.Phase != campaignScanSelect || got.SQLState != "57014" {
        t.Fatalf("unexpected pinned driver snapshot: %#v", got)
    }
    body, err := json.Marshal(got)
    if err != nil || strings.Contains(string(body), "synthetic") {
        t.Fatal("driver payload escaped typed snapshot")
    }
    if db != nil {
        t.Fatal("snapshot READ opened a database")
    }
}
'''

def require(condition, message):
    if not condition:
        raise ValueError(message)

def sha(body):
    return hashlib.sha256(body).hexdigest()

def read(path, maximum=64 * 1024 * 1024):
    require(path.is_file() and not path.is_symlink(), "Regular input required")
    require(path.stat().st_size <= maximum, "Input size limit")
    return path.read_bytes()

def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")

def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

def checked_pins(root, expected):
    actual = {relative: sha(read(root / relative)) for relative in expected}
    require(actual == expected, "Pinned source drift")
    return actual

def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True,
                          text=True, check=True, timeout=15).stdout.strip()

def pins(baseline, approved, proposal, require_git=False):
    if require_git:
        require(git(baseline, "rev-parse", "HEAD") == BASE_REVISION, "Baseline revision drift")
        require(git(approved, "rev-parse", "HEAD") == APPROVED_REVISION, "Approved revision drift")
        require(git(proposal, "rev-parse", "HEAD^") == APPROVED_REVISION,
                "This isolated proposal must have the approved revision as its exact parent")
        changes = set(git(proposal, "diff", "--name-only", APPROVED_REVISION, "HEAD").splitlines())
        expected = set(DELTA_PINS) | {".github/workflows/campaign-scan-diagnostic.yml",
                                     "tools/campaign-scan-diagnostic/ci_validate.py"}
        require(changes == expected, "Only the seven new proposal paths are admitted")
    return {"baseline_revision": BASE_REVISION, "approved_revision": APPROVED_REVISION,
            "baseline": checked_pins(baseline, BASE_PINS),
            "approved": checked_pins(approved, APPROVED_PINS),
            "proposal": checked_pins(proposal, DELTA_PINS)}

def new_generator_proof(proposal, stock_store, stock_handlers):
    lock = json.loads(read(proposal / "tools/listmonk-regular-build/upstream.lock.json"))
    generator = module("snapshot_source_generator", proposal / "tools/listmonk-regular-build/worker_patch.py")
    require(sha(stock_store) == lock["worker"]["original"]["cmd/manager_store.go"], "Stock store drift")
    require(sha(stock_handlers) == lock["worker"]["original"]["cmd/handlers.go"], "Stock handlers drift")
    new = generator.patch_manager_store(stock_store.decode())
    require(sha(new.encode()) == lock["worker"]["patched"]["cmd/manager_store.go"], "New store drift")
    restored = new.replace("\t\tcampaignScanLastFailure.record(campaignScanBegin, err)\n", "", 1)
    restored = restored.replace("\t\tcampaignScanLastFailure.record(campaignScanSelect, err)\n", "", 1)
    require(sha(restored.encode()) == APPROVED_STORE_SHA, "New store exceeds the two error captures")
    marker = "// campaignScanDiagnostic exposes only a fixed phase and a bounded SQLSTATE."
    start = new.index(marker)
    end = new.index("\n\n// NextSubscribers", start)
    helper = new[start:end].rstrip("\n")
    require(sha(('package main\n\nimport "errors"\n\n' + helper + "\n").encode()) == HELPER_SHA,
            "Approved helper changed")
    handlers = generator.patch_cmd_handlers(stock_handlers.decode())
    require(sha(handlers.encode()) == lock["worker"]["patched"]["cmd/handlers.go"], "New routes drift")
    restored_handlers = handlers.replace("\tregisterCampaignScanDiagnostic(e, a.auth)\n", "", 1)
    require(restored_handlers.encode() == stock_handlers, "New handler source exceeds route registration")
    return {"new_store_sha256": sha(new.encode()), "approved_store_sha256": APPROVED_STORE_SHA,
            "only_two_error_records_added": True, "approved_helper_unchanged": True,
            "only_route_registration_added_to_handlers": True,
            "regular_query_sha256": lock["worker"]["regular_query_sha256"]}

def prepare(args):
    baseline, approved, proposal = args.baseline_root.resolve(), args.approved_root.resolve(), args.proposal_root.resolve()
    out = args.out.resolve()
    receipt = pins(baseline, approved, proposal, True)
    require(not out.exists(), "Use a new preparation directory")
    out.mkdir(parents=True)
    recipe = out / "recipe"
    for relative in ("tools/listmonk-regular-build", "tools/listmonk-regular-package", "n8n/growth"):
        shutil.copytree(baseline / relative, recipe / relative, ignore=shutil.ignore_patterns("__pycache__"))
    # Preserve the approved diagnostic test file, without rerunning its cases.
    retained = "tools/listmonk-regular-build/overlay/listmonk/cmd/campaign_scan_diagnostic_test.go"
    target = recipe / retained
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(read(approved / retained))
    for relative in DELTA_PINS:
        target = recipe / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(read(proposal / relative))
    builder = module("snapshot_source_preparer", recipe / "tools/listmonk-regular-package/build.py")
    listmonk, smtp = out / "source/listmonk", out / "source/smtppool"
    builder.extract_source(args.inputs / "listmonk-upstream.tar.gz", listmonk)
    builder.extract_smtp(args.inputs / "smtppool.zip", smtp)
    require(sha(read(listmonk / "go.mod")) == GO_MOD_SHA and sha(read(listmonk / "go.sum")) == GO_SUM_SHA,
            "Module manifests drift")
    proof = new_generator_proof(proposal, read(listmonk / "cmd/manager_store.go"), read(listmonk / "cmd/handlers.go"))
    smtp_builder = module("snapshot_smtp_preparer", recipe / "tools/listmonk-regular-build/build.py")
    worker_builder = module("snapshot_worker_preparer", recipe / "tools/listmonk-regular-build/worker_patch.py")
    smtp_receipt = smtp_builder.apply(listmonk, smtp)
    worker_receipt = worker_builder.apply(listmonk, recipe)
    lock = json.loads(read(recipe / "tools/listmonk-regular-build/upstream.lock.json"))
    require(sha(read(listmonk / "queries/campaigns.sql")) == proof["regular_query_sha256"], "Regular query drift")
    (out / "source/go.work").write_text("go 1.26.1\n\nuse (\n ./listmonk\n ./smtppool\n)\n")
    real = listmonk / "scan-snapshot-ci"
    real.mkdir()
    copied = {}
    for name in ("manager_store.go", "manager_store_regular.go",
                 "campaign_scan_snapshot.go", "campaign_scan_snapshot_http.go"):
        source = read(listmonk / "cmd" / name)
        expected = lock["worker"]["patched"].get("cmd/"+name) or lock["worker"]["overlay"]["cmd/"+name]
        require(sha(source) == expected, "Integrated source drift: "+name)
        (real / name).write_bytes(source)
        require(read(real / name) == source, "Harness copy drift")
        copied[name] = sha(source)
    test = read(proposal / TEST_RELATIVE)
    (real / "campaign_scan_snapshot_test.go").write_bytes(test)
    (real / "ci_globals_test.go").write_text(REAL_STORE_HARNESS)
    receipt.update(schema="campaign-scan-snapshot-ci-preparation-v1", status="PREPARED_NOT_GO_EXECUTED",
                   generator=proof, smtp_overlay=smtp_receipt, worker_overlay=worker_receipt,
                   copied_real_sources=copied, expected_new_tests=EXPECTED_TESTS,
                   go_version="1.26.1", source_archive_sha256=builder.SOURCE_SHA,
                   smtp_zip_sha256=builder.SMTP_ZIP_SHA,
                   original_go_mod_sha256=GO_MOD_SHA, original_go_sum_sha256=GO_SUM_SHA,
                   harness_globals_sha256=sha(REAL_STORE_HARNESS.encode()),
                   auth="original cached API middleware; synthetic cache only; auth.New never called",
                   harness_db="nil declaration only; no DB/store/scanner method called",
                   cmd_init_executed=False, old_test_cases_repeated=False,
                   runtime_activation=False, registry_push=False, production_changed=False)
    save_json(out / "preparation.json", receipt)
    print(json.dumps({"status": receipt["status"], "generator": proof}, sort_keys=True))

def verify_tests(args):
    preparation = json.loads(read(args.prepared / "preparation.json"))
    events = [json.loads(line) for line in read(args.new_log, 16*1024*1024).decode().splitlines() if line.strip()]
    packages = {e["Package"] for e in events if e.get("Package")}
    require(packages == {"github.com/knadh/listmonk/scan-snapshot-ci"}, "Unexpected test package")
    require(not any(e.get("Action") in ("fail", "skip") for e in events), "New tests failed or skipped")
    passed = {e["Test"] for e in events if e.get("Action") == "pass" and e.get("Test") and "/" not in e["Test"]}
    require(passed == set(EXPECTED_TESTS), "Expected new cases did not execute exactly")
    require(any(e.get("Action") == "pass" and not e.get("Test") for e in events), "No package pass")
    save_json(args.report, {
        "schema": "campaign-scan-snapshot-ci-go-result-v1", "status": "GO_VALIDATION_PASSED",
        "new_tests_passed": sorted(passed), "new_log_sha256": sha(read(args.new_log)),
        "compiled_cmd_test_binary_sha256": sha(read(args.cmd_test_binary)),
        "copied_real_sources": preparation["copied_real_sources"],
        "original_auth_middleware_tested_with_synthetic_cache": True,
        "cmd_init_executed": False, "cmd_test_binary_executed": False,
        "old_test_cases_repeated": False, "real_database_used": False,
        "production_changed": False, "runtime_activation": False, "registry_push": False,
    })

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    for name in ("check-pins", "prepare"):
        cmd = sub.add_parser(name)
        for key in ("baseline-root", "approved-root", "proposal-root"):
            cmd.add_argument("--"+key, type=Path, required=True)
        if name == "prepare":
            cmd.add_argument("--inputs", type=Path, required=True)
            cmd.add_argument("--out", type=Path, required=True)
        else:
            cmd.add_argument("--report", type=Path, required=True)
    cmd = sub.add_parser("verify-tests")
    for key in ("prepared", "new-log", "cmd-test-binary", "report"):
        cmd.add_argument("--"+key, type=Path, required=True)
    args = parser.parse_args()
    if args.mode == "check-pins":
        save_json(args.report, pins(args.baseline_root, args.approved_root, args.proposal_root, True))
    elif args.mode == "prepare":
        prepare(args)
    else:
        verify_tests(args)

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("snapshot validation refused: "+str(exc), file=sys.stderr)
        raise SystemExit(1)
