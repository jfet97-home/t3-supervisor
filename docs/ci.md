# Contributions and CI

Contribute through a pull request. Main requires the GitHub Actions `check`
status and an up-to-date branch. Repository admins retain an explicit bypass
through a PR; ordinary direct pushes are blocked. `git push --force` cannot
override server-side rules. No additional approving reviewer is required by
the current solo-maintainer ruleset.

The active [main ruleset](https://github.com/jfet97-home/t3-supervisor/rules/25781536)
owns this server-side protection; local hooks are not the enforcement boundary.

## Full validation on PRs

Every PR and explicit **Check Supervisor** dispatch runs lint, both type checks,
build, package/container smoke checks, all four main-suite shards and the runner
harness. Each test file runs in its native shard, with one worker per runner.
The watchdog, test deadlines, leak gate, privacy guards and cleanup stay intact.

PRs explicitly check out their head commit. Strict branch protection requires
that branch to be up to date before merging. Any change to main requires the PR
to update and obtain a new successful check. Admin bypasses remain exceptional.

While editing, run focused local cases, lint and types. Leave the final complete
main and harness suites to GitHub rather than repeating them locally.

## Lightweight main validation

After merging, main tries to reuse GitHub's full PR verdict. Reuse requires:

- A merged PR whose resulting commit is this exact main commit, from this repo.
- Exactly the same Git file tree on main and the checked PR head. Squash/rebase
  commit IDs may differ; any difference in the actual files prevents reuse.
- The latest matching **Check Supervisor** run is completed and successful.
  It must be a PR run, or a dispatch on that PR's branch, at its exact final head.
- Static checks, each of the four main shards, the harness and aggregate `check`
  all succeeded in that run's latest attempt. Skipped jobs do not qualify.

Only then do main's full jobs skip. Its aggregate check requires that explicit
proof and links the full source run in the job summary. No test results, build
outputs or assertions are cached. A lightweight main run cannot vouch for another.

Missing PR metadata, API errors, a failed/pending/canceled latest run, fork PRs,
missing full jobs or a different tree trigger complete validation on main. This
also covers admin overrides. API metadata can briefly lag after a merge; the
conservative result is another full run, never an unproved green check.

Newer runs still cancel superseded runs for the same source branch. Explicit
dispatch always runs the full checks. If a stable merge's main run was canceled,
rerun that original run before publication as described in [RELEASING.md](../RELEASING.md).

This follows Scanner's principle of reusing an exact validated identity. It does
not copy Scanner's larger path-filter or deployment system. Post-merge savings
can be measured only after this policy is merged; focused local checks are not
a runner performance benchmark.
