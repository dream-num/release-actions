# Release Actions: engineering contract

## Responsibility and identity
- Shared Actions hold implementation, not product workflow dispatch, allowlists,
  GitHub permissions, npm Trusted Publisher identity, or private source retirement.
- Keep each product's `promote-cli-public.yml` entry. Submit requires that manual
  workflow on its default branch with the caller's OIDC. Validation defaults to
  no writes; upstream Insider POST with `dryRun=true` is only a read-only plan.
- GitHub CI in this repository must not have release credentials or OIDC write.
  Unit fixtures are synthetic; the integration workflow uses an offline fetch
  adapter and actual tar archives to exercise the actual composite entrypoint.
  Never publish, stage, change public tags, or unpublish as a test.

## Inputs
- One package: `package`, exact SemVer `version`, and explicit boolean string
  `latest` (default false). The existing single-package flow stays compatible.
- Many packages: `batch` is one inline JSON object, not one package or a comma list.
  Omit the single-package inputs. Manifest v1 requires `schema: 1`, `batchId`,
  fixed source registry, and 1–100 distinct package names, each with exact
  `version`, original artifact `integrity` (full SHA-512 SRI) and target `tag`.
  Assemble the cohort from the SDK release outputs, not globbed package directories
  and not the source package.json versions (which can be placeholders).
- Targets: latest (stable only), beta, rc, or promoted. latest/beta/rc must point
  to the exact source through that Insider tag. A reused identical beta/rc package
  is not silently retagged. The public destination is fixed; do not accept
  arbitrary origins, credentials, or unreviewed tarball redirects as inputs.

Illustrative CLI + Collab cohort (replace names/versions with actual package
list from release outputs, and hashes with those artifacts' complete SHA-512 values):

```yaml
- uses: dream-num/release-actions/promote-npm@v1.0.0
  with:
    mode: validate
    batch: >-
      {"schema":1,"batchId":"sdk-2026-11-19",
       "sourceRegistry":"https://insider-npm-registry.univer.work/",
       "packages":[
         {"name":"@univerjs-pro/collaboration-endpoint","version":"1.0.0","integrity":"sha512-<full hash 1>","tag":"latest"},
         {"name":"@univer-cli/config","version":"2.0.0","integrity":"sha512-<full hash 2>","tag":"latest"}]}
  env:
    INSIDER_TOKEN: ${{ secrets.NPM_TOKEN }}
```

Tag is an example, not a tag already released. Caller provides Node 24 and
npm 11.21.0+ where required. Include the cohort's dependencies if not already
public; the server validates the real artifact dependency ranges and rejects
cycles/missing dependencies. Do not ask callers to hand-sort packages.

## Ordering, failures and retries
1. Validate the entire manifest and (for submit) caller identity before requests.
2. Use one Insider batch dry-run; require an exact, complete, nonexpanded plan.
   Its dependency order controls submission, not manifest order.
3. Download and verify all original artifacts locally, including each expected
   digest and package manifest, before the first public write. Each write retains
   the single-package safeguards and rechecks current public state.
4. For validate, no public writes. For submit, record per-package outcomes in
   `.promotion/batch/batch-result.json`. On failure stop: accepted prior
   packages may remain accepted, the failing package may be uncertain, and later
   packages have not been attempted. Never assume npm batch atomicity or undo a
   prior write. No blind retry; reconcile unknown outcome with npm and the exact
   version/digest. Result evidence is run-local, not durable idempotency across runs.

## What must remain separate
- `check-npm-public` is credential-free exact package/version metadata readback.
  404 means not publicly visible, not proof of an npm moderation state. A digest
  conflict or timeout cannot authorize source release.
- No Action retires anything in Insider. Production retirement must be a separate
  Insider transaction after whole-cohort verification of public artifacts,
  expected source identities and completeness. A persistent confirmation queue
  and a single completed event are follow-up, not provided by this repository.

## Test and review
Run `node --test promote-npm/*.test.mjs check-npm-public/*.test.mjs`. GitHub's
no-publish workflow also invokes local composites and tests two-package success,
digest mismatch and credential/dispatch rejection. Do not call a live registry
to validate npm behavior. Use reviewed versions for callers; do not move released
tags or change product workflow identity without an explicit request.

### Assemble an existing Insider batch

Use `assemble-npm-batch` with JSON `selection`:
`{"packages":[{"name":"example-cli","version":"1.2.3"},{"name":"example-collab","version":"1.2.3"}]}`.
It reads exact versions' Insider metadata and outputs the expected SHA-512 in
`batch`; it neither downloads a tarball nor calls a promotion endpoint.
Pass that output to `promote-npm` in the same workflow run. The promotion
action downloads once per package, checks the bytes against the expected
digest, and submits those same archives in submit mode. A one-entry batch is
not special. No manually supplied digest or artifact transfer is required.

### Resolve a source run instead of hand-entering packages

The caller workflow keeps the reviewed producer policy static; do not build it
from dispatch input or source artifact text. A private repository may use a
token scoped only to Actions read on that source; omit the token for public
sources. The receiving runner needs Node and Python 3.

```yaml
- id: source
  uses: dream-num/release-actions/resolve-npm-source-run@REVIEWED_COMMIT
  with:
    repository: ${{ inputs.source_repository }}
    run-id: ${{ inputs.source_run_id }}
    producer: >-
      {"repository":"example/producer","repositoryId":123,
       "workflow":".github/workflows/release.yml","event":"workflow_dispatch",
       "ref":"refs/heads/main","publishJob":"publish",
       "packages":[{"name":"example-cli","tag":"promoted"}]}
```

The final attempt must be completed successfully; the action never searches for
an older successful attempt. It requires the matching successful publish job
and one `insider-release-v1-<attempt>` ZIP uploaded by the trusted producer
during that job. The ZIP must contain just `insider-receipt.json`, with exact
schema:

```json
{"schema":1,"repo":"example/producer","runId":42,"attempt":2,
 "ref":"refs/heads/main","commit":"<40-hex GitHub source SHA>",
 "packages":[{"name":"example-cli","version":"1.2.3",
              "integrity":"sha512-<full original archive SHA-512>"}]}
```

The producer issues the receipt only after successful Insider publish and
exact-version integrity readback. A prepare artifact is not a receipt.
GitHub archive SHA-256 protects the receipt ZIP; the package SHA-512 is
subsequently checked by the registry operation. The resolver does no npm
operation and does not grant publishing rights. Pass `steps.source.outputs.batch`
to `promote-npm` with `mode: validate` for an initial Insider verification, or pass
one selected entry's name, version and integrity to `check-npm-public` for public
visibility. Do not wire a receipt to an automatic unpublish operation.
