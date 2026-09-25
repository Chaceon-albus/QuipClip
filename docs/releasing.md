# Releasing QuipClip

This document gives the steps of a release. ADR 034 gives the reasons for the rules.

Each release is a GitHub immutable release. After the publish, nobody can move its tag,
and nobody can add, change, or delete its assets. When somebody deletes an immutable
release, nobody can use its tag again. When a published release is wrong, release the
next patch version.

## The version

`src-tauri/Cargo.toml` holds the only copy of the application version, in its `[package]`
table. `src-tauri/Cargo.lock` repeats it, and cargo writes that copy. `package.json` and
`src-tauri/tauri.conf.json` have no `version` field. Tauri reads the version from
`Cargo.toml`.

Do not edit the version by hand. Do not run `npm version` or `pnpm version`, because they
add a `version` field to `package.json`.

A release version is `MAJOR.MINOR.PATCH`, for example `0.2.0`. It has no pre-release part
such as `-beta.1`. `MAJOR` and `MINOR` are 255 or less, and `PATCH` is 65535 or less,
because the Windows MSI package cannot hold a larger value.

| Command                                       | Result                                                   |
| --------------------------------------------- | -------------------------------------------------------- |
| `pnpm version:check`                          | Exits 1 when the version has a second copy               |
| `pnpm version:check --tag v0.2.0`             | Also exits 1 when the tag is not the release tag         |
| `pnpm version:bump patch`                     | `0.1.0` becomes `0.1.1`                                  |
| `pnpm version:bump minor`                     | `0.1.0` becomes `0.2.0`                                  |
| `pnpm version:bump major`                     | `0.1.0` becomes `1.0.0`                                  |
| `pnpm version:bump 0.3.0`                     | `0.1.0` becomes `0.3.0`. The new version must be higher. |
| `node scripts/version.mjs show`               | Prints only the version, for a workflow step             |
| `node scripts/version.mjs check --tag "$TAG"` | The check that the release workflow runs first           |

`pnpm test` also runs the check, so the gate and CI fail when a second copy appears.

The release tag is `v` and the version, for example `v0.2.0`. It is an annotated tag on a
commit on `main`.

## Setup before the first release

A repository administrator does these steps one time.

1. Enable immutable releases. Open **Settings**, then **General**. In the **Releases**
   section, select **Enable release immutability**. An organization owner can also enable
   it for the organization, in the **Releases** section of the repository policies. The
   setting applies only to releases published after it is on.
2. Recommended: add a review before the publish. Open **Settings**, then
   **Environments**. Make an environment with the name `release`, and add **Required
   reviewers**. The `publish` job then waits until a reviewer approves it. While it waits,
   you can inspect the draft and its assets.
   - When you are the only maintainer, do not select **Prevent self-review**. That option
     stops you from approving your own run.
   - When you set **Deployment branches and tags**, include the tag pattern `v*`.
     Otherwise the `publish` job cannot use the environment.
3. Recommended: protect the release tags. Open **Settings**, then **Rules**, then
   **Rulesets**. Make a tag ruleset for `v*` that restricts creations, updates, and
   deletions to the maintainers. An immutable release protects its tag only after the
   publish.

## Steps

An agent does steps 1 to 4 only when the user asks. The user does the push in step 5 and
all the steps after it.

1. Update your local `main`. Make sure that `src-tauri/Cargo.toml` and
   `src-tauri/Cargo.lock` have no uncommitted changes. The bump refuses to start when they
   have changes.
2. Run the bump:

   ```bash
   pnpm version:bump minor
   ```

   The script changes the two files and prints the next commands. When `cargo update`
   fails, or when you press Ctrl-C, the script restores the two files. If a file stays
   changed after an interruption, run
   `git restore src-tauri/Cargo.toml src-tauri/Cargo.lock`.

3. Make sure that `git diff` shows only the `version` line of `src-tauri/Cargo.toml` and
   the `quipclip` entry of `src-tauri/Cargo.lock`.
4. Commit only the two files:

   ```bash
   git add src-tauri/Cargo.toml src-tauri/Cargo.lock
   git commit -m "chore(tauri): release 0.2.0"
   ```

5. Push the commit to `main`. Wait until CI passes on that commit. When `main` takes
   changes only through pull requests, merge one, and use the merged commit on `main` in
   step 6.
6. Make the annotated tag on that commit, and check it:

   ```bash
   git tag -a v0.2.0 -m "QuipClip 0.2.0"
   pnpm version:check --tag v0.2.0
   ```

7. Push the tag. The push starts the release workflow.

   ```bash
   git push origin v0.2.0
   ```

8. Open the **Actions** tab, and follow the **Release** run. When the `release`
   environment has required reviewers, the `publish` job waits. Then open the
   **Releases** page, and inspect the draft:
   - The title is `QuipClip 0.2.0`, and the draft targets the tagged commit.
   - The draft holds three bundles: one `.dmg` for `aarch64`, one `.msi`, and one
     `-setup.exe`. Each name has the version. GitHub also shows two source code
     archives. They are not assets of the workflow.
   - On a Mac with Apple silicon, download the `.dmg` from the draft. Open it, and
     start QuipClip. macOS blocks the first start of an app with no Developer ID. Open
     **System Settings**, then **Privacy & Security**, and select **Open Anyway**.
     QuipClip must then start. macOS must not say that the app is damaged.
   - The immutable releases setting is on.

   When all four are correct, approve the `publish` job.

9. Make sure that the release shows the **Immutable** label on the **Releases** page.
   Then verify the attestation, and verify a downloaded asset:

   ```bash
   gh release verify v0.2.0 --repo Chaceon-albus/QuipClip
   ```

   ```bash
   gh release download v0.2.0 --repo Chaceon-albus/QuipClip --pattern 'QuipClip_0.2.0_aarch64.dmg'
   ```

   ```bash
   gh release verify-asset v0.2.0 QuipClip_0.2.0_aarch64.dmg --repo Chaceon-albus/QuipClip
   ```

After the publish, you can still edit the title and the notes of the release.

## The release workflow

`.github/workflows/release.yml` runs these jobs in this order:

| Job       | Token | What it does                                                                          |
| --------- | ----- | ------------------------------------------------------------------------------------- |
| `verify`  | read  | Checks the tag name, that the tag is annotated, and that `main` has the tagged commit |
| `ci`      | read  | Runs `ci.yml` on the tagged commit                                                    |
| `build`   | read  | Builds macOS `aarch64` and Windows `x86_64` as workflow artifacts                     |
| `draft`   | write | Finds or makes the draft, attaches the bundles, and checks the assets                 |
| `publish` | write | Checks the tag and the assets again, publishes, and checks immutability               |

Only the `publish` job makes the release public and immutable. Before it, the release is a
draft that only the maintainers can see. `scripts/release-assets.mjs` holds the list of
the expected assets.

A new push of the same tag stops the old run.

## When a job fails

A re-run uses the workflow file of the tagged commit. A change to the workflow file on
`main` does not reach a re-run.

Before the publish, no published release of the tag exists. Then you can delete the tag
and make it again, and the version stays the same:

```bash
git push origin --delete v0.2.0
```

```bash
git tag -d v0.2.0
```

| Failed job or step               | What to do                                                                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `verify`                         | Read the error. Delete the tag, correct the fault, and make the tag again.                                                                                                                                                                                   |
| `ci` or `build`, temporary cause | Use **Re-run failed jobs**.                                                                                                                                                                                                                                  |
| `ci` or `build`, fault in source | Correct the fault on `main`. Delete the tag, and make it again on the new commit.                                                                                                                                                                            |
| `draft`, published release found | A published release of this tag exists. Do not run the workflow again. Release the next patch version.                                                                                                                                                       |
| `draft`, bundle or asset check   | Read the asset list in the log. For a failed upload, use **Re-run failed jobs**. For a wrong bundle name, correct `scripts/release-assets.mjs` on `main`, delete the draft and the tag, and make the tag again.                                              |
| `publish`, reviewer rejects      | Nothing is published. Correct the fault, delete the draft and the tag, and make the tag again. To publish with no change, use **Re-run failed jobs**.                                                                                                        |
| `publish`, no approval           | GitHub stops the wait after 30 days, and then no re-run is possible. An approval after the bundle artifacts expire also fails. In both cases nothing is published. Delete the draft and the tag, and push the tag again.                                     |
| `publish`, draft or tag check    | First open the **Releases** page. When the release is published, do not delete it, and look for the **Immutable** label. When it is still a draft, nothing is published: find the cause, delete the draft and the tag, and push the correct tag again.       |
| `publish`, immutability check    | First look for the **Immutable** label on the **Releases** page. When it shows, the release is correct. When it does not show, the release is mutable and its tag is still free. Delete the release, enable immutable releases, and use **Re-run all jobs**. |
| `publish`, attestation check     | The release is published. Do not run the workflow again. Run `gh release verify` by hand. When it passes, the release is correct.                                                                                                                            |

## Known limits

- The macOS bundle has an ad-hoc signature and no Developer ID, and nobody notarizes
  it. macOS blocks the first start until the user selects **Open Anyway** in
  **Privacy & Security**. The Windows bundles have no signature, so SmartScreen warns at
  the first start. A published release cannot get signed bundles later, so signed bundles
  need a new version.
- The project makes no pre-release versions. ADR 034 gives the reason.
- The actions in `release.yml` are pinned to commits, and they do not update without a
  change. Update the pins and their comments by hand.
