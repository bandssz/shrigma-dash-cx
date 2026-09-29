#!/usr/bin/env python3
"""Apply the additive guarded-send candidate to exact, local upstream trees."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile


HERE = Path(__file__).resolve().parent
LOCK = json.loads((HERE / "upstream.lock.json").read_text(encoding="utf-8"))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(body):
    return hashlib.sha256(body).hexdigest()


def patch_pool(body):
    old_struct = b"type conn struct {\n\tconn *smtp.Client\n\n\t// lastActivity"
    new_struct = b"type conn struct {\n\tconn    *smtp.Client\n\tnetConn net.Conn\n\n\t// lastActivity"
    old_return = b"return &conn{\n\t\tconn: sm,\n\t}, nil"
    new_return = b"return &conn{\n\t\tconn:    sm,\n\t\tnetConn: netCon,\n\t}, nil"
    require(body.count(old_struct) == 1, "smtppool conn struct patch point drift")
    require(body.count(old_return) == 1, "smtppool newConn patch point drift")
    return body.replace(old_struct, new_struct).replace(old_return, new_return)


def regular_file(root, relative):
    path = root / relative
    require(path.is_file() and not path.is_symlink(), f"expected regular file: {relative}")
    return path


def verify_tree(root, files, label):
    require(root.is_dir() and not root.is_symlink(), f"expected {label} source directory")
    actual = {}
    for relative, expected in files.items():
        body = regular_file(root, relative).read_bytes()
        digest = sha256(body)
        require(digest == expected, f"{label} upstream drift: {relative}")
        actual[relative] = digest
    return actual


def overlays(section):
    result = []
    for destination, expected in LOCK["overlay"][section].items():
        source = HERE / "overlay" / ("email" if section == "listmonk" else "smtppool")
        relative = Path(destination)
        if section == "listmonk":
            relative = relative.relative_to("internal/messenger/email")
        source = source / relative
        body = regular_file(HERE, source.relative_to(HERE)).read_bytes()
        require(sha256(body) == expected, f"overlay drift: {section}/{destination}")
        result.append((destination, body, expected))
    return result


def safe_parent(root, destination):
    parent = (root / destination).parent
    current = root
    for part in parent.relative_to(root).parts:
        current = current / part
        if current.exists():
            require(current.is_dir() and not current.is_symlink(), f"unsafe output parent: {current}")
        else:
            current.mkdir()
    return parent


def atomic_write(root, destination, body, allowed_existing=None):
    target = root / destination
    parent = safe_parent(root, destination)
    transformed = False
    if target.exists():
        require(target.is_file() and not target.is_symlink(), f"unsafe output target: {destination}")
        current = target.read_bytes()
        if current == body:
            return "unchanged"
        require(allowed_existing is not None and current == allowed_existing,
                f"refusing to overwrite differing file: {destination}")
        transformed = True
    fd, temporary = tempfile.mkstemp(prefix=".guarded-", dir=parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return "transformed" if transformed else "created"


def apply(listmonk_root, smtppool_root):
    listmonk_root = listmonk_root.resolve(strict=True)
    smtppool_root = smtppool_root.resolve(strict=True)

    smtppool_files = dict(LOCK["smtppool"]["files"])
    expected_pool_hash = smtppool_files.pop("pool.go")
    verified = {
        "listmonk": verify_tree(listmonk_root, LOCK["listmonk"]["files"], "listmonk"),
        "smtppool": verify_tree(smtppool_root, smtppool_files, "smtppool"),
    }
    pool_path = regular_file(smtppool_root, "pool.go")
    pool_current = pool_path.read_bytes()
    pool_current_hash = sha256(pool_current)
    if pool_current_hash == expected_pool_hash:
        pool_original = pool_current
        pool_patched = patch_pool(pool_original)
        pool_state = "official"
    elif pool_current_hash == LOCK["transforms"]["smtppool/pool.go"]:
        pool_original = None
        pool_patched = pool_current
        pool_state = "patched"
    else:
        raise ValueError("smtppool upstream drift: pool.go")
    require(sha256(pool_patched) == LOCK["transforms"]["smtppool/pool.go"], "smtppool pool.go transform drift")
    verified["smtppool"]["pool.go"] = expected_pool_hash
    planned = {
        "listmonk": overlays("listmonk"),
        "smtppool": [("pool.go", pool_patched, sha256(pool_patched))] + overlays("smtppool"),
    }

    # Complete the read-only drift/conflict preflight before creating anything.
    for section, root in (("listmonk", listmonk_root), ("smtppool", smtppool_root)):
        for destination, body, _ in planned[section]:
            target = root / destination
            if target.exists():
                require(target.is_file() and not target.is_symlink(), f"unsafe output target: {destination}")
                current = target.read_bytes()
                allowed_pool = section == "smtppool" and destination == "pool.go" and pool_original is not None and current == pool_original
                require(current == body or allowed_pool, f"refusing to overwrite differing file: {destination}")

    written = {}
    for section, root in (("listmonk", listmonk_root), ("smtppool", smtppool_root)):
        written[section] = {}
        for destination, body, digest in planned[section]:
            allowed = pool_original if section == "smtppool" and destination == "pool.go" else None
            written[section][destination] = {
                "status": atomic_write(root, destination, body, allowed),
                "sha256": digest,
            }
    return {
        "schema": LOCK["schema"],
        "status": "CANDIDATE_LOCAL_ONLY_NOT_DEPLOYED",
        "upstream_verified": verified,
        "smtppool_pool_input": pool_state,
        "overlay": written,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listmonk-root", required=True, type=Path)
    parser.add_argument("--smtppool-root", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(apply(args.listmonk_root, args.smtppool_root), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
