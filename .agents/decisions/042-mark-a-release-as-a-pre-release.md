# 042. Mark a release as a pre-release

- Status: Accepted
- Date: 2026-10-02
- Deciders: capric98
- Amends: ADR 034

## Context

ADR 034 sets the release version form: `MAJOR.MINOR.PATCH`, with no pre-release part,
because of the limits of the MSI product version. It says that a version with a
pre-release part needs a separate decision. `docs/releasing.md` read this as "The project
makes no pre-release versions."

GitHub has a second, separate thing: the pre-release flag of a release. The flag does not
change the version, the tag, or the bundles.

v0.1.0 has the flag. The `draft` job of run 36892079917 made the draft. While the `publish`
job waited for approval, a maintainer published the draft outside the workflow, on
2026-10-01 at 16:50 UTC. The `publish` job got no approval, ran no step, and was cancelled.
So the checks of that job did not run for v0.1.0. On 2026-10-02, the GitHub API gave
`prerelease: true` and `immutable: true` for v0.1.0, and `releases/latest` gave 404. The
tag `v0.1.0` pointed at `20b3b0cf`, the `target_commitish` of the release.

The maintainer wants to keep the option to publish a pre-release.

A full release is a published release with no pre-release flag. The `publish` job sends
`make_latest=true` when the new version is higher than the version of each other published
full release. The GitHub REST API says that a pre-release cannot be set as Latest. Users
of release-drafter and of softprops/action-gh-release report HTTP 422 for that request. So
a draft with the flag can make the `publish` step fail.

## Decision

A pre-release is a published release with the GitHub pre-release flag. Its version is a
release version of ADR 034. The tag, the workflow, and the asset list of ADR 034 do not
change. A version with a pre-release part, such as `0.2.0-beta.1`, still needs its own
decision.

**The workflow publishes a full release.** The maintainer does not set the flag on the
draft, and does not publish the draft from its edit form. The `publish` job publishes the
release with all its checks.

**The maintainer sets the flag after the publish.** The GitHub documentation of immutable
releases says that the pre-release flag and the Latest label stay editable after the
publish. The tag and the assets stay locked. The maintainer edits the published release,
selects **This is a pre-release**, and clicks **Update release**.

**Latest.** A pre-release cannot be Latest. After the maintainer sets the flag, the
maintainer checks the Latest label on the **Releases** page. The `publish` job of a later
release compares its version only with the published full releases. So a later full
release with a lower version than a pre-release can become Latest.

**A pre-release can become a full release.** The maintainer clears the flag. When its
version is higher than the version of each other published full release, the maintainer
also selects **Set as latest release**. The bundles do not change.

The maintainer refused two alternatives:

- Set the flag on the draft while the `publish` job waits. The request for Latest can then
  fail. A change to `release.yml` that sends `make_latest=false` for a pre-release would
  fix this, but it can be tested only with a real release.
- Publish the draft from its edit form, as for v0.1.0. That publish skips the asset check,
  the tag check, the immutability check, and the attestation check of the `publish` job.

## Consequences

- For a short time after the publish, a pre-release is a full release, and it can be
  Latest. A user can download it in that time.
- The version of a published pre-release stays used. The next release takes the next
  version.
- `releases/latest` does not include pre-releases. While each published release is a
  pre-release, the repository has no Latest release, and that URL gives 404. The README
  links to the releases page, not to `releases/latest`.
- ADR 034 still controls the release version form. Rule 7 of ADR 034 now counts only the
  published full releases, which is what the `publish` job does.
