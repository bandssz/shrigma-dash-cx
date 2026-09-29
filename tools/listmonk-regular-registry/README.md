# Regular worker registry publication

This package verifies one immutable GitHub Actions artifact and can copy its existing OCI layout to GHCR. It does not rebuild an image, activate the regular audience runtime, change a service, or deploy anything.

`lock.json` pins the successful pull-request run, source head, CI merge revision, destination/tag, OCI manifest and config, executable/query/source identities, and every file in the downloaded artifact. The current lock selects run `36526032445` from PR174 head `ea6443ff2b5d5287cf5bf1d9a0d68ce45e338c19`, after all eleven PR checks passed. It is enabled only for the explicit manual registry job; that flag never enables the runtime. `verify` can also inspect a disabled lock; `publish` rejects one.

The verifier requires a completed successful pull-request run from the expected repository, workflow and PR, an exact artifact inventory with no links or special entries, a complete Linux/amd64 OCI graph, and consistent image, package, native and PostgreSQL proofs. Native and PostgreSQL clusters must be stopped, and all proof records must state that production was unchanged.

Manual publication is additionally restricted to GitHub Actions on `main` in the pinned repository. Authentication is passed to `skopeo login` over stdin. The registry package already exists, so authorization failures are never interpreted as absence. A missing fixed tag may be created with `skopeo copy --preserve-digests`; an existing different tag is a collision, while an existing exact tag is reconciled without another copy. Both tag and digest are read back. The resulting receipt states that the image remains OFF and was not deployed.

Run local unit tests with:

```sh
python3 -m unittest discover -s tools/listmonk-regular-registry -p 'test_*.py'
```

For future candidates, replace every pin and the complete inventory through a reviewed PR after the source PR is green. Never retarget the fixed tag to different bytes.
