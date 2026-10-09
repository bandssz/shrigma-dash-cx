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


def patch_cmd_handlers(source):
    return replace_once(source,
        "func initHTTPHandlers(e *echo.Echo, a *App) {\n",
        "func initHTTPHandlers(e *echo.Echo, a *App) {\n\tregisterCampaignScanDiagnostic(e, a.auth)\n",
        "authenticated campaign scan snapshot route")


def patch_manager_store(source):
    source = replace_once(source,
        'import (\n',
        'import (\n\t"encoding/json"\n\t"errors"\n\n',
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
\t\tcampaignScanLastFailure.record(campaignScanBegin, err)
\t\treturn nil, campaignScanDiagnostic("begin", err)
\t}
\tdefer tx.Rollback()
\tif err := setRegularDeliveryBoundary(ctx, tx); err != nil {
\t\treturn nil, errors.New("campaign scan boundary unavailable")
\t}
\tvar quarantine []byte
\tif err := tx.GetContext(ctx, &quarantine,
\t\t`SELECT crm_audience_v2.regular_delivery_quarantine($1::bigint[]::integer[])`,
\t\tpq.Int64Array(currentIDs)); err != nil || !json.Valid(quarantine) {
\t\treturn nil, errors.New("campaign quarantine unavailable")
\t}
\tvar out []*models.Campaign
\tif err := tx.Stmtx(s.queries.NextCampaigns).Unsafe().SelectContext(ctx, &out,
\t\tpq.Int64Array(currentIDs), pq.Int64Array(sentCounts)); err != nil {
\t\tcampaignScanLastFailure.record(campaignScanSelect, err)
\t\treturn nil, campaignScanDiagnostic("select", err)
\t}
\tif err := tx.Commit(); err != nil {
\t\treturn nil, errors.New("campaign scan commit unconfirmed")
\t}
\treturn out, nil
}

// campaignScanDiagnostic exposes only a fixed phase and a bounded SQLSTATE.
// Driver messages, statements, identifiers, arguments and connection data are
// deliberately excluded from the error returned to the campaign scanner.
func campaignScanDiagnostic(phase string, cause error) error {
	switch phase {
	case "begin", "select":
	default:
		phase = "unknown"
	}
	state := "unknown"
	var driver interface{ SQLState() string }
	if errors.As(cause, &driver) {
		code := driver.SQLState()
		valid := len(code) == 5
		for _, char := range code {
			if !(char >= '0' && char <= '9' || char >= 'A' && char <= 'Z') {
				valid = false
				break
			}
		}
		if valid {
			state = code
		}
	}
	return errors.New("campaign scan unavailable [phase=" + phase + " sqlstate=" + state + "]")
}
'''
    return replace_once(source, old, new, "transactional campaign quarantine")


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
    return source


def patch_subscriber(source):
    return replace_once(source,
        '\tLists   types.JSONText `db:"lists" json:"lists"`\n',
        '\tLists            types.JSONText `db:"lists" json:"lists"`\n\tDeliverySnapshot types.JSONText `db:"crm_delivery_snapshot" json:"-"`\n',
        "subscriber delivery snapshot")


def regular_query(repo_root, original_path):
    script = r"""
const fs=require('fs');
const P=require(process.argv[1]);
const source=fs.readFileSync(process.argv[2],'utf8');
const patched=P.patchRegularWorkerSource(source);
process.stderr.write(patched.patched_sha256+'\n');
process.stdout.write(patched.source);
"""
    result = subprocess.run(["node", "-e", script,
        str(repo_root / "n8n/growth/segment-listmonk-selection.cjs"), str(original_path)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30)
    reported = result.stderr.decode().strip()
    require(reported == LOCK["worker"]["regular_query_sha256"], "regular worker query composer drift")
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


def build_plan(listmonk_root, repo_root):
    transforms = {}
    funcs = {
        "internal/manager/manager.go": patch_manager,
        "internal/manager/pipe.go": patch_pipe,
        "models/subscribers.go": patch_subscriber,
        "cmd/init.go": patch_cmd_init,
        "cmd/main.go": patch_cmd_main,
        "cmd/manager_store.go": patch_manager_store,
        "cmd/handlers.go": patch_cmd_handlers,
        "internal/auth/auth.go": lambda source: source,
        "internal/auth/models.go": lambda source: source,
    }
    for relative, func in funcs.items():
        path = listmonk_root / relative
        current = path.read_bytes()
        original_hash = LOCK["worker"]["original"][relative]
        patched_hash = LOCK["worker"]["patched"][relative]
        if sha(current) == original_hash:
            patched = func(current.decode()).encode()
        elif sha(current) == patched_hash:
            patched = current
        else:
            raise ValueError(f"worker source drift: {relative}")
        require(sha(patched) == patched_hash, f"worker transform drift: {relative}")
        transforms[relative] = (patched, current)

    relative = "queries/campaigns.sql"
    path = listmonk_root / relative
    current = path.read_bytes()
    if sha(current) == LOCK["worker"]["original"][relative]:
        patched = regular_query(repo_root, path).encode()
    elif sha(current) == LOCK["worker"]["patched"][relative]:
        patched = current
    else:
        raise ValueError("worker source drift: queries/campaigns.sql")
    require(sha(patched) == LOCK["worker"]["patched"][relative], "worker query final drift")
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
    return transforms, overlays


def apply(listmonk_root, repo_root):
    listmonk_root = listmonk_root.resolve(strict=True)
    repo_root = repo_root.resolve(strict=True)
    transforms, overlays = build_plan(listmonk_root, repo_root)
    result = {}
    for relative, (body, original) in {**transforms, **overlays}.items():
        result[relative] = {"status": atomic_write(listmonk_root / relative, body, {original}), "sha256": sha(body)}
    return {"schema": "listmonk-regular-worker-overlay-v1", "status": "CANDIDATE_LOCAL_ONLY_NOT_DEPLOYED", "files": result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listmonk-root", required=True, type=Path)
    parser.add_argument("--repo-root", default=HERE.parent.parent, type=Path)
    args = parser.parse_args()
    print(json.dumps(apply(args.listmonk_root, args.repo_root), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
