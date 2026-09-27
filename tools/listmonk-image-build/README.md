# Listmonk A/B OCI candidate — build only, OFF

This workflow packages the **already approved** Listmonk 6.1.0 amd64 candidate as
an OCI image archive. It does not schedule email, connect to a project database,
start Listmonk, push a registry, deploy a service, or change the A/B activation.
The SQL/API/panel installation and host cutover remain separately reviewed steps.

## Pinned inputs and output

`lock.json` fixes the approved GitHub run, PR head, synthetic CI revision, exact
artifact archive, binary and query hashes. The download first checks the completed
successful source run and then checks the archive hash. Expired or unavailable
artifacts fail closed; never fall back to the latest artifact or rebuild another
executable. The original archive includes all corresponding patched source,
license and the official upstream executable for the earlier isolated tests.

The base is the immutable Linux/amd64 image manifest verified on the host. The
Dockerfile contains only FROM and COPY. It does not override the inherited
USER, ENTRYPOINT, CMD, WORKDIR, environment, exposed ports, labels or volumes.
`base-config.json` is the public official configuration blob, pinned by its exact
SHA256; it contains no account credentials. Its source is the public registry
`registry-1.docker.io/v2/listmonk/listmonk/blobs/<base_config_digest>`.

The build uses a dedicated **BuildKit tool container in the disposable CI runner**,
pinned by its amd64 manifest digest, limited to 1GiB/two CPUs and removed at the
end. This is not a Listmonk container. No image/container is created on the user's
computer or production server. The OCI exporter requires the docker-container
(or equivalent) builder driver; the default docker driver does not support it.
See [Docker OCI exporter documentation](https://docs.docker.com/build/exporters/oci-docker/)
and [the Docker container driver](https://docs.docker.com/build/builders/drivers/docker-container/).
No RUN instruction or application command is executed during the build.

Verification reads the OCI as data without loading or running it. It checks every
blob digest, one amd64 image, the complete inherited runtime configuration, all
seven base layers/diff IDs unchanged, and exactly one extra layer containing the
verified executable at `/listmonk/listmonk` (root-owned, mode0755; its parent
directory metadata must remain root-owned/mode0755). Extra paths, whiteouts,
links, permissions, archive escapes, unbounded data and configuration drift fail.

The uploaded artifact contains the OCI archive, `image-manifest.json`,
`SHA256SUMS`, generated Dockerfile and verifier/lock, public base config, AGPL
license, source provenance and the complete approved candidate archive. The
image-manifest digest is suitable for later verification; it does not identify a
published registry image because no registry push occurs. The GitHub token is
used only for read-only artifact download, never passed into the build context.

## Running and deployment boundary

Local focused tests: `python3 -m unittest discover -s tools/listmonk-image-build -p 'test_*.py'`.
Full build refuses execution outside Linux GitHub Actions with the explicit
`AB_IMAGE_BUILD_ONLY=1` guard. Use the reviewed PR workflow or workflow_dispatch;
there are no variable image, source, registry or environment inputs.

After a successful build, review the artifact and choose an explicitly approved
registry destination in a separate change. Do not infer permission to push,
create a service or restart from the image-manifest. The host command `./listmonk`
(without install/upgrade), a drained single emitter and rollback by the pinned
original image belong to the later cutover. Runtime OFF or paused alone does not
make rollback safe while an A/B arm or buffered batch can still execute.

## Reviewed registry copy

`ab-listmonk-image-publish.yml` verifies the already successful OCI build
36282672565, including its exact archive, source and manifest hashes. Its PR job
only verifies. After merge, a manual run on main copies those same bytes to
`ghcr.io/bandssz/shrigma-crm-listmonk:ab-v2-c97a058` with digest preservation;
it never rebuilds or starts the application. Package write permission exists
only on that manual job. An existing different manifest is a hard collision;
the exact existing manifest is reconciled without another copy.

The fixed initial-create option handles GHCR denying reads before a package
exists. It permits one authenticated copy to this single reviewed destination,
does not claim the denial proves absence, and never changes permissions. Tag
and digest are both read back afterward. Login uses stdin and a private,
temporary authentication file; provider error output is not echoed.

The resulting package may remain private. The receipt deliberately leaves
`public_pull_verified=false`; pull access must be confirmed independently
before a service change. Neither this workflow nor its receipt changes the
Easypanel service, activates A/B or grants restart permission.
