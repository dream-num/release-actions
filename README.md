# Release Actions

Shared release steps, not shared release entrypoints. The original product
workflow filename, dispatch, package allowlist, npm trust binding and
permissions remain with the product repository.

- **promote-npm** ports the production promotion engine from Univer Workspace PR #474.
  Default mode is `validate`: consult the Insider dry-run API and verify/download the original artifact.
  `submit` checks for default-branch manual dispatch of `promote-cli-public.yml` and OIDC before accessing Insider, then validates and submits. No post-submission public readback.
  Caller provides Node 24, npm 11.21.0+, `BASE_BRANCH` and the explicit `INSIDER_TOKEN` environment variable; only the product publishing job grants `id-token: write`. Evidence is in `.promotion/`.
- **check-npm-public** checks an exact package/version and expected SHA-512 against public npm metadata using no credentials. Its status is `visible_match`, `not_visible` or `mismatch`; transport/HTTP errors fail. A 404 does not establish an approval status. This check alone does not authorize Insider retirement or prove downloaded bytes.

Example for use after review and an immutable release tag:
```yaml
- uses: dream-num/release-actions/promote-npm@v1.0.0
  with:
    package: univer-workspace-cli
    version: 0.7.1
    latest: 'true'
    mode: validate
  env:
    INSIDER_TOKEN: ${{ secrets.NPM_TOKEN }}
```

No tag or caller migrations are part of the initial draft. The first action
does not yet accept SDK batches; batch policy/dependency planning,
persistent Insider confirmation, retirement and event emission will be a separate
stage. Verification workflow tests the two actual composite entrypoints fail
closed, and exercises the release engine against fixtures/loopback. It does not
perform a real npm stage, publish, unpublish, use production credentials, or
test cross-repository access. The private repository must be visible to the
intended caller workflow before cross-repository use.
