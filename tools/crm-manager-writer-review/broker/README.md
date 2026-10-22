# WRITER broker native proof — candidate CI only

Proposed invocation in a new validation job on the exclusive candidate branch, with Node22 already selected:

```yaml
- name: Separate WRITER broker actual native transport
  env:
    CRM_WRITER_BROKER_NATIVE_PROOF: '1'
  run: bash tools/crm-manager-writer-review/broker/run-native-broker-proof.sh
```

Use ubuntu-24.04, read-only contents permission and an eight-minute job timeout; this new job must gate each candidate publisher. No publisher marker, production variable, external Easypanel network or existing pipeline changes belong in this hook. Run syntax plus `node tools/crm-manager-writer-review/broker/native-broker.test.cjs --pure` before the opt-in step. Both direct native invocation and shell refuse missing opt-in; they never silently skip.

Exactly three new source paths: native-broker.test.cjs, run-native-broker-proof.sh and this README, under tools/crm-manager-writer-review/broker. The older native NOLOGIN/DB crm_manager_writer_fixture helper stays intact.

The shell creates unique CSPRNG-labelled container IDs and a unique internal bridge; no published ports. PG is pinned `postgres:17.10@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317`, with DB listmonk, actual alias comunicacao_postgres:5432, cluster shrigma-writer-broker-<16hex>. PG limits are 1CPU/512MiB/PID128, read-only root, ALL caps dropped, NNP and new tmpfs data. The client harness uses public issuer image `5ca20e4ea134b7a1a139b80c74a65573a4386d9584fcac40aeedaeb9cf8fe815` solely for existing Node22/pg8.13.1. It mounts thirteen explicitly hash-pinned public source files plus this native test read-only, UID1000, ALL caps dropped, NNP, .35CPU/320MiB/PID64, root read-only and tmpfs /tmp16MiB. Image-declared volumes must be empty. Both containers have inherited healthchecks disabled and log driver none. No checkout, identity, secret file, existing PG volume or Docker socket is mounted.

Secrets are fresh synthetic CSPRNG values, passed by env-name only to the two own containers and then unset on the host; service token/SCRAM/verifier stay in client RAM. Parameter/statement/error-statement logging is suppressed and verified before binding a synthetic SCRAM verifier. Docker container config may retain synthetic environment until removal; this is not forensic RAM erasure. No values, argv/config dumps or Docker logs are printed. Cleanup checks labels on exact captured IDs, removes those containers including only their anonymous volumes, removes the exact own network and confirms removal; no prune or unrelated resources. Cleanup failure is fatal even after tests pass.

Actual native checks use unchanged connectionParameters, actual session/current role and PG server identity/version170010. There is no forged metadata, TLS, SET ROLE transport or legacy fixture admission. Before unchanged public READ/WRITER SQL executes, the real cluster must be empty and uniquely identified. A synthetic own role LOGIN/SCRAM and inactive issuer are created only in this disposable database. Wrong password fails, correct login admits the exact catalog SELECT, private helpers/direct data are inaccessible and STATUS refuses inactive issuer. The synthetic fixture then activates its own issuer and proves real BFF client→private loopback HTTP→pool→fixed RPC flow, caps4/TTL, historical STATUS after an intentionally dropped BFF ACK, renew/revoke/history/READ preservation and catalog drift refusal. Finally its own issuer is disabled and role NOLOGIN with receipts preserved.

The broker test factory uses the synthetic revision literal24d4a7de26b52ae4479a364f50c91cb6a853d17d; it is not the future built image revision. This is a compositional proof of the mounted source on a pinned Node/pg harness, **not** admission of a new built WRITER image. A separate root CI step must build that package, verify its OCI revision/UID/source/default-OFF/no-network/no-PG-material behavior and resource limits. Native ON currently runs at320MiB/.35CPU; future broker128MiB/.25CPU requires its own artifact/runtime proof. No image build, Docker execution, native PASS or production activation is claimed by this preparation.

Local preparation evidence: three pure checks plus CJS/Bash syntax; actual native seven subcases remain pending CI. Native errors/TAP names/proof JSON are closed; dynamic PG errors are replaced by generic refusal. Existing READ production install/LOGIN/issuer, WRITER installer/issuer/binding, flags/deploy and user/send approval remain outside scope.
