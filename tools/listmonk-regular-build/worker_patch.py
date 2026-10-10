#!/usr/bin/env python3
"""Patch the exact Listmonk worker source for guarded regular delivery."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


HERE = Path(__file__).resolve().parent
LOCK = json.loads((HERE / "upstream.lock.json").read_text(encoding="utf-8"))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(body):
    return hashlib.sha256(body).hexdigest()


def graph_runtime_sha(repo_root, transforms, overlays):
    """Hash the exact graph-cache sources that affect claim or /api/tx."""
    graph = LOCK["graph_cache"]
    values = []
    for relative in graph["runtime_sources"]["worker"]:
        if relative in transforms:
            body = transforms[relative][0]
        else:
            require(relative in overlays, f"graph runtime worker source missing: {relative}")
            body = overlays[relative][0]
        values.append(("listmonk/" + relative, body))
    for relative, expected in graph["runtime_sources"]["repo"].items():
        path = repo_root / relative
        require(path.is_file() and not path.is_symlink(), f"graph runtime repo source missing: {relative}")
        body = path.read_bytes()
        require(sha(body) == expected, f"graph runtime repo source drift: {relative}")
        values.append((relative, body))
    digest = hashlib.sha256(b"journey-graph-cache-runtime-v1\0")
    for relative, body in sorted(values):
        name = relative.encode("utf-8")
        digest.update(len(name).to_bytes(4, "big"))
        digest.update(name)
        digest.update(len(body).to_bytes(8, "big"))
        digest.update(body)
    return digest.hexdigest(), {relative: sha(body) for relative, body in sorted(values)}


def replace_once(source, old, new, label):
    require(source.count(old) == 1, f"worker patch anchor drift: {label}")
    return source.replace(old, new)


def patch_manager(source):
    source = replace_once(source,
        "\tnextPipes chan *pipe\n\tcampMsgQ  chan CampaignMessage\n\tmsgQ      chan models.Message\n",
        "\tnextPipes chan *pipe\n\tcampMsgQ  chan CampaignMessage\n\tmsgQ      chan models.Message\n\n\tregularLeaseMu            sync.RWMutex\n\tregularLeaseReady         bool\n\tregularLeaseDeadline      time.Time\n\tregularLeaseRuntimeSHA    string\n\tregularHeartbeatMu        sync.Mutex\n\tregularHeartbeatStarted   bool\n\tregularHeartbeatStartOnce sync.Once\n\tregularHeartbeatStopOnce  sync.Once\n\tregularHeartbeatStop      chan struct{}\n\tregularHeartbeatDone      chan struct{}\n\tcloseOnce                 sync.Once\n",
        "regular heartbeat manager state")
    source = replace_once(source,
        "\t\tmsgQ:         make(chan models.Message, cfg.Concurrency*cfg.MessageRate*2),\n\t\tslidingStart: time.Now(),\n",
        "\t\tmsgQ:                 make(chan models.Message, cfg.Concurrency*cfg.MessageRate*2),\n\t\tregularHeartbeatStop: make(chan struct{}),\n\t\tregularHeartbeatDone: make(chan struct{}),\n\t\tslidingStart:         time.Now(),\n",
        "regular heartbeat channels")
    source = replace_once(source,
        "func (m *Manager) Run() {\n\tif m.cfg.ScanCampaigns {\n",
        "func (m *Manager) Run() {\n\tif m.cfg.ScanCampaigns {\n\t\t// The first heartbeat and its COMMIT complete before the scanner starts.\n\t\tm.startRegularHeartbeat()\n",
        "heartbeat before scanner")
    source = replace_once(source,
        "func (m *Manager) Close() {\n\tclose(m.nextPipes)\n\tclose(m.msgQ)\n}",
        "func (m *Manager) Close() {\n\tm.stopRegularHeartbeat()\n\tm.closeOnce.Do(func() {\n\t\tclose(m.nextPipes)\n\t\tclose(m.msgQ)\n\t})\n}",
        "heartbeat close lifecycle")
    source = replace_once(source,
        "func (m *Manager) PushCampaignMessage(msg CampaignMessage) error {\n\tt := time.NewTicker(pushTimeout)\n",
        "func (m *Manager) PushCampaignMessage(msg CampaignMessage) error {\n\tgate, err := m.regularDeliveryGate(msg.Campaign.ID)\n\tif err != nil {\n\t\treturn errors.New(\"regular delivery gate unavailable\")\n\t}\n\tif gate.Bound {\n\t\treturn errors.New(\"bound campaign requires guarded pipeline\")\n\t}\n\tt := time.NewTicker(pushTimeout)\n",
        "public campaign push gate")
    source = replace_once(source,
        "\tpipe *pipe\n}",
        "\tpipe        *pipe\n\tregularDone chan struct{}\n}",
        "guarded completion channel")
    source = replace_once(source,
        "\t\tcounts = append(counts, p.sent.Load())\n\t\tp.sent.Store(0)\n",
        "\t\tcounts = append(counts, p.sent.Swap(0))\n",
        "legacy atomic scan counter drain")
    start = source.index("\t\tcase msg, ok := <-m.campMsgQ:")
    end = source.index("\n\t\t// Arbitrary message.", start)
    replacement = """\t\tcase msg, ok := <-m.campMsgQ:
\t\t\tif !ok {
\t\t\t\treturn
\t\t\t}
\t\t\tm.processQueuedCampaignMessage(msg, &numMsg)
"""
    return source[:start] + replacement + source[end:]


def patch_cmd_init(source):
    return replace_once(source,
        '\tf.Bool("passive", false, "run in passive mode where campaigns are not processed")\n',
        '\tf.Bool("passive", false, "run in passive mode where campaigns are not processed")\n\tf.Bool("crm-regular-identity", false, "print guarded regular-delivery executable/runtime hashes and exit")\n',
        "identity CLI flag")


def patch_cmd_main(source):
    source = replace_once(source,
        'import (\n\t"context"\n',
        'import (\n\t"context"\n\t"encoding/json"\n',
        "identity JSON import")
    source = replace_once(source,
        '\tinitFlags(ko)\n\n\t// Display version.\n',
        '\tinitFlags(ko)\n\tif ko.Bool("crm-regular-identity") {\n\t\tlo.SetOutput(io.Discard)\n\t}\n\n\t// Display version.\n',
        "identity log suppression")
    anchor = 'func main() {\n'
    identity = '''func main() {
\tif ko.Bool("crm-regular-identity") {
\t\tfail := func(msgrs []manager.Messenger) {
\t\t\tfor _, messenger := range msgrs {
\t\t\t\t_ = messenger.Close()
\t\t\t}
\t\t\t_ = db.Close()
\t\t\tfmt.Fprintln(os.Stderr, "regular delivery identity unavailable")
\t\t\tos.Exit(1)
\t\t}
\n\t\tnSMTP := 0
\t\tfor _, item := range ko.Slices("smtp") {
\t\t\tif item.Bool("enabled") {
\t\t\t\tnSMTP++
\t\t\t}
\t\t}
\t\tif nSMTP != 1 {
\t\t\tfail(nil)
\t\t}
\n\t\turlCfg := initUrlConfig(ko)
\t\ti18n := initI18n(ko.MustString("app.lang"), fs)
\t\tmsgrs := initSMTPMessengers()
\t\tmgr := initCampaignManager(msgrs, queries, urlCfg, nil, nil, i18n, ko)
\t\tworkerSHA, runtimeSHA, err := mgr.RegularDeliveryIdentity("email")
\t\tif err != nil {
\t\t\tfail(msgrs)
\t\t}
\t\tbody, err := json.Marshal(struct {
\t\t\tWorkerSHA256  string `json:"worker_sha256"`
\t\t\tRuntimeSHA256 string `json:"runtime_sha256"`
\t\t}{workerSHA, runtimeSHA})
\t\tif err != nil {
\t\t\tfail(msgrs)
\t\t}
\t\tfmt.Println(string(body))
\t\tfor _, messenger := range msgrs {
\t\t\t_ = messenger.Close()
\t\t}
\t\t_ = db.Close()
\t\treturn
\t}

'''
    return replace_once(source, anchor, identity, "identity before runtime")


def patch_manager_store(source):
    source = replace_once(source,
        'import (\n',
        'import (\n\t"encoding/json"\n\n',
        "campaign scan boundary imports")
    old = '''func (s *store) NextCampaigns(currentIDs []int64, sentCounts []int64) ([]*models.Campaign, error) {
\tvar out []*models.Campaign
\terr := s.queries.NextCampaigns.Select(&out, pq.Int64Array(currentIDs), pq.Int64Array(sentCounts))
\treturn out, err
}'''
    new = '''func (s *store) NextCampaigns(currentIDs []int64, sentCounts []int64) ([]*models.Campaign, error) {
\tctx, cancel, options := regularDeliveryTx()
\tdefer cancel()
\ttx, err := db.BeginTxx(ctx, options)
\tif err != nil {
\t\treturn nil, campaignScanError(campaignScanBegin, err)
\t}
\tdefer tx.Rollback()
\tif err := setCampaignScanBoundary(ctx, tx); err != nil {
\t\treturn nil, err
\t}
\tvar quarantine []byte
\tif err := tx.GetContext(ctx, &quarantine,
\t\t`SELECT crm_audience_v2.regular_delivery_quarantine($1::bigint[]::integer[])`,
\t\tpq.Int64Array(currentIDs)); err != nil || !json.Valid(quarantine) {
\t\treturn nil, campaignScanError(campaignScanQuarantine, err)
\t}
\tvar out []*models.Campaign
\tif err := tx.Stmtx(s.queries.NextCampaigns).Unsafe().SelectContext(ctx, &out,
\t\tpq.Int64Array(currentIDs), pq.Int64Array(sentCounts)); err != nil {
\t\treturn nil, campaignScanError(campaignScanSelect, err)
\t}
\tif err := tx.Commit(); err != nil {
\t\treturn nil, campaignScanError(campaignScanCommit, err)
\t}
\treturn out, nil
}'''
    return replace_once(source, old, new, "transactional campaign quarantine")


def patch_batch_manager_store(source):
    """Opt-in candidate only. Both query executions share their transaction's JIT setting."""
    source = patch_manager_store(source)
    source = replace_once(source,
        "\tif err := setCampaignScanBoundary(ctx, tx); err != nil {\n\t\treturn nil, err\n\t}\n",
        "\tif err := setCampaignScanBoundary(ctx, tx); err != nil {\n\t\treturn nil, err\n\t}\n\tif err := setBatchLocalJITOff(ctx, tx); err != nil {\n\t\treturn nil, campaignScanError(campaignScanBoundary, err)\n\t}\n",
        "explicit batch scanner local JIT")
    old = "\tvar out []models.Subscriber\n\terr := s.queries.NextCampaignSubscribers.Select(&out, camps[0].CampaignID, camps[0].CampaignType, camps[0].LastSubscriberID, camps[0].MaxSubscriberID, pq.Array(listIDs), limit)\n\treturn out, err"
    new = """\tctx, cancel, options := regularDeliveryTx()
\tdefer cancel()
\ttx, err := db.BeginTxx(ctx, options)
\tif err != nil {
\t\treturn nil, err
\t}
\tdefer tx.Rollback()
\tif err := setRegularDeliveryBoundary(ctx, tx); err != nil {
\t\treturn nil, err
\t}
\tif err := setBatchLocalJITOff(ctx, tx); err != nil {
\t\treturn nil, err
\t}
\tvar out []models.Subscriber
\tif err := tx.Stmtx(s.queries.NextCampaignSubscribers).Unsafe().SelectContext(ctx, &out,
\t\tcamps[0].CampaignID, camps[0].CampaignType, camps[0].LastSubscriberID, camps[0].MaxSubscriberID, pq.Array(listIDs), limit); err != nil {
\t\treturn nil, err
\t}
\tif err := tx.Commit(); err != nil {
\t\treturn nil, err
\t}
\treturn out, nil"""
    return replace_once(source, old, new, "explicit batch recipient transaction local JIT")


def patch_pipe(source):
    source = replace_once(source,
        'import (\n\t"fmt"\n',
        'import (\n\t"errors"\n\t"fmt"\n',
        "pipe errors import")
    source = replace_once(source,
        '''\tcamp       *models.Campaign
\trate       *ratecounter.RateCounter
\twg         *sync.WaitGroup
\tsent       atomic.Int64
\tlastID     atomic.Uint64
\terrors     atomic.Uint64
\tstopped    atomic.Bool
\twithErrors atomic.Bool''',
        '''\tcamp                *models.Campaign
\trate                *ratecounter.RateCounter
\twg                  *sync.WaitGroup
\tsent                atomic.Int64
\tlastID              atomic.Uint64
\terrors              atomic.Uint64
\tstopped             atomic.Bool
\twithErrors          atomic.Bool
\tbound               atomic.Bool
\tboundFinalizeFailed atomic.Bool''',
        "pipe state")
    source = replace_once(source,
        '''\t// Load the template.
\tif err := c.CompileTemplate(m.TemplateFuncs(c)); err != nil {
\t\treturn nil, err
\t}

\t// Load any media/attachments.
\tif err := m.attachMedia(c); err != nil {
\t\treturn nil, err
\t}''',
        '''\tgate, err := m.regularDeliveryGate(c.ID)
\tif err != nil || (gate.Bound && !gate.Ready) {
\t\treturn nil, errors.New("regular delivery gate unavailable")
\t}

\t// Load the template. Bound campaigns additionally reject functions whose
\t// output depends on wall clock, randomness, external state or mutable links.
\tif err := c.CompileTemplate(m.TemplateFuncs(c)); err != nil {
\t\tif gate.Bound {
\t\t\t_ = m.store.UpdateCampaignStatus(c.ID, models.CampaignStatusPaused)
\t\t}
\t\treturn nil, err
\t}
\tif gate.Bound {
\t\tif err := m.validateRegularCampaign(c); err != nil {
\t\t\t_ = m.store.UpdateCampaignStatus(c.ID, models.CampaignStatusPaused)
\t\t\treturn nil, err
\t\t}
\t}

\t// Load any media/attachments. Bound campaigns have already rejected media
\t// because its bytes can live outside the immutable database material.
\tif err := m.attachMedia(c); err != nil {
\t\treturn nil, err
\t}''',
        "bound render policy")
    source = replace_once(source,
        "func (p *pipe) NextSubscribers() (bool, error) {\n\t// Fetch the next batch of subscribers from a 'running' campaign.\n",
        "func (p *pipe) NextSubscribers() (bool, error) {\n\t// A missing/erroring gate must never become a legacy zero value.\n\tp.bound.Store(true)\n\tgate, err := p.m.regularDeliveryGate(p.camp.ID)\n\tif err != nil {\n\t\tp.Stop(true)\n\t\treturn false, errors.New(\"regular delivery gate unavailable\")\n\t}\n\tp.bound.Store(gate.Bound)\n\tif gate.Bound && !gate.Ready {\n\t\tp.Stop(true)\n\t\treturn false, errors.New(\"regular delivery requires reconciliation\")\n\t}\n\tif p.stopped.Load() {\n\t\treturn false, nil\n\t}\n\tlimit := p.m.cfg.BatchSize\n\tif gate.Bound {\n\t\tlimit = 1\n\t}\n\n\t// Fetch the next batch of subscribers in a given campaign.\n",
        "gate before selection")
    source = replace_once(source,
        "subs, err := p.m.store.NextSubscribers(p.camp.ID, p.m.cfg.BatchSize)",
        "subs, err := p.m.store.NextSubscribers(p.camp.ID, limit)",
        "bound batch size")
    source = replace_once(source,
        '''\tif err != nil {
\t\treturn false, fmt.Errorf("error fetching campaign subscribers (%s): %v", p.camp.Name, err)
\t}''',
        '''\tif err != nil {
\t\tif gate.Bound {
\t\t\tp.Stop(true)
\t\t}
\t\treturn false, fmt.Errorf("error fetching campaign subscribers (%s): %v", p.camp.Name, err)
\t}''',
        "bound selection error stops pipe")
    source = replace_once(source,
        "\tif len(subs) == 0 {\n\t\treturn false, nil\n\t}\n",
        "\tif len(subs) == 0 {\n\t\tif gate.Bound {\n\t\t\tstore, storeErr := p.m.regularStore()\n\t\t\tif storeErr != nil || store.FinalizeRegularDelivery(p.camp.ID) != nil {\n\t\t\t\tp.boundFinalizeFailed.Store(true)\n\t\t\t\tp.Stop(true)\n\t\t\t\treturn false, nil\n\t\t\t}\n\t\t\tp.Stop(false)\n\t\t}\n\t\treturn false, nil\n\t}\n",
        "bound empty finalization")
    source = replace_once(source,
        "\t\tmsg, err := p.newMessage(s)\n\t\tif err != nil {\n\t\t\tp.m.log.Printf(\"error rendering message (%s) (%s): %v\", p.camp.Name, s.Email, err)\n\t\t\tcontinue\n\t\t}\n\n\t\t// Push the message to the queue while blocking and waiting until\n\t\t// the queue is drained.\n\t\tp.m.campMsgQ <- msg\n",
        "\t\tmsg, err := p.newMessage(s)\n\t\tif err != nil {\n\t\t\tif gate.Bound {\n\t\t\t\tp.m.log.Printf(\"error rendering guarded campaign %d subscriber %d\", p.camp.ID, s.ID)\n\t\t\t\tp.Stop(true)\n\t\t\t\treturn false, nil\n\t\t\t}\n\t\t\tp.m.log.Printf(\"error rendering message (%s) (%s): %v\", p.camp.Name, s.Email, err)\n\t\t\tcontinue\n\t\t}\n\n\t\tif gate.Bound {\n\t\t\tmsg.regularDone = make(chan struct{})\n\t\t\tp.m.campMsgQ <- msg\n\t\t\t<-msg.regularDone\n\t\t\tif p.stopped.Load() {\n\t\t\t\treturn false, nil\n\t\t\t}\n\t\t} else {\n\t\t\t// Push the message to the queue while blocking and waiting until\n\t\t\t// the queue is drained.\n\t\t\tp.m.campMsgQ <- msg\n\t\t}\n",
        "bound synchronous send")
    cleanup_anchor = "func (p *pipe) cleanup() {\n\tdefer func() {"
    cleanup_replacement = "func (p *pipe) cleanup() {\n\tdefer func() {"
    source = replace_once(source, cleanup_anchor, cleanup_replacement, "cleanup anchor")
    insertion = """
\tif p.bound.Load() {
\t\tif p.boundFinalizeFailed.Load() {
\t\t\tp.m.log.Printf("guarded campaign %d finalization remains unconfirmed", p.camp.ID)
\t\t\treturn
\t\t}
\t\tif p.withErrors.Load() {
\t\t\tif err := p.m.store.UpdateCampaignStatus(p.camp.ID, models.CampaignStatusPaused); err != nil {
\t\t\t\tp.m.log.Printf("guarded campaign %d pause remains unconfirmed", p.camp.ID)
\t\t\t}
\t\t}
\t\treturn
\t}
"""
    marker = "\n\t// Update campaign's 'sent count.\n"
    source = replace_once(source, marker, insertion + marker, "bound cleanup")
    source = replace_once(source,
        "int(p.sent.Load())",
        "int(p.sent.Swap(0))",
        "legacy atomic cleanup counter drain")
    return source


def patch_subscriber(source):
    return replace_once(source,
        '\tLists   types.JSONText `db:"lists" json:"lists"`\n',
        '\tLists            types.JSONText `db:"lists" json:"lists"`\n\tDeliverySnapshot types.JSONText `db:"crm_delivery_snapshot" json:"-"`\n',
        "subscriber delivery snapshot")


def regular_query(repo_root, original_path, batch_profile=None):
    script = r"""
const fs=require('fs');
const P=require(process.argv[1]);
const source=fs.readFileSync(process.argv[2],'utf8');
const patched=process.argv[3]?P.patchFullBatchWorkerSource(source,fs.readFileSync(process.argv[3],'utf8'),process.argv[4]):P.patchRegularWorkerSource(source);
process.stderr.write(patched.patched_sha256+'\n');
process.stdout.write(patched.source);
"""
    composer = batch_profile['sourcePins']['composer']['path'] if batch_profile else str(repo_root / "n8n/growth/segment-listmonk-selection.cjs")
    arguments = ["node", "-e", script, composer, str(original_path)]
    if batch_profile:
        arguments += [batch_profile['sourcePins']['kernel']['path'], batch_profile['kernelSha256']]
    result = subprocess.run(arguments,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30)
    reported = result.stderr.decode().strip()
    require(reported == (batch_profile["querySha256"] if batch_profile else LOCK["worker"]["regular_query_sha256"]), "regular worker query composer drift")
    source = result.stdout.decode()
    return source


def atomic_write(path, body, allowed):
    current = path.read_bytes() if path.exists() else None
    if current == body:
        return "unchanged"
    require(current is None or current in allowed, f"worker output conflict: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".regular-worker-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return "created" if current is None else "transformed"


def build_plan(listmonk_root, repo_root, batch_profile=None):
    transforms = {}
    funcs = {
        "internal/manager/manager.go": patch_manager,
        "internal/manager/pipe.go": patch_pipe,
        "models/subscribers.go": patch_subscriber,
        "cmd/init.go": patch_cmd_init,
        "cmd/main.go": patch_cmd_main,
        "cmd/manager_store.go": patch_manager_store,
    }
    for relative, func in funcs.items():
        path = listmonk_root / relative
        current = path.read_bytes()
        original_hash = LOCK["worker"]["original"][relative]
        patched_hash = (batch_profile["sourcePins"]["managerStoreCandidate"]["sha256"]
                        if batch_profile and relative == "cmd/manager_store.go"
                        else LOCK["worker"]["patched"][relative])
        if batch_profile and relative == "cmd/manager_store.go":
            func = patch_batch_manager_store
        if sha(current) == original_hash:
            patched = func(current.decode()).encode()
        elif sha(current) == patched_hash:
            patched = current
        else:
            raise ValueError(f"worker source drift: {relative}")
        require(sha(patched) == patched_hash, f"worker transform drift: {relative}")
        transforms[relative] = (patched, current)

    expected_query = batch_profile["querySha256"] if batch_profile else LOCK["worker"]["patched"]["queries/campaigns.sql"]
    relative = "queries/campaigns.sql"
    path = listmonk_root / relative
    current = path.read_bytes()
    if sha(current) == LOCK["worker"]["original"][relative]:
        patched = regular_query(repo_root, path, batch_profile).encode()
    elif sha(current) == expected_query:
        patched = current
    else:
        raise ValueError("worker source drift: queries/campaigns.sql")
    require(sha(patched) == expected_query, "worker query final drift")
    transforms[relative] = (patched, current)

    overlays = {}
    for relative, expected in LOCK["worker"]["overlay"].items():
        source = HERE / "overlay/listmonk" / relative
        body = source.read_bytes()
        require(sha(body) == expected, f"worker overlay drift: {relative}")
        target = listmonk_root / relative
        current = target.read_bytes() if target.exists() else None
        require(current is None or current == body, f"worker output conflict: {relative}")
        overlays[relative] = (body, current)

    if batch_profile:
        for slot, relative in (("jitHelper", "cmd/manager_store_batch_jit.go"),
                               ("jitTest", "cmd/manager_store_batch_jit_test.go")):
            pin = batch_profile["sourcePins"][slot]
            source = Path(pin["path"])
            require(source.is_file() and not source.is_symlink(), "Batch JIT source required")
            body = source.read_bytes()
            require(sha(body) == pin["sha256"], "Batch JIT source drift")
            target = listmonk_root / relative
            current = target.read_bytes() if target.exists() else None
            require(current is None or current == body, "Batch JIT output conflict")
            overlays[relative] = (body, current)

    # Compose the optional graph cache into the same exact regular worker. The
    # three existing files are accepted only from the regular/upstream hashes
    # pinned above; the remaining files must not exist in upstream.
    graph_root = HERE / "overlay/graph-cache"
    for relative, pins in LOCK["graph_cache"]["transforms"].items():
        source = graph_root / relative
        body = source.read_bytes()
        require(sha(body) == pins["sha256"], f"graph cache transform drift: {relative}")
        current = transforms[relative][0] if relative in transforms else (listmonk_root / relative).read_bytes()
        require(sha(current) == pins["base_sha256"], f"graph cache base drift: {relative}")
        original = transforms[relative][1] if relative in transforms else current
        transforms[relative] = (body, original)
    for relative, expected in LOCK["graph_cache"]["overlay"].items():
        source = graph_root / relative
        body = source.read_bytes()
        require(sha(body) == expected, f"graph cache overlay drift: {relative}")
        target = listmonk_root / relative
        current = target.read_bytes() if target.exists() else None
        require(current is None or current == body, f"graph cache output conflict: {relative}")
        overlays[relative] = (body, current)
    runtime_sha, runtime_sources = graph_runtime_sha(repo_root, transforms, overlays)
    require(runtime_sha == LOCK["graph_cache"]["runtime_sha256"], "graph cache runtime identity drift")
    return transforms, overlays, runtime_sha, runtime_sources


def load_batch_profile(manifest, digest):
    require(bool(manifest) == bool(digest), "Batch source profile pair required")
    if not manifest:
        return None
    require(len(digest) == 64 and all(c in "0123456789abcdef" for c in digest), "Batch profile SHA required")
    result = subprocess.run(["node", str(HERE / "native_batch_profile.cjs"), "--source-only", str(manifest), digest],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True, timeout=30)
    require(len(result.stdout) < 262144, "Batch profile metadata limit")
    profile = json.loads(result.stdout)
    require(profile["kind"] == "ephemeral-batch-count-recipient", "Full batch source profile required")
    return profile


def apply(listmonk_root, repo_root, batch_manifest=None, batch_manifest_sha256=None):
    listmonk_root = listmonk_root.resolve(strict=True)
    repo_root = repo_root.resolve(strict=True)
    batch_profile = load_batch_profile(batch_manifest, batch_manifest_sha256)
    transforms, overlays, runtime_sha, runtime_sources = build_plan(listmonk_root, repo_root, batch_profile)
    result = {}
    for relative, (body, original) in {**transforms, **overlays}.items():
        result[relative] = {"status": atomic_write(listmonk_root / relative, body, {original}), "sha256": sha(body)}
    return {
        "schema": "listmonk-regular-worker-overlay-v2",
        "status": "CANDIDATE_LOCAL_ONLY_NOT_DEPLOYED",
        "graph_cache_enabled_by_default": False,
        "graph_cache_runtime_sha256": runtime_sha,
        "graph_cache_runtime_sources": runtime_sources,
        "files": result,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listmonk-root", required=True, type=Path)
    parser.add_argument("--repo-root", default=HERE.parent.parent, type=Path)
    parser.add_argument("--batch-profile", type=Path)
    parser.add_argument("--batch-profile-sha256")
    args = parser.parse_args()
    print(json.dumps(apply(args.listmonk_root, args.repo_root, args.batch_profile, args.batch_profile_sha256), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
