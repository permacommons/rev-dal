# Local agent instructions

## Documentation maintenance

Keep documentation up to date in the same change as the implementation. When
changing public APIs, behavior, configuration, or development workflows, update
the relevant documentation:

- `README.md`: overview, requirements, installation, quick start, and links.
- `docs/models.md`: bootstrap, manifests, model methods, typing, cross-model
  references, logging, database grants, and runtime architecture.
- `docs/queries.md`: filtering, projections, aggregates, joins, deletion, and
  relation loading and writes.
- `docs/revisions.md`: revision workflows, edit conflicts, and transactions.
- `docs/multilingual-text.md`: schemas, language providers, escaping, cleanup,
  and rendering responsibilities.
- `CONTRIBUTING.md`: development setup, test database configuration, checks,
  and the source directory map.

Keep the README concise and link to the topic guides for details. Give each
behavior one authoritative explanation and link to it instead of duplicating
the contract across pages. Distinguish guarantees made by rev-dal from
conventions or helpers supplied by consuming applications.

Check examples against the implementation and types. Verify affected relative
links and heading anchors after moving or renaming documentation. Keep new
documentation included in the package through `package.json`'s `files` list.
Update `TODO.md` when implementing an item listed there.

## Releases

Release automation lives in this repository and uses our own scripts, official
`actions/*` GitHub actions, and the standard `npm`, `git`, and `gh` CLIs. Do not
introduce Release Please, semantic-release, Changesets, or third-party release
actions. Use `mise exec --` for local Node/npm commands.

### Version and API policy

- Release stable versions only. The first deliberate release should be `0.2.0`;
  the existing `0.1.0` is an unreleased development placeholder.
- Before 1.0, compatible fixes and additions increment the patch version;
  breaking changes increment the minor version. Choose `1.0.0` explicitly when
  committing to a stable API. Afterwards use normal major/minor/patch semantics.
- Compatibility includes runtime behavior, TypeScript declarations, all exported
  `rev-dal/lib/*` subpaths, the SQL setup export, and database requirements.
- Record changes and migration instructions in `releases/<version>.md`. Explain
  database or grant changes explicitly; declaring models does not migrate tables.
- Versions, released notes, and `v<version>` tags are immutable. Fix an already
  published package with a new release. Never force a tag or unpublish to retry.
- Keep the Git-install `prepare` build until consumers have migrated. Registry
  packages contain built JavaScript and declarations and require no consumer build.

### One-time setup

1. Merge the workflow setup into `main` so manual dispatch is available. No npm
   package is published merely by merging the setup: the version stays `0.1.0`.
2. Enable Actions and allow GitHub Actions to create pull requests in repository
   Settings → Actions → General. Workflows explicitly request their permissions;
   no PAT, GitHub App, or cross-repository write token is required. Only the first
   npm publication needs a temporary npm bootstrap token; routine releases use OIDC.
3. Protect `main` against direct pushes and require the `lint`, `test`,
   `consumers (lib.reviews)`, and `consumers (agpwiki)` checks. Permit the chosen
   merge method (squash or merge commits both work). Confirm the check names in
   the first run before adding requirements. The release PR is the review point;
   do not add a recurring environment approval if unattended publishing is wanted.
4. Establish ownership of the unscoped npm package `rev-dal` using the owner's
   npm account. A registry 404 does not reserve the name. If it is unavailable,
   change the package name and scripts consistently before releasing; do not
   silently publish under another name.
5. For a brand-new package, the npm account owner creates a temporary granular
   access token on npmjs.com (account menu → Access Tokens → Generate New Token).
   Use package permission **Read and write (publish and stage)**, enable **Bypass
   two-factor authentication**, and choose the shortest practical expiry (one day
   suffices). An unscoped package that does not exist cannot be selected individually;
   use **All Packages** for this bootstrap token. Organization-management access
   is unnecessary. The owner must complete npm's account authentication personally.
   Agents must not request the token value in chat, print it, or commit it.

   Store it as the repository Actions secret `NPM_BOOTSTRAP_TOKEN`, using GitHub
   Settings → Secrets and variables → Actions, or this interactive command:

   ```bash
   gh secret set NPM_BOOTSTRAP_TOKEN --repo permacommons/rev-dal
   ```

   Prepare the first release (`0.2.0`), verify its PR checks, and merge when authorized.
   Only its final publish step receives this secret as `NODE_AUTH_TOKEN`; neither
   package tests nor consumer jobs receive it. npm attempts OIDC first and falls
   back to the token before a trusted publisher exists. The workflow publishes the
   exact tested tarball, with provenance, then creates its tag and GitHub release.
   The secret is eligible only for version `0.2.0`; later versions cannot use it.
   If publication already failed before the secret was added, use the retry procedure.
6. After the first publication succeeds, remove the GitHub secret and revoke the
   temporary token in npm. Agents can remove the repository secret without reading
   its value; the account owner can revoke the npm token:

   ```bash
   gh secret delete NPM_BOOTSTRAP_TOKEN --repo permacommons/rev-dal
   ```

7. Shortly before the next release, configure npm's `rev-dal` package Settings →
   Trusted Publisher to authorize GitHub Actions:
   owner `permacommons`, repository `rev-dal`, workflow filename `publish.yml`,
   no environment. Enable direct `npm publish`; staged-only authorization would
   require interactive approvals. The workflow uses GitHub-hosted runners, npm 11,
   and `id-token: write`. Routine OIDC publication includes provenance.
   A new trusted publisher must successfully publish within two days or it expires;
   configure it when the next release is ready. A retry of an existing version only
   verifies registry integrity and does not validate the OIDC configuration. Later
   versions publish through OIDC without the bootstrap secret.

References: [npm token setup](https://docs.npmjs.com/creating-and-viewing-access-tokens/)
and [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

### Prepare and release

Run from this repository, or supply `--repo permacommons/rev-dal` to `gh`:

```bash
gh workflow run prepare-release.yml --ref main \
  -f version=0.2.0 \
  -f notes='First versioned release. Existing rev-dal imports remain supported.'
```

`version` accepts `patch`, `minor`, `major`, or an explicit increasing `X.Y.Z`.
Choose the bump based on the policy above; no commit-message parser decides it.
The `notes` input accepts multiline Markdown and must describe the actual release.
Do not use the example notes without reviewing the changes since the consumer pins.

`prepare-release.yml` reads current `main`, updates package.json and package-lock.json
without lifecycle scripts, writes release notes, pushes `release/v<version>`, and
opens a PR. It explicitly dispatches `lint.yml` and `tests.yml` on that branch.
This avoids relying on PR events generated by `GITHUB_TOKEN`. The dispatched runs
attach to the branch's current commit; verify the checks refer to the PR head SHA.

Inspect the diff, notes, workflow results, and any migration instructions, then
merge the passing PR when authorized to release. `publish.yml` detects a version
change on `main` and validates the exact merged commit before publishing. Non-version
package metadata changes do not publish. Both workflows only start on `main`.

### Validation and artifacts

`tests.yml` is both ordinary CI and a reusable release validation workflow:

1. Run rev-dal's runtime/PostgreSQL tests, type tests, release-tool tests, lint,
   typecheck, and build on Node 22.
2. Pack once with `npm pack --ignore-scripts`. Install the tarball in a clean
   temporary project with install scripts disabled; check runtime exports, SQL
   resolution, and declaration imports.
3. Upload `rev-dal-package` containing `rev-dal.tgz` (retained for 14 days), with a
   SHA-512 in the job summary.
4. Test that same tarball against lib.reviews and agpwiki `main` in disposable
   runner checkouts using Node 24 and PostgreSQL 16. Record each checkout SHA,
   run full typechecks and tests, and block publication if either fails.

The consumer jobs do not push changes, edit consumer repositories, or use local
consumer checkouts. Their temporary dependency install affects only the runner.
Consumer `main` is resolved per validation run; retries record any newly tested SHAs.
Their required database setup currently mirrors their own CI. Update this workflow
when consumer requirements change. A consumer CI failure is a release blocker;
do not bypass it or change consumer code as part of a release without authorization.

Publication downloads the validated artifact, uses `npm publish` with OIDC (or the
temporary token for the first `0.2.0` publication) and provenance, verifies registry
integrity, then creates the immutable tag and GitHub
release from the checked-in notes. The publish job does not rebuild the package.
The summary includes version, commit, integrity, and publication URLs. No consumer
dependency update or deployment happens automatically in this initial setup.

### Recovery

Preparation and publication each serialize their runs. Different unpublished
release PRs can still exist: merge them in version order and close stale ones.

- If preparation fails after pushing its branch or opening the PR, preserve that
  work. Locate the existing `release/v<version>` branch/PR; do not force-push or
  blindly rerun preparation. Dispatch any missing checks on that branch:

  ```bash
  gh workflow run lint.yml --ref release/v0.2.0
  gh workflow run tests.yml --ref release/v0.2.0
  ```

- After editing a bot-created PR, dispatch both checks again at its new head.
  Never treat passing checks on an earlier SHA as sufficient.
- To retry publication, use the full SHA of the merged main commit that introduced
  the version, not the release branch head or current main after later changes:

  ```bash
  gh workflow run publish.yml --ref main -f commit=<40-character-merged-sha>
  gh run list --workflow publish.yml
  gh run watch <original-push-run-id> --exit-status
  ```

  Manual dispatch queues a complete rerun of the original push workflow for that
  commit; its summary links to that original run. Watch the original run after its
  new attempt starts, rather than only watching the short dispatch run. This
  preserves the original `GITHUB_SHA` for accurate npm provenance even if main
  has advanced. A checkout of an older commit in a new main run would attest the
  wrong source identity, so the publish script rejects such mismatches.

  The target must belong to main's first-parent history, introduce an increasing
  version, and have matching manifests and version-specific notes. Validation runs again. Existing
  tags must point to that exact commit; an existing registry package must match
  the tested tarball's SHA-512. Matching publication steps are skipped and missing
  steps are completed. Conflicting bytes or tags fail rather than overwrite.
  Revalidation replaces the earlier run artifact with the newly tested tarball.
  A retry cannot publish an absent older version over a newer npm `latest`.
- If the tarball cannot be reproduced, investigate the build inputs; never waive
  the integrity check. If publication failed before npm accepted the package and
  source changes are required, prepare a new version.
- Consumer updates are deferred. When authorized, migrate each consumer to an
  exact published version and commit its lockfile; keep deployment on `npm ci`.

### Local checks

```bash
mise exec -- npm run test:release
mise exec -- npm run lint
mise exec -- npm run typecheck
mise exec -- npm run test:types
mise exec -- npm test
mise exec -- npm run build
artifact_dir=$(mktemp -d)
mise exec -- npm pack --ignore-scripts --pack-destination "$artifact_dir"
mise exec -- node scripts/check-package.mjs "$artifact_dir/rev-dal-0.2.0.tgz"
```

Use the current package version in the tarball filename. The package smoke check
installs runtime dependencies from npm into a temporary directory, then removes it.
The runtime tests require the test database configuration in CONTRIBUTING.md.
