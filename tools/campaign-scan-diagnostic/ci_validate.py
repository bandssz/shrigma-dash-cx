#!/usr/bin/env python3
"""Validate the sealed scanner diagnostic on pinned sources; never run Listmonk."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
BASE_REVISION = "a908beed2860fb90a1b3891f85e64cbc8040ab22"
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
DELTA_PINS = {
    "tools/listmonk-regular-build/worker_patch.py": "ca2220feba597bde4929190969d14f65da409811f6c10f7147310919366bc0b8",
    "tools/listmonk-regular-build/upstream.lock.json": "55bf90d2e0cb3e8a8a57ea51d1d6d39645f1e75a2b477edb67a9fac9656cccee",
    "tools/listmonk-regular-build/overlay/listmonk/cmd/campaign_scan_diagnostic_test.go": "b7f8df4f254a3b626502c4e7a2fdea029d6c9785b19627d5394de24cde280c18",
}
GO_MOD_SHA = "c3c0ba9b03709c32ba81b716e758150580ddcb64930403dc4dc07fb49c57b982"
GO_SUM_SHA = "a1c63b917fa644a526e117c51a8ab8da38899e4b8123ce30152a25b836f25700"
HELPER_SHA = "235c8c6e037f687155432de74a93bb67206dff676ff591460c6307ad40c5486b"
TEST_RELATIVE = "tools/listmonk-regular-build/overlay/listmonk/cmd/campaign_scan_diagnostic_test.go"
EXPECTED_TESTS = [
    "TestCampaignScanDiagnosticKeepsPhaseAndSQLState",
    "TestCampaignScanDiagnosticRejectsInvalidSQLState",
    "TestCampaignScanDiagnosticExcludesDriverPayload",
    "TestCampaignScanDiagnosticDoesNotExposeInvalidWrappedState",
]
PINNED_DRIVER_TEST = "TestCampaignScanDiagnosticPinnedPostgresDriver"
# Test-only zero-value declaration, matching cmd/main.go. No DB is opened.
# Both store files are copied byte for byte. None of their DB methods is called.
REAL_STORE_HARNESS = '''package main

import (
    "errors"
    "fmt"
    "testing"

    "github.com/jmoiron/sqlx"
    "github.com/lib/pq"
)

var db *sqlx.DB

func TestCampaignScanDiagnosticPinnedPostgresDriver(t *testing.T) {
    if db != nil {
        t.Fatal("CI harness must leave database unopened")
    }
    cause := fmt.Errorf("synthetic wrapper: %w", &pq.Error{
        Code: "55000",
        Message: "synthetic connection information",
        Detail: "synthetic statement information",
    })
    got := campaignScanDiagnostic("select", cause)
    if got.Error() != "campaign scan unavailable [phase=select sqlstate=55000]" {
        t.Fatalf("unexpected pinned driver diagnostic: %q", got)
    }
    if errors.Unwrap(got) != nil {
        t.Fatal("raw driver error must not escape through the returned error chain")
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


def pins(baseline, proposal, require_git=False):
    if require_git:
        result = subprocess.run(["git", "-C", str(baseline), "rev-parse", "HEAD"],
                                capture_output=True, text=True, check=True, timeout=15)
        require(result.stdout.strip() == BASE_REVISION, "Baseline checkout revision drift")
        ancestry = subprocess.run(["git", "-C", str(proposal), "merge-base", "--is-ancestor",
                                   BASE_REVISION, "HEAD"], capture_output=True, timeout=15)
        require(ancestry.returncode == 0, "Proposal must descend from the exact installed revision")
        changes = subprocess.run(["git", "-C", str(proposal), "diff", "--name-only", BASE_REVISION, "HEAD"],
                                 capture_output=True, text=True, check=True, timeout=15)
        expected_paths = set(DELTA_PINS) | {".github/workflows/campaign-scan-diagnostic.yml",
                                          "tools/campaign-scan-diagnostic/ci_validate.py"}
        require(set(changes.stdout.splitlines()) == expected_paths,
                "Isolated branch must contain only the five diagnostic and CI paths")
    return {"baseline_revision": BASE_REVISION,
            "baseline": checked_pins(baseline, BASE_PINS),
            "proposal": checked_pins(proposal, DELTA_PINS)}


def generator_proof(baseline, proposal, upstream_path):
    relative = Path("tools/listmonk-regular-build")
    old_lock = json.loads(read(baseline / relative / "upstream.lock.json"))
    new_lock = json.loads(read(proposal / relative / "upstream.lock.json"))
    stock = read(upstream_path).decode()
    require(sha(stock.encode()) == old_lock["worker"]["original"]["cmd/manager_store.go"],
            "Pinned original manager_store drift")
    old_generator = module("scan_baseline_generator", baseline / relative / "worker_patch.py")
    new_generator = module("scan_candidate_generator", proposal / relative / "worker_patch.py")
    old = old_generator.patch_manager_store(stock)
    new = new_generator.patch_manager_store(stock)
    require(sha(old.encode()) == old_lock["worker"]["patched"]["cmd/manager_store.go"],
            "Baseline generator output drift")
    require(sha(new.encode()) == new_lock["worker"]["patched"]["cmd/manager_store.go"],
            "Candidate generator output drift")
    marker = "// campaignScanDiagnostic exposes only a fixed phase and a bounded SQLSTATE."
    require(new.count(marker) == 1, "Expected one generated diagnostic helper")
    start = new.index(marker)
    end = new.index("\n\n// NextSubscribers", start)
    helper = new[start:end].rstrip("\n")
    helper_file = ('package main\n\nimport "errors"\n\n' + helper + "\n").encode()
    require(sha(helper_file) == HELPER_SHA, "Sealed helper drift")
    require(new.count('campaignScanDiagnostic("begin", err)') == 1 and
            new.count('campaignScanDiagnostic("select", err)') == 1,
            "Expected precisely the two diagnostic call sites")
    restored = new.replace('campaignScanDiagnostic("begin", err)', 'errors.New("campaign scan unavailable")')
    restored = restored.replace('campaignScanDiagnostic("select", err)', 'errors.New("campaign scan unavailable")')
    restored = restored.replace("\n\n" + helper + "\n", "", 1)
    require(restored == old, "Non-diagnostic generated source change")
    test = read(proposal / TEST_RELATIVE)
    require(sha(test) == new_lock["worker"]["overlay"]["cmd/campaign_scan_diagnostic_test.go"],
            "New integrated test drift")
    # Only the manager_store output hash and the additive test hash may change.
    restored_lock = json.loads(json.dumps(new_lock))
    restored_lock["worker"]["patched"]["cmd/manager_store.go"] = old_lock["worker"]["patched"]["cmd/manager_store.go"]
    del restored_lock["worker"]["overlay"]["cmd/campaign_scan_diagnostic_test.go"]
    require(restored_lock == old_lock, "Non-diagnostic lock change")
    proof = {
        "upstream_manager_store_sha256": sha(stock.encode()),
        "baseline_generated_manager_store_sha256": sha(old.encode()),
        "candidate_generated_manager_store_sha256": sha(new.encode()),
        "standalone_helper_sha256": sha(helper_file),
        "new_test_sha256": sha(test),
        "regular_query_sha256": old_lock["worker"]["regular_query_sha256"],
        "removing_only_diagnostic_delta_reproduces_baseline_bytes": True,
        "all_other_lock_entries_equal": True,
    }
    return proof, helper_file, test


def prepare(args):
    baseline, proposal, out = args.baseline_root.resolve(), args.proposal_root.resolve(), args.out.resolve()
    receipt = pins(baseline, proposal, True)
    require(not out.exists(), "Use a new preparation directory")
    out.mkdir(parents=True)
    # Every unchanged recipe/query composer comes from the exact installed revision.
    recipe = out / "recipe"
    for relative in ("tools/listmonk-regular-build", "tools/listmonk-regular-package", "n8n/growth"):
        shutil.copytree(baseline / relative, recipe / relative,
                        ignore=shutil.ignore_patterns("__pycache__"))
    for relative in DELTA_PINS:
        target = recipe / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(read(proposal / relative))
    builder = module("scan_source_preparer", recipe / "tools/listmonk-regular-package/build.py")
    listmonk, smtp = out / "source/listmonk", out / "source/smtppool"
    builder.extract_source(args.inputs / "listmonk-upstream.tar.gz", listmonk)
    builder.extract_smtp(args.inputs / "smtppool.zip", smtp)
    require(sha(read(listmonk / "go.mod")) == GO_MOD_SHA and
            sha(read(listmonk / "go.sum")) == GO_SUM_SHA, "Pinned module manifests drift")
    require("github.com/knadh/smtppool/v2 v2.0.2 " + builder.SMTP_SUM in
            read(listmonk / "go.sum").decode(), "Pinned SMTP dependency sum drift")
    proof, helper, test = generator_proof(baseline, proposal, listmonk / "cmd/manager_store.go")
    smtp_builder = module("scan_smtp_preparer", recipe / "tools/listmonk-regular-build/build.py")
    worker_builder = module("scan_worker_preparer", recipe / "tools/listmonk-regular-build/worker_patch.py")
    smtp_receipt = smtp_builder.apply(listmonk, smtp)
    worker_receipt = worker_builder.apply(listmonk, recipe)
    lock = json.loads(read(recipe / "tools/listmonk-regular-build/upstream.lock.json"))
    require(sha(read(listmonk / "queries/campaigns.sql")) == proof["regular_query_sha256"],
            "Unchanged regular query drift")
    for relative in ("cmd/manager_store.go", "cmd/manager_store_regular.go",
                     "cmd/campaign_scan_diagnostic_test.go"):
        expected = lock["worker"]["patched"].get(relative) or lock["worker"]["overlay"][relative]
        require(sha(read(listmonk / relative)) == expected, "Integrated store source drift")
    (out / "source/go.work").write_text("go 1.26.1\n\nuse (\n ./listmonk\n ./smtppool\n)\n")
    unit = out / "unit"
    unit.mkdir()
    (unit / "go.mod").write_text("module campaign_scan_diagnostic\n\ngo 1.26.1\n")
    (unit / "campaign_scan_diagnostic.go").write_bytes(helper)
    (unit / "campaign_scan_diagnostic_test.go").write_bytes(test)
    # Keep original cmd/main.go.init() out of the executable test harness.
    # Full ./cmd compilation is checked separately without executing its binary.
    real = listmonk / "scan-diagnostic-ci"
    real.mkdir()
    for name in ("manager_store.go", "manager_store_regular.go", "campaign_scan_diagnostic_test.go"):
        (real / name).write_bytes(read(listmonk / "cmd" / name))
        require(read(real / name) == read(listmonk / "cmd" / name), "Harness source copy drift")
    (real / "ci_globals_test.go").write_text(REAL_STORE_HARNESS)
    receipt.update(schema="campaign-scan-diagnostic-ci-preparation-v1", status="PREPARED_NOT_GO_EXECUTED",
                   generator=proof, smtp_overlay=smtp_receipt, worker_overlay=worker_receipt,
                   go_version="1.26.1", source_archive_sha256=builder.SOURCE_SHA,
                   smtp_zip_sha256=builder.SMTP_ZIP_SHA,
                   original_go_mod_sha256=GO_MOD_SHA, original_go_sum_sha256=GO_SUM_SHA,
                   harness_db="nil declaration only; no DB method called", cmd_init_executed=False,
                   runtime_activation=False, registry_push=False, production_changed=False)
    save_json(out / "preparation.json", receipt)
    print(json.dumps({"status": receipt["status"], "generator": proof}, sort_keys=True))


def verify_go_log(path, expected_tests):
    events = [json.loads(line) for line in read(path, 16 * 1024 * 1024).decode().splitlines() if line.strip()]
    packages = {event.get("Package") for event in events if event.get("Package")}
    require(len(packages) == 1, "Expected one test package per log")
    require(not any(event.get("Action") in ("fail", "skip") for event in events),
            "Failed or skipped diagnostic tests")
    passed = {event["Test"] for event in events
              if event.get("Action") == "pass" and event.get("Test") and "/" not in event["Test"]}
    require(passed == set(expected_tests), "Expected diagnostic test set did not execute exactly")
    require(any(event.get("Action") == "pass" and not event.get("Test") for event in events),
            "Missing successful package completion")
    return {"package": next(iter(packages)), "tests_passed": sorted(passed), "log_sha256": sha(read(path))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    for name in ("check-pins", "generator", "prepare"):
        command = commands.add_parser(name)
        command.add_argument("--baseline-root", type=Path, required=True)
        command.add_argument("--proposal-root", type=Path, required=True)
        if name == "prepare":
            command.add_argument("--inputs", type=Path, required=True)
            command.add_argument("--out", type=Path, required=True)
        else:
            command.add_argument("--report", type=Path, required=True)
        if name == "check-pins":
            command.add_argument("--require-git-pin", action="store_true")
        elif name == "generator":
            command.add_argument("--upstream-manager-store", type=Path, required=True)
    command = commands.add_parser("verify-tests")
    command.add_argument("--prepared", type=Path, required=True)
    command.add_argument("--unit-log", type=Path, required=True)
    command.add_argument("--real-store-log", type=Path, required=True)
    command.add_argument("--cmd-test-binary", type=Path, required=True)
    command.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if args.mode == "check-pins":
        save_json(args.report, pins(args.baseline_root, args.proposal_root, args.require_git_pin))
    elif args.mode == "generator":
        checked_pins(args.baseline_root, {"tools/listmonk-regular-build/" + name: BASE_PINS["tools/listmonk-regular-build/" + name]
                                         for name in ("worker_patch.py", "upstream.lock.json")})
        checked_pins(args.proposal_root, DELTA_PINS)
        proof, _, _ = generator_proof(args.baseline_root, args.proposal_root, args.upstream_manager_store)
        save_json(args.report, {"status": "GENERATOR_BYTES_VERIFIED_GO_NOT_EXECUTED", "generator": proof})
        print(json.dumps(proof, sort_keys=True))
    elif args.mode == "prepare":
        prepare(args)
    else:
        require(sha(read(args.prepared / "source/listmonk/go.mod")) == GO_MOD_SHA and
                sha(read(args.prepared / "source/listmonk/go.sum")) == GO_SUM_SHA,
                "Go tests must preserve pinned module manifests")
        prepared = json.loads(read(args.prepared / "preparation.json"))
        real = args.prepared / "source/listmonk/scan-diagnostic-ci"
        for name in ("manager_store.go", "manager_store_regular.go", "campaign_scan_diagnostic_test.go"):
            require(read(real / name) == read(args.prepared / "source/listmonk/cmd" / name),
                    "Tested real store bytes drifted")
        lock = json.loads(read(args.prepared / "recipe/tools/listmonk-regular-build/upstream.lock.json"))
        for relative in ("cmd/manager_store.go", "cmd/manager_store_regular.go", "cmd/campaign_scan_diagnostic_test.go"):
            expected = lock["worker"]["patched"].get(relative) or lock["worker"]["overlay"][relative]
            require(sha(read(args.prepared / "source/listmonk" / relative)) == expected,
                    "Tested integrated store hash drifted")
        require(sha(read(args.prepared / "unit/campaign_scan_diagnostic.go")) == HELPER_SHA and
                sha(read(args.prepared / "unit/campaign_scan_diagnostic_test.go")) == DELTA_PINS[TEST_RELATIVE],
                "Tested standalone helper or test drifted")
        require(sha(read(args.prepared / "source/listmonk/queries/campaigns.sql")) ==
                prepared["generator"]["regular_query_sha256"], "SQL changed during Go checks")
        report = {
            "schema": "campaign-scan-diagnostic-ci-go-result-v1", "status": "GO_VALIDATION_PASSED",
            "unit": verify_go_log(args.unit_log, EXPECTED_TESTS),
            "real_manager_store": verify_go_log(args.real_store_log, EXPECTED_TESTS + [PINNED_DRIVER_TEST]),
            "full_cmd_test_binary_sha256": sha(read(args.cmd_test_binary, 128 * 1024 * 1024)),
            "full_cmd_test_binary_executed": False, "cmd_init_executed": False,
            "module_manifests_unchanged": True, "store_harness_bytes_equal_real_cmd": True,
            "production_changed": False, "registry_push": False,
        }
        save_json(args.report, report)
        print(json.dumps(report, sort_keys=True))


if __name__ == "__main__":
    main()
