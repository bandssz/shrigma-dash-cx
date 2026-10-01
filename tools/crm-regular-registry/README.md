# Regular worker registry publication

This package verifies one immutable GitHub Actions artifact and can copy its existing OCI layout to GHCR. It does not rebuild an image, activate the regular audience runtime, change a service, or deploy anything.

`lock.json` pins the successful pull-request run, source head, CI merge revision, destination/tag, OCI manifest and config, executable/query/source identities, and every file in the downloaded artifact. The current lock selects run `36840732411` from PR202 head `a5f9402f9106ea61db25c53c69c1697bef0cf1be`, after every required PR check passed. The query is unchanged; this package adds the graph cache runtime `52991c68b5d94dd469b7b0d3a1bc731db108c3e4d139a17351690ae7c37a3335`. The same Linux executable passed legacy/regular audience tests and real HTTP creation of one immutable clone per brand, replay reconciliation without another clone, and process-generated cache snapshots, with graph/cart OFF and no external send. It is enabled only for the explicit manual registry job; that flag never enables the runtime. `verify` can also inspect a disabled lock; `publish` rejects one.

The verifier requires a completed successful pull-request run from the expected repository, workflow and a direct merged-PR readback pinned to its merge commit (the run PR array may be empty after merge), an exact artifact inventory with no links or special entries, a complete Linux/amd64 OCI graph, and consistent image, package, native and PostgreSQL proofs. Native and PostgreSQL clusters must be stopped, and all proof records must state that production was unchanged.

A package containing the graph cache runtime additionally requires its exact runtime identity in the lock and a native HTTP proof from the same executable. That proof must create one immutable template for each brand through the real API, reconcile without another creation, and observe both snapshots from the process heartbeat. Empty caches cannot authorize activation. All graph/cart gates remain OFF and SMTP, entries, dispatches and send logs stay at zero during this proof. The registry verifier rejects an incomplete, synthetic-only or mismatched proof.

Manual publication is additionally restricted to GitHub Actions on `main` in the pinned repository. Authentication is passed to `skopeo login` over stdin. The registry package already exists, so authorization failures are never interpreted as absence. A missing fixed tag may be created with `skopeo copy --preserve-digests`; an existing different tag is a collision, while an existing exact tag is reconciled without another copy. Both tag and digest are read back. The resulting receipt states that the image remains OFF and was not deployed.

Run local unit tests with:

```sh
python3 -m unittest discover -s tools/crm-regular-registry -p 'test_*.py'
```

For future candidates, replace every pin and the complete inventory through a reviewed PR after the source PR is green. Never retarget the fixed tag to different bytes.
