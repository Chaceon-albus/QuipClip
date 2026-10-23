//! The source of this build: the commit, the branch, and whether the sources differed from the
//! commit (ADR 047).
//!
//! `build.rs` asks git for these facts and gives them to the crate as compile-time environment
//! variables. The About panel of the macOS menu and the About tab of Settings show them after
//! the version, so two builds of one version from different sources look different. The
//! application version itself does not change (ADR 034).

use serde::Serialize;

/// The branch whose builds do not name their branch. Each release tag is on it (ADR 034).
const DEFAULT_BRANCH: &str = "main";

/// The source of a build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSource {
    /// The abbreviated hash of the commit.
    pub commit: String,
    /// The branch of the commit. It is `None` on the default branch and when HEAD was
    /// detached, as in the checkout of a release tag.
    pub branch: Option<String>,
    /// True when a tracked file differed from the commit.
    pub modified: bool,
}

impl BuildSource {
    /// The source of this build, or `None` when the build had no git checkout.
    #[must_use]
    pub fn current() -> Option<Self> {
        Self::from_git(
            env!("QUIPCLIP_GIT_COMMIT"),
            env!("QUIPCLIP_GIT_BRANCH"),
            env!("QUIPCLIP_GIT_MODIFIED"),
        )
    }

    /// Reads the three values that `build.rs` sets. An empty commit gives `None`. An empty
    /// branch and the default branch give no branch.
    fn from_git(commit: &str, branch: &str, modified: &str) -> Option<Self> {
        if commit.is_empty() {
            return None;
        }
        Some(Self {
            commit: commit.to_owned(),
            branch: (!branch.is_empty() && branch != DEFAULT_BRANCH).then(|| branch.to_owned()),
            modified: modified == "true",
        })
    }

    /// The English text that follows the version in the macOS About panel, for example
    /// `a1b2c3d`, `feature/trim a1b2c3d`, or `a1b2c3d, modified`. The About tab of Settings
    /// shows the same parts in the language of the interface (ADR 011).
    #[cfg(any(target_os = "macos", test))]
    #[must_use]
    pub fn label(&self) -> String {
        let mut label = match &self.branch {
            Some(branch) => format!("{branch} {}", self.commit),
            None => self.commit.clone(),
        };
        if self.modified {
            label.push_str(", modified");
        }
        label
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_build_with_no_commit_has_no_source() {
        assert_eq!(BuildSource::from_git("", "", "false"), None);
        // The branch and the flag mean nothing without a commit.
        assert_eq!(BuildSource::from_git("", "feature", "true"), None);
    }

    #[test]
    fn the_default_branch_and_a_detached_head_name_no_branch() {
        for branch in ["main", ""] {
            assert_eq!(
                BuildSource::from_git("a1b2c3d", branch, "false"),
                Some(BuildSource {
                    commit: "a1b2c3d".to_owned(),
                    branch: None,
                    modified: false,
                }),
                "{branch:?}"
            );
        }
    }

    #[test]
    fn another_branch_is_named() {
        // Only the exact name of the default branch is left out.
        for branch in ["feature/trim", "Main", "main-fix"] {
            assert_eq!(
                BuildSource::from_git("a1b2c3d", branch, "false").and_then(|source| source.branch),
                Some(branch.to_owned()),
                "{branch:?}"
            );
        }
    }

    #[test]
    fn only_true_marks_the_sources_as_modified() {
        let modified = |flag: &str| {
            BuildSource::from_git("a1b2c3d", "", flag).is_some_and(|source| source.modified)
        };
        assert!(modified("true"));
        for flag in ["false", "", "1", "TRUE"] {
            assert!(!modified(flag), "{flag:?}");
        }
    }

    #[test]
    fn the_label_puts_the_branch_before_the_commit_and_the_mark_after_it() {
        let label = |branch: &str, modified: &str| {
            BuildSource::from_git("a1b2c3d", branch, modified)
                .expect("a commit gives a source")
                .label()
        };
        assert_eq!(label("main", "false"), "a1b2c3d");
        assert_eq!(label("feature/trim", "false"), "feature/trim a1b2c3d");
        assert_eq!(label("", "true"), "a1b2c3d, modified");
        assert_eq!(
            label("feature/trim", "true"),
            "feature/trim a1b2c3d, modified"
        );
    }

    #[test]
    fn a_source_serializes_with_camel_case_fields() {
        let source = BuildSource::from_git("a1b2c3d", "feature/trim", "true");
        assert_eq!(
            serde_json::to_value(source).expect("a source serializes"),
            serde_json::json!({ "commit": "a1b2c3d", "branch": "feature/trim", "modified": true })
        );
    }

    #[test]
    fn this_build_has_a_short_commit_when_it_has_one() {
        // The test build comes from the same build script. A checkout gives a hexadecimal
        // commit, and a build with no checkout gives no source.
        if let Some(source) = BuildSource::current() {
            assert!(source.commit.len() >= 4, "{source:?}");
            assert!(
                source.commit.chars().all(|c| c.is_ascii_hexdigit()),
                "{source:?}"
            );
        }
    }
}
