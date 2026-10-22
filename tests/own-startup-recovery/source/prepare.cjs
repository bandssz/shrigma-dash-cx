"use strict";
// Inert SOURCE preparation. No network, SQL client, admission factory or execution is exported.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const ASSETS = Object.freeze({
  "recovery.atomic.sql.in": "ba200613101d9cf86e398a082b218b129d903d97c908048e935433c8bb3156c2",
  "snapshot.private-read.sql": "8e832e93a53eef8d9f11fbd6680cca89a9e7c2bf155b01043c271bbd8cf5b674",
  "PUBLIC-FUNCTION-PINS.json": "f84844815cb3cd8812b0eb8b968d8716a559e5c008bf20de1018862c0721856f"
});
const QUERY_SHA256 = "772efe8e05331fb201ed24cb08bb97a4625a49811d96622c2148342ce54c6700";
const KERNEL_SHA256 = "7d9e4cd7fd4e3c6f9967386c5ca7b1410e755690fac3a77149d8d032d2c4e8b4";
const RUNTIME_SHA256 = "4cd321fbdfd9a163f7c5ea2e1ba71029140e00a468d421908de8d0211d1e42cb";
const NEW_WORKER_SHA256 = "4abc9b3bac58ede5a922479ba703486248ca5218a84e263a03af56a47e0860bb";
const IMAGE_SHA256 = "85acc4a8b455d9fa9f841cfb2c307fba1263651402ec569a213d8fb0d20544ad";
const PURPOSES = Object.freeze({
 "repair-identity": "crm.own-startup-template-recovery.identity",
 "resume-after-heartbeat": "crm.own-startup-template-recovery.resume",
 "restore-before-heartbeat": "crm.own-startup-template-recovery.restore"
});
const sha = v => crypto.createHash("sha256").update(v).digest("hex");
const hex = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const uuid = v => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)
 && v !== "00000000-0000-0000-0000-000000000000";
function refuse(code) { const e = new Error(code); e.code = code; throw e; }
function keys(v, names) {
 if (!v || typeof v !== "object" || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype
  || Object.keys(v).sort().join("|") !== [...names].sort().join("|")) refuse("OWN_RECOVERY_INPUT_REFUSED");
}
function deepFreeze(v) { if (v && typeof v === "object") { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; }
function load(name) {
 let b; try { b = fs.readFileSync(path.join(__dirname, name)); } catch { refuse("OWN_RECOVERY_SOURCE_DRIFT"); }
 if (sha(b) !== ASSETS[name]) refuse("OWN_RECOVERY_SOURCE_DRIFT");
 return b.toString("utf8");
}
function replaceOne(s, needle, replacement) {
 if (s.split(needle).length !== 2) refuse("OWN_RECOVERY_ANCHOR_REFUSED");
 // Always callback: replacement-string $&, $$ and $' must never transform JSON/source bytes.
 return s.replace(needle, () => replacement);
}
function literal(v) { return "'" + JSON.stringify(v).replaceAll("'", "''") + "'"; }
function prepare(input) {
 keys(input, ["stage", "operationId", "candidate", "privateReferences"]);
 if (!Object.hasOwn(PURPOSES, input.stage) || !uuid(input.operationId)) refuse("OWN_RECOVERY_STAGE_REFUSED");
 keys(input.candidate, ["oldWorkerSha256", "newWorkerSha256", "runtimeSha256", "querySha256", "kernelSha256", "imageSha256"]);
 const c = input.candidate;
 if (!Object.values(c).every(hex) || c.oldWorkerSha256 === c.newWorkerSha256
  || c.newWorkerSha256 !== NEW_WORKER_SHA256 || c.runtimeSha256 !== RUNTIME_SHA256
  || c.querySha256 !== QUERY_SHA256 || c.kernelSha256 !== KERNEL_SHA256 || c.imageSha256 !== IMAGE_SHA256)
  refuse("OWN_RECOVERY_CANDIDATE_REFUSED");
 keys(input.privateReferences, ["admission", "snapshot", "restore", "quiescence", "binding"]);
 const refs = {};
 for (const name of ["admission", "snapshot", "restore", "quiescence", "binding"]) {
  const r = input.privateReferences[name]; keys(r, ["reference", "sha256"]);
  if (!uuid(r.reference) || !hex(r.sha256)) refuse("OWN_RECOVERY_REFERENCE_REFUSED");
  refs[name] = {reference:r.reference, sha256:r.sha256};
 }
 const plan = {schema:"own-startup-template-recovery-plan-v2", operationId:input.operationId,
  stage:input.stage, admissionPurpose:PURPOSES[input.stage], candidate:{...c}, privateReferences:refs,
  ownedControls:[171,172,174], resumeCampaigns:[171,174], preservedLegacyCampaigns:[173],
  statementTimeoutMs:5000, lockTimeoutMs:500, executeOriginalAvailable:false};
 const snapshot = load("snapshot.private-read.sql").trim();
 if (!snapshot.endsWith(";")) refuse("OWN_RECOVERY_SNAPSHOT_SOURCE_REFUSED");
 const publicPins = JSON.parse(load("PUBLIC-FUNCTION-PINS.json"));
 let core = load("recovery.atomic.sql.in");
 core = replaceOne(core, "__PLAN_JSON_LITERAL__", literal(plan));
 core = replaceOne(core, "__PUBLIC_FUNCTION_PINS_LITERAL__", literal(publicPins));
 if (core.split("__SNAPSHOT_SELECT__").length !== 3) refuse("OWN_RECOVERY_ANCHOR_REFUSED");
 core = core.replaceAll("__SNAPSHOT_SELECT__", () => snapshot.slice(0,-1));
 const statements = [
  "BEGIN ISOLATION LEVEL READ COMMITTED;",
  "SET LOCAL statement_timeout='5s';",
  "SET LOCAL lock_timeout='500ms';",
  "SET LOCAL idle_in_transaction_session_timeout='10s';",
  "SET LOCAL search_path=pg_catalog;",
  "SELECT pg_catalog.set_config('shrigma.private_own_recovery_envelope',$1::text,true) IS NOT NULL AS private_envelope_bound;",
  core,
  "SELECT pg_catalog.set_config('shrigma.private_own_recovery_envelope','',true) IS NOT NULL AS private_envelope_cleared;",
  "COMMIT;"
 ];
 return deepFreeze({schema:"own-startup-template-recovery-prepared-v2", plan,
  planSha256:sha(JSON.stringify(plan)), sourcePins:{...ASSETS}, atomicSha256:sha(core),
  statements, snapshotReadSQL:snapshot, executionAvailable:false,
  privateParameterContract:"JSON envelope only in trusted Root DB/RAM; never shell/argv/file/log",
  originalOperational:false, authorizesProcessing:false});
}
function executeOriginal() { refuse("OWN_RECOVERY_ORIGINAL_EXECUTION_NOT_ADMITTED"); }
module.exports = Object.freeze({prepare, executeOriginal, PURPOSES, QUERY_SHA256, KERNEL_SHA256,
 RUNTIME_SHA256, NEW_WORKER_SHA256, IMAGE_SHA256, ASSETS});
