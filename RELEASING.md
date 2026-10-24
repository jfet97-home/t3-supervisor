# Maintaining releases

The public installation guide is the [README](README.md). Release automation is
installed by this change but remains disabled until the one-time setup below.
It never deploys Supervisor or upgrades a running installation.

## Choose a version change

For a user-visible PR, run `pnpm changeset`. Choose patch for a fix, minor for a
feature, and major for an incompatible change; write a short note describing the
effect on users. Before 1.0, read the notes carefully rather than assuming that a
minor release preserves state compatibility. Infrastructure-only PRs may omit a
changeset. Every Effect package remains exactly pinned independently of app versions.

With `RELEASE_VERSIONING_ENABLED=true`, **Prepare version** collects the notes in
a `changeset-release/main` PR, bumps `package.json`, updates `CHANGELOG.md` and
consumes the notes. It explicitly dispatches required CI on that branch. The
version PR is reviewed and merged manually; the workflow never enables auto-merge.
Required `check` still includes all four main shards, the harness and static checks.

## Channels

| Channel | Trigger after publishing is enabled | Version | npm and image aliases |
| --- | --- | --- | --- |
| Stable | Successful main CI for the merged version PR, or explicit manual dispatch | Manifest version, e.g. `0.2.0` | `latest` |
| Nightly | Successful main CI for other main commits, or manual dispatch | Next planned version plus commit timestamp and SHA | `nightly` |
| Alpha | Manual dispatch | Next planned version plus commit timestamp and SHA | `alpha` |
| Beta | Manual dispatch | Next planned version plus commit timestamp and SHA | `beta` |

For example, `0.2.0-beta.20261024140000.gabcdef123456` is a beta snapshot of a
specific checked commit. Pending changesets determine its base; without pending
notes, previews target the next patch. Preview generation does not consume notes
or put the repository into Changesets pre-release mode. Re-running the same commit
and channel produces the same version. These are rolling snapshots on green main,
not a calendar schedule, and alpha/beta require an explicit release decision.

Each publication advances only its selected alias. Stable never follows a preview
automatically. Old commits and versions cannot move an alias backwards. Users opt
into previews by selecting their alias or an exact version; running installations
do not update themselves.

## What the workflow verifies

**Publish release** resolves a main commit and requires successful push-to-main CI
for that exact SHA, including the aggregate `check`. PR checks alone are not enough.
Automatic events skip superseded nightly commits and retain approved stable ones.
Stable requires consumed changesets;
the absence of an existing Git tag alone never authorizes stable publication.

The workflow stamps the disposable build manifest with its version and `gitHead`,
builds an archive containing `dist`, `ui-dist` and portable skills, installs that
exact archive outside the checkout, and starts it against a bounded native T3
fixture. It checks health metadata, CLI version, dashboard HTML, its hashed asset
and clean cancellation. It checks a local container before pushing, then exercises
both published image variants by their immutable index digest before moving an
image channel or publishing the package. ARM64 runs under QEMU on the hosted runner.
It reuses the successful full CI verdict; it does not run the full suite again.

The npm package, Linux amd64/arm64 image, Git tag and GitHub release share one
version and source revision. The release records the archive SHA256, image index
digest and source SHA; npm publication includes provenance. Images are built from
the frozen pnpm lockfile. A normal npm/pnpm consumer install resolves transitive
dependency ranges at installation time; use the image digest when an immutable
dependency tree matters.

Publication is serialized with GitHub's queue (up to 100 pending runs) and does not
replace pending releases or cancel publication in progress. Existing immutable
versions/tags must identify the same source before a retry can continue. A failure
between registries can leave a partial publication; rerun the same commit/channel
to finish it. Do not bump a version merely to retry. GitHub releases are the final
publication receipt. Never overwrite a conflicting package, image or Git tag.

The requested CI policy still cancels superseded main runs. If a version merge's
main CI was canceled by a newer push, rerun that original main CI from GitHub's
run page. It checks the original SHA; after success, its approved stable release
can proceed even if main has advanced. Publication never treats cancellation as
success or substitutes a newer, different source tree.

## One-time setup and first release

No account credentials, repository settings or publishing flags are changed by
this PR. The maintainer must own the npm package name before enabling publication.

1. Create a GitHub Actions environment named **`release`**, with **Selected
   branches and tags** allowing only branch **`main`**. This environment is for
   registry publication, not a running Supervisor deployment. Allow GitHub Actions
   to create pull requests for this repository. Enable the
   repository Actions variable `RELEASE_VERSIONING_ENABLED=true`, then dispatch
   **Prepare version** on main. Review the first 0.2.0 version PR and its full CI.
2. Merge the version PR and wait for its main CI. Keep
   `RELEASE_PUBLISH_ENABLED` unset. Dispatch **Publish release** with channel
   `stable`, that exact main SHA and **publish=false**. Inspect the resulting
   archive, plan and checksums in the workflow artifacts.
3. The package is initially absent from npm. An authenticated package owner must
   publish this exact reviewed archive once, using `pnpm publish ARCHIVE.tgz
   --access public --tag latest --no-git-checks`. Do this from the checked main
   checkout so its repository metadata matches the archive. Do not create a dummy
   package or commit a publishing token.
4. In npm's package settings, configure a GitHub Actions trusted publisher for
   owner `jfet97-home`, repository `t3-supervisor`, workflow **`release.yml`**,
   environment **`release`**. Keep the main-only environment restriction in place;
   a filename-only trusted publisher does not restrict publishing to main.
   Use OIDC rather than a long-lived registry token. GitHub-hosted runners are
   required by this workflow. Make the GHCR package public after its first push
   if it was created private; repository visibility does not imply package visibility.
5. Set `RELEASE_PUBLISH_ENABLED=true`. Re-run **Publish release** for the same
   stable SHA with **publish=true**. It reconciles the existing npm version and
   completes the image and GitHub release. Later green main commits can publish
   nightly; a merged version PR can publish stable.
6. Verify installation from the public registry and pull both image platforms
   without privileged credentials. Remove the README's first-release notice only
   after those public paths actually work.

Use the workflow's dry-run option for alpha/beta planning too. A manual publication
requires both **publish=true** and the repository publishing variable; a default
dispatch cannot accidentally publish. Disabling either variable pauses that part
of the automation without changing installed services. Do not enable publication
until the first package ownership and public-image checks are complete.

The first owner publication is the only bootstrap step that uses interactive npm
authentication. Subsequent publishing uses pnpm 12's native OIDC support. See
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[pnpm publish](https://pnpm.io/cli/publish).
