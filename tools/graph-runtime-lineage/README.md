# Explicit runtime lineage adoption

Later approved migrations can change the graph and public structural fingerprints
after the original graph installation. Credential preparation must keep rejecting
that mismatch until the later installation has its own reviewed transition.

This operator adds `runtime_lineage_extension` to the graph schema comment. It
preserves every original seal field, the maintenance seal, role identity, password
state, grants, controls and graph rows. The old structural hashes remain historical;
the extension supplies the separately reviewed current graph/public fingerprints.
It cannot install migrations, prepare a password, enable LOGIN or activate a flow.

Before preparing, the operator requires independently pinned current metadata,
the complete original anchor and optional TX transition, all-database scope review,
catalog evidence, an effective-privilege review, a native stack proof and terminal
receipts for the approved migration sources. The evidence hashes are reviewer pins;
the operator does not create or infer approval from whatever schema it finds.
The caller must verify the referenced artifacts and migration effects before
supplying that review. File bytes are checked against the reviewed source manifest.

An intent precedes the one atomic comment update. Catalog/control locks and bounded
timeouts guard the exact metadata before and after. An uncertain result is resolved
only through an independent session readback. The verified runtime predecessor is
then retained by the existing separate credential preparation and LOGIN transition.
Historical-only validation explicitly returns `structural_valid:false` and provides
no authorization for either authentication or execution.

`tests/graph-runtime-lineage.test.cjs` covers source/review pinning, preserved seals,
fresh drift, uncertain responses, independent readback and credential/access chain
composition. The native proof composes the real graph installer and installs the
real lifecycle preparation SQL on disposable PostgreSQL 17.10. It proves the atomic
adoption and unchanged graph rows with the worker still NOLOGIN and password NULL.
It does not attest a production migration, credential or executor deployment.
