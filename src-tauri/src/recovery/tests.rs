//! Tests of the recovery on a temporary directory (ADR 073).

use super::*;
use crate::project::{self, Clip, Segment, Source};
use crate::time::{FrameCount, Pts, Rational, TickCount};
use serde_json::{json, Value};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

struct TestDirectory {
    path: PathBuf,
}

impl TestDirectory {
    fn new() -> Self {
        for _ in 0..1000 {
            let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "quipclip-recovery-test-{}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self { path },
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => panic!("could not create test directory: {error}"),
            }
        }
        panic!("could not create a unique test directory")
    }

    /// The directory `recovery` inside the test directory. The recovery makes it.
    fn recovery(&self) -> PathBuf {
        self.path.join("recovery")
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            // A test can leave a directory with no write permission.
            set_mode(&self.recovery(), 0o755);
        }
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
}

fn example_project() -> ProjectFile {
    ProjectFile {
        schema_version: 1,
        sources: vec![Source {
            id: "s1".to_owned(),
            path: "/clips/clip.mp4".to_owned(),
            rel_path: None,
            size: 100,
            mtime: 1_700_000_000,
            video_stream_index: 0,
            video_time_base: Rational::new(1, 90_000).unwrap(),
            video_start_pts: Some(Pts::new(0)),
            video_end_pts: Some(Pts::new(900_000)),
            video_duration_ticks: Some(TickCount::new(900_000).unwrap()),
            approximate_duration_seconds: Some(10.0),
            avg_frame_rate: Some(Rational::new(30, 1).unwrap()),
            r_frame_rate: Some(Rational::new(30, 1).unwrap()),
            reported_frame_count: Some(FrameCount::new(300).unwrap()),
            audio_stream_index: None,
            fingerprint: None,
        }],
        clips: vec![Clip {
            id: "c1".to_owned(),
            source_id: "s1".to_owned(),
        }],
        segments: vec![Segment {
            id: "g1".to_owned(),
            in_clip_id: "c1".to_owned(),
            in_pts: Pts::new(10),
            out_clip_id: "c1".to_owned(),
            out_pts: Pts::new(20),
            name: None,
        }],
    }
}

fn project_value() -> Value {
    serde_json::to_value(example_project()).unwrap()
}

/// A document that breaks a rule of a project file: the Out point is not after the In point.
fn refused_value() -> Value {
    let mut value = project_value();
    value["segments"][0]["outPts"] = json!("10");
    value
}

fn current_path(directory: &TestDirectory) -> PathBuf {
    directory.recovery().join(CURRENT_FILE_NAME)
}

fn offer_path(directory: &TestDirectory, id: &str) -> PathBuf {
    directory.recovery().join(file::offer_file_name(id))
}

/// The names of the files of the recovery directory, sorted, with no `owner.lock`.
fn file_names(directory: &TestDirectory) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory.recovery())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_str().unwrap().to_owned())
        .filter(|name| name != OWNER_LOCK_FILE_NAME)
        .collect();
    names.sort();
    names
}

fn offer_names(directory: &TestDirectory) -> Vec<String> {
    file_names(directory)
        .into_iter()
        .filter(|name| file::offer_id_of_file_name(name).is_some())
        .collect()
}

/// Writes a valid recovery file at `path`, as an earlier process would have.
fn write_recovery_file(path: &Path, project_path: Option<&str>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let bytes = file::encode(project_path, project_value(), PROJECT_FILE_MAX_BYTES).unwrap();
    fs::write(path, bytes).unwrap();
}

fn set_modified(path: &Path, milliseconds: u64) {
    let file = fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(UNIX_EPOCH + Duration::from_millis(milliseconds))
        .unwrap();
}

fn session_token(recovery: &Recovery) -> String {
    recovery.start().token
}

// The names of the directory.

#[test]
fn an_offer_id_has_exactly_sixteen_lowercase_hexadecimal_digits() {
    assert!(file::is_offer_id("0123456789abcdef"));
    for id in [
        "",
        "0123456789abcde",
        "0123456789abcdef0",
        "0123456789ABCDEF",
        "0123456789abcdeg",
        "../../etc/passwd",
        "0123456789abcde/",
        "0123456789abcd.f",
        " 123456789abcdef",
    ] {
        assert!(!file::is_offer_id(id), "{id:?}");
    }
    assert_eq!(
        file::offer_id_of_file_name("offer-0123456789abcdef.json"),
        Some("0123456789abcdef")
    );
    for name in [
        "offer-0123456789ABCDEF.json",
        "offer-0123456789abcdef.json.bak",
        "offer-0123456789abcdef",
        "xoffer-0123456789abcdef.json",
        "offer-.json",
    ] {
        assert_eq!(file::offer_id_of_file_name(name), None, "{name}");
    }
}

#[test]
fn a_temporary_file_of_a_write_has_one_exact_name_form() {
    for name in [
        ".current.json.tmp-1-0",
        ".current.json.tmp-4021-77",
        ".current.json.tmp-0-0",
        ".current.json.tmp-4294967295-18446744073709551615",
    ] {
        assert!(file::is_current_temporary_name(name), "{name}");
    }
    for name in [
        ".current.json.tmp-",
        ".current.json.tmp-12",
        ".current.json.tmp-12-",
        ".current.json.tmp--3",
        ".current.json.tmp-12-34-5",
        ".current.json.tmp-12-3x",
        ".current.json.tmp-+1-2",
        // Leading zeros and numbers out of range are not the form of the writer.
        ".current.json.tmp-01-00",
        ".current.json.tmp-01-0",
        ".current.json.tmp-1-00",
        ".current.json.tmp-1-01",
        ".current.json.tmp-4294967296-1",
        ".current.json.tmp-1-18446744073709551616",
        ".current.json.tmp- 1-2",
        "current.json.tmp-1-2",
        ".settings.json.tmp-1-2",
        ".offer-0123456789abcdef.json.tmp-1-2",
    ] {
        assert!(!file::is_current_temporary_name(name), "{name}");
    }
    // The form is the form of the writer: a write that a test stops leaves its name.
    let directory = TestDirectory::new();
    fs::create_dir_all(directory.recovery()).unwrap();
    let path = current_path(&directory);
    let mut seen = None;
    let written = crate::fsutil::write_bytes_atomically_unless(&path, b"{}", || {
        seen = fs::read_dir(directory.recovery())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_str().unwrap().to_owned())
            .next();
        true
    })
    .unwrap();
    assert!(!written);
    let seen = seen.expect("the temporary file exists before the rename");
    assert!(file::is_current_temporary_name(&seen), "{seen}");
    // The stopped write removed its temporary file and made no `current.json`.
    assert_eq!(fs::read_dir(directory.recovery()).unwrap().count(), 0);
}

#[test]
fn a_token_is_a_canonical_decimal_number() {
    assert_eq!(parse_token("1"), Some(1));
    assert_eq!(parse_token("18446744073709551615"), Some(u64::MAX));
    assert_eq!(parse_token("0"), Some(0));
    for text in [
        "",
        " 1",
        "1 ",
        "+1",
        "-1",
        "01",
        "00",
        "007",
        "1.0",
        "0x1",
        "18446744073709551616",
    ] {
        assert_eq!(parse_token(text), None, "{text:?}");
    }
}

// The session.

#[test]
fn each_page_load_gives_a_new_token_that_does_not_repeat() {
    let recovery = Recovery::new(None);
    let mut seen = std::collections::HashSet::new();
    let first = session_token(&recovery);
    assert_eq!(
        session_token(&recovery),
        first,
        "start_recovery reads the session"
    );
    seen.insert(first);
    for _ in 0..100 {
        recovery.start_session();
        assert!(seen.insert(session_token(&recovery)));
    }
}

#[test]
fn a_command_with_another_token_changes_nothing() {
    let directory = TestDirectory::new();
    let recovery = Recovery::new(Some(directory.recovery()));
    let old = session_token(&recovery);
    recovery.start_session();

    let answer = recovery.write(&old, None, project_value());
    assert_eq!(answer.status, RecoveryStatus::StaleSession);
    assert_eq!(answer.current, CurrentFile::NotKnown);
    assert!(
        !directory.recovery().exists(),
        "no step touched the directory"
    );

    for stale in ["", "abc", "0", &old] {
        assert_eq!(recovery.clear(stale).status, RecoveryStatus::StaleSession);
        assert_eq!(
            recovery.list_offers(stale).status,
            RecoveryStatus::StaleSession
        );
        assert_eq!(
            recovery.read_offer(stale, "0123456789abcdef").status,
            RecoveryStatus::StaleSession
        );
        assert_eq!(
            recovery.discard_offer(stale, "0123456789abcdef").status,
            RecoveryStatus::StaleSession
        );
        assert_eq!(
            recovery
                .finish_restore(stale, "0123456789abcdef", None)
                .status,
            RecoveryStatus::StaleSession
        );
    }
    assert!(!directory.recovery().exists());
}

// The owner.

#[test]
fn a_second_process_is_not_the_owner_until_the_first_ends() {
    let directory = TestDirectory::new();
    let first = Recovery::new(Some(directory.recovery()));
    let second = Recovery::new(Some(directory.recovery()));
    let first_token = session_token(&first);
    let second_token = session_token(&second);

    assert_eq!(
        first.write(&first_token, Some("/a.qcproj"), project_value()),
        ChangeAnswer::done(CurrentFile::Written)
    );
    let written = fs::read(current_path(&directory)).unwrap();

    // The second state on the same directory stands for a second process.
    let answer = second.write(&second_token, None, project_value());
    assert_eq!(
        answer,
        ChangeAnswer::closed(false, RecoveryStatus::NotOwner)
    );
    assert_eq!(answer.current, CurrentFile::NotKnown);
    assert_eq!(
        second.clear(&second_token),
        ChangeAnswer::closed(false, RecoveryStatus::NotOwner)
    );
    let list = second.list_offers(&second_token);
    assert!(!list.owner);
    assert!(!list.complete);
    assert_eq!(list.status, RecoveryStatus::NotOwner);
    assert_eq!(
        second
            .discard_offer(&second_token, "0123456789abcdef")
            .status,
        RecoveryStatus::NotOwner
    );
    assert_eq!(
        second.read_offer(&second_token, "0123456789abcdef").status,
        RecoveryStatus::NotOwner
    );
    assert_eq!(
        second
            .finish_restore(&second_token, "0123456789abcdef", None)
            .status,
        RecoveryStatus::NotOwner
    );
    // It changed nothing: the file of the owner is the same, and no offer was made.
    assert_eq!(fs::read(current_path(&directory)).unwrap(), written);
    assert_eq!(file_names(&directory), [CURRENT_FILE_NAME]);

    // The first process ends, and the system releases its lock. The second becomes the owner
    // with its next command, and makes the file of the first an offer.
    drop(first);
    let list = second.list_offers(&second_token);
    assert!(list.owner);
    assert!(list.complete);
    assert_eq!(list.offers.len(), 1);
    assert_eq!(list.offers[0].project_path.as_deref(), Some("/a.qcproj"));
    assert!(!current_path(&directory).exists());
    assert!(directory.recovery().join(OWNER_LOCK_FILE_NAME).is_file());
}

#[test]
fn the_owner_keeps_one_handle_and_never_removes_the_lock_file() {
    let directory = TestDirectory::new();
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    assert!(recovery.list_offers(&token).owner);
    assert!(recovery.lock_commands().owner.is_some());
    assert!(recovery.clear(&token).owner);
    assert!(directory.recovery().join(OWNER_LOCK_FILE_NAME).is_file());
}

#[test]
fn a_process_with_no_data_directory_is_not_the_owner() {
    let recovery = Recovery::new(None);
    let token = session_token(&recovery);
    assert_eq!(
        recovery.write(&token, None, project_value()),
        ChangeAnswer::closed(false, RecoveryStatus::NotOwner)
    );
    assert_eq!(
        recovery.list_offers(&token),
        ListAnswer::closed(false, RecoveryStatus::NotOwner)
    );
}

#[test]
fn a_data_directory_that_cannot_be_made_is_not_the_owner() {
    let directory = TestDirectory::new();
    // A file stands where the directory `recovery` would be.
    fs::write(directory.recovery(), b"").unwrap();
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    let answer = recovery.write(&token, None, project_value());
    assert!(!answer.owner);
    assert_eq!(answer.status, RecoveryStatus::NotOwner);
    assert_eq!(answer.current, CurrentFile::NotKnown);
    assert!(directory.recovery().is_file());
}

// The recovery file.

#[test]
fn a_write_makes_a_compact_recovery_file_with_no_rel_path() {
    let directory = TestDirectory::new();
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    let mut value = project_value();
    // The page does not send it, and the backend drops one that comes.
    value["sources"][0]["relPath"] = json!("clips/clip.mp4");

    let answer = recovery.write(&token, Some("/Cuts/Stream.qcproj"), value);
    assert_eq!(answer, ChangeAnswer::done(CurrentFile::Written));

    let bytes = fs::read(current_path(&directory)).unwrap();
    assert!(!bytes.contains(&b'\n'), "no indentation");
    let text = String::from_utf8(bytes.clone()).unwrap();
    assert!(
        text.starts_with(r#"{"recoveryVersion":1,"projectPath":"/Cuts/Stream.qcproj","project":{"#)
    );
    assert!(!text.contains("relPath"));
    let content = file::decode(&bytes).unwrap();
    assert_eq!(content.project, example_project());
    assert_eq!(content.project_path.as_deref(), Some("/Cuts/Stream.qcproj"));

    // A project with no path writes null.
    recovery.write(&token, None, project_value());
    let text = fs::read_to_string(current_path(&directory)).unwrap();
    assert!(text.contains(r#""projectPath":null"#));
    assert_eq!(file_names(&directory), [CURRENT_FILE_NAME]);
}

#[test]
fn a_read_refuses_another_version_and_each_unknown_shape() {
    let valid: Value = serde_json::from_slice(
        &file::encode(None, project_value(), PROJECT_FILE_MAX_BYTES).unwrap(),
    )
    .unwrap();
    let decode = |value: &Value| file::decode(&serde_json::to_vec(value).unwrap());
    assert!(decode(&valid).is_ok());

    for version in [json!(2), json!(0), json!("1"), json!(1.5), json!(null)] {
        let mut value = valid.clone();
        value["recoveryVersion"] = version.clone();
        assert!(
            matches!(decode(&value), Err(InvalidRecoveryFile::Version)),
            "{version}"
        );
    }
    let mut value = valid.clone();
    value.as_object_mut().unwrap().remove("recoveryVersion");
    assert!(matches!(decode(&value), Err(InvalidRecoveryFile::Version)));

    for project_path in [json!(5), json!(["a"]), json!({})] {
        let mut value = valid.clone();
        value["projectPath"] = project_path.clone();
        assert!(
            matches!(decode(&value), Err(InvalidRecoveryFile::Shape)),
            "{project_path}"
        );
    }
    let mut value = valid.clone();
    value.as_object_mut().unwrap().remove("projectPath");
    assert!(matches!(decode(&value), Err(InvalidRecoveryFile::Shape)));
    let mut value = valid.clone();
    value.as_object_mut().unwrap().remove("project");
    assert!(matches!(decode(&value), Err(InvalidRecoveryFile::Shape)));
    let mut value = valid.clone();
    value["extra"] = json!(true);
    assert!(matches!(decode(&value), Err(InvalidRecoveryFile::Shape)));
    let mut value = valid.clone();
    value["project"]["sources"][0]["relPath"] = json!("clip.mp4");
    assert!(matches!(decode(&value), Err(InvalidRecoveryFile::Shape)));
    assert!(matches!(
        file::decode(b"[1]"),
        Err(InvalidRecoveryFile::Shape)
    ));
    assert!(matches!(
        file::decode(b"{"),
        Err(InvalidRecoveryFile::Shape)
    ));

    // The document has the rules of a project file.
    let mut value = valid.clone();
    value["project"] = refused_value();
    assert!(matches!(
        decode(&value),
        Err(InvalidRecoveryFile::Document(_))
    ));
    let mut value = valid;
    value["project"]["schemaVersion"] = json!(2);
    assert!(matches!(
        decode(&value),
        Err(InvalidRecoveryFile::Document(
            project::ProjectFileError::FutureSchemaVersion { .. }
        ))
    ));
}

#[test]
fn a_read_accepts_the_limit_of_a_project_file_and_sixty_four_kibibytes() {
    let directory = TestDirectory::new();
    fs::create_dir_all(directory.recovery()).unwrap();
    let path = directory.recovery().join("probe.json");
    let bytes = file::encode(None, project_value(), PROJECT_FILE_MAX_BYTES).unwrap();
    let project_limit = 100;
    let limit = file::read_limit(project_limit);
    assert_eq!(limit, 100 + 64 * 1024);
    // White space after the object pads the file to exactly the limit, which a read accepts.
    let mut padded = bytes.clone();
    padded.resize(usize::try_from(limit).unwrap(), b' ');
    fs::write(&path, &padded).unwrap();
    assert!(file::read(&path, project_limit).is_ok());
    padded.push(b' ');
    fs::write(&path, &padded).unwrap();
    assert!(matches!(
        file::read(&path, project_limit),
        Err(ReadRecoveryError::Invalid(InvalidRecoveryFile::TooLarge))
    ));
}

#[test]
fn a_document_that_a_save_accepts_is_never_refused() {
    let directory = TestDirectory::new();
    let root = fs::canonicalize(&directory.path).unwrap();
    // A source next to the project file, so a save writes a `relPath` and a longer file.
    let mut document = example_project();
    document.sources[0].path = root.join("clip.mp4").to_str().unwrap().to_owned();
    let save_path = root.join("cut.qcproj");
    let saved = project::save_within(&save_path, &document, PROJECT_FILE_MAX_BYTES).unwrap();
    assert!(saved.sources[0].rel_path.is_some());
    let length = fs::metadata(&save_path).unwrap().len();
    // The smallest limit that the save accepts.
    assert!(project::save_within(&save_path, &document, length).is_ok());
    assert!(project::save_within(&save_path, &document, length - 1).is_err());

    let recovery = Recovery::with_project_limit(Some(directory.recovery()), length);
    let token = session_token(&recovery);
    let value = serde_json::to_value(&document).unwrap();
    assert_eq!(
        recovery.write(&token, Some(save_path.to_str().unwrap()), value.clone()),
        ChangeAnswer::done(CurrentFile::Written)
    );
    // The document of the save, with its `relPath`, is accepted too.
    let saved_value = serde_json::to_value(&saved).unwrap();
    assert_eq!(
        recovery.write(&token, None, saved_value).status,
        RecoveryStatus::Done
    );

    // The measure is that of a save: the readable form of the document with no `relPath`.
    let measure = crate::fsutil::to_pretty_json_line(&document).unwrap().len() as u64;
    let tight = Recovery::with_project_limit(Some(directory.path.join("tight")), measure - 1);
    let tight_token = session_token(&tight);
    let answer = tight.write(&tight_token, None, value);
    assert_eq!(answer.status, RecoveryStatus::Refused);
    assert_eq!(
        answer.error.unwrap().project.unwrap().code,
        crate::commands::project::ProjectCommandErrorCode::TooLarge
    );
}

#[test]
fn a_project_path_that_does_not_fit_the_read_limit_is_refused() {
    let directory = TestDirectory::new();
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    let path = "a".repeat(usize::try_from(file::READ_MARGIN_BYTES).unwrap() * 2);
    let measure = crate::fsutil::to_pretty_json_line(&example_project())
        .unwrap()
        .len() as u64;
    let small = Recovery::with_project_limit(Some(directory.path.join("small")), measure);
    let small_token = session_token(&small);
    assert_eq!(
        small
            .write(&small_token, Some(&path), project_value())
            .status,
        RecoveryStatus::Refused
    );
    // The same path fits beside the limit of a project file.
    assert_eq!(
        recovery.write(&token, Some(&path), project_value()).status,
        RecoveryStatus::Done
    );
}

// `current.json` of another session.

#[test]
fn a_current_file_of_another_token_becomes_an_offer_before_each_other_step() {
    let directory = TestDirectory::new();
    let recovery = Recovery::new(Some(directory.recovery()));
    let first = session_token(&recovery);
    recovery.write(&first, Some("/first.qcproj"), project_value());
    // The web view loads its page again.
    recovery.start_session();
    let second = session_token(&recovery);

    // The clear of the new page does not remove the work of the page before it.
    assert_eq!(
        recovery.clear(&second),
        ChangeAnswer::done(CurrentFile::Nothing)
    );
    assert!(!current_path(&directory).exists());
    let offers = offer_names(&directory);
    assert_eq!(offers.len(), 1);
    let id = file::offer_id_of_file_name(&offers[0]).unwrap().to_owned();
    let content = file::read(&offer_path(&directory, &id), PROJECT_FILE_MAX_BYTES)
        .unwrap()
        .0;
    assert_eq!(content.project_path.as_deref(), Some("/first.qcproj"));

    // A write of the new page makes a new `current.json` and keeps the offer.
    recovery.write(&second, Some("/second.qcproj"), project_value());
    assert!(current_path(&directory).is_file());
    assert_eq!(offer_names(&directory), offers);
    // A later command of the same page does not make its own file an offer.
    recovery.list_offers(&second);
    assert!(current_path(&directory).is_file());
    assert_eq!(offer_names(&directory), offers);
}

#[test]
fn a_current_file_that_an_earlier_process_left_becomes_an_offer_at_the_list() {
    let directory = TestDirectory::new();
    write_recovery_file(&current_path(&directory), Some("/left.qcproj"));
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);

    let list = recovery.list_offers(&token);
    assert_eq!(list.status, RecoveryStatus::Done);
    assert!(list.complete);
    assert_eq!(list.offers.len(), 1);
    assert!(file::is_offer_id(&list.offers[0].id));
    assert_eq!(list.offers[0].project_path.as_deref(), Some("/left.qcproj"));
    assert!(!current_path(&directory).exists());
}

#[test]
fn a_new_offer_never_takes_the_name_of_a_file_that_exists() {
    let directory = TestDirectory::new();
    fs::create_dir_all(directory.recovery()).unwrap();
    let mut ids = std::collections::HashSet::new();
    for _ in 0..200 {
        let path = new_offer_path(&directory.recovery()).unwrap();
        let name = path.file_name().unwrap().to_str().unwrap().to_owned();
        let id = file::offer_id_of_file_name(&name).unwrap().to_owned();
        assert!(!path.exists());
        fs::write(&path, b"").unwrap();
        assert!(ids.insert(id));
    }
}

#[cfg(unix)]
#[test]
fn a_rename_that_fails_changes_nothing_more_and_says_so() {
    let directory = TestDirectory::new();
    write_recovery_file(&current_path(&directory), None);
    let before = fs::read(current_path(&directory)).unwrap();
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    // Take the lock first, then forbid each change of the directory.
    assert!(recovery.lock_commands().owner.is_none());
    {
        let mut state = recovery.lock_commands();
        assert!(ensure_owner(&mut state, &directory.recovery()));
    }
    set_mode(&directory.recovery(), 0o555);
    if fs::write(directory.recovery().join("probe"), b"").is_ok() {
        // The test runs with a user that the mode does not stop, such as root.
        return;
    }

    let answer = recovery.write(&token, None, project_value());
    assert!(answer.owner);
    assert_eq!(answer.status, RecoveryStatus::Failed);
    assert_eq!(answer.current, CurrentFile::NotKnown);
    assert_eq!(answer.error.unwrap().code, RecoveryErrorCode::RenameFailed);

    let answer = recovery.write(&token, None, refused_value());
    assert_eq!(answer.status, RecoveryStatus::Failed);
    assert_eq!(answer.error.unwrap().code, RecoveryErrorCode::RenameFailed);

    let list = recovery.list_offers(&token);
    assert_eq!(list.status, RecoveryStatus::Failed);
    assert!(!list.complete);
    assert!(list.offers.is_empty());
    assert_eq!(list.error.unwrap().code, RecoveryErrorCode::RenameFailed);

    set_mode(&directory.recovery(), 0o755);
    assert_eq!(fs::read(current_path(&directory)).unwrap(), before);
    assert_eq!(file_names(&directory), [CURRENT_FILE_NAME]);
}

// The answers of the three commands that write or remove `current.json`.

#[test]
fn the_answers_say_what_the_current_file_holds() {
    let directory = TestDirectory::new();
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);

    // Nothing to remove yet.
    assert_eq!(
        recovery.clear(&token),
        ChangeAnswer::done(CurrentFile::Nothing)
    );
    assert_eq!(
        recovery.write(&token, None, project_value()),
        ChangeAnswer::done(CurrentFile::Written)
    );
    assert!(current_path(&directory).is_file());
    assert_eq!(
        recovery.clear(&token),
        ChangeAnswer::done(CurrentFile::Nothing)
    );
    assert!(!current_path(&directory).exists());
    assert!(offer_names(&directory).is_empty());
}

#[cfg(unix)]
#[test]
fn a_failed_write_or_removal_answers_not_known() {
    let directory = TestDirectory::new();
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    recovery.write(&token, None, project_value());
    set_mode(&directory.recovery(), 0o555);
    if fs::write(directory.recovery().join("probe"), b"").is_ok() {
        return;
    }

    let answer = recovery.write(&token, None, project_value());
    assert_eq!(answer.status, RecoveryStatus::Failed);
    assert_eq!(answer.current, CurrentFile::NotKnown);
    assert_eq!(answer.error.unwrap().code, RecoveryErrorCode::WriteFailed);

    let answer = recovery.clear(&token);
    assert_eq!(answer.status, RecoveryStatus::Failed);
    assert_eq!(answer.current, CurrentFile::NotKnown);
    let error = answer.error.unwrap();
    assert_eq!(error.code, RecoveryErrorCode::RemoveFailed);
    assert!(error.detail.is_some(), "the text of the system error");

    // A refused document whose removal fails answers not known, and says it was refused.
    let answer = recovery.write(&token, None, refused_value());
    assert_eq!(answer.status, RecoveryStatus::Refused);
    assert_eq!(answer.current, CurrentFile::NotKnown);
    assert_eq!(
        answer.error.unwrap().code,
        RecoveryErrorCode::DocumentRefused
    );

    set_mode(&directory.recovery(), 0o755);
    assert!(current_path(&directory).is_file());
    // The note of the writer stays, so a later clear removes the file.
    assert_eq!(
        recovery.clear(&token),
        ChangeAnswer::done(CurrentFile::Nothing)
    );
    assert!(!current_path(&directory).exists());
}

#[test]
fn a_refused_document_removes_the_file_of_the_session_and_says_so() {
    let directory = TestDirectory::new();
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    recovery.write(&token, None, project_value());

    let answer = recovery.write(&token, None, refused_value());
    assert!(answer.owner);
    assert_eq!(answer.status, RecoveryStatus::Refused);
    assert_eq!(answer.current, CurrentFile::Nothing);
    let error = answer.error.unwrap();
    assert_eq!(error.code, RecoveryErrorCode::DocumentRefused);
    let project = error.project.unwrap();
    assert_eq!(
        project.code,
        crate::commands::project::ProjectCommandErrorCode::InvalidProject
    );
    assert_eq!(project.field.as_deref(), Some("segments[0]"));
    assert!(!current_path(&directory).exists());

    // A document of the wrong shape is refused too, as the backend reads it itself.
    let answer = recovery.write(&token, None, json!({ "schemaVersion": 1 }));
    assert_eq!(answer.status, RecoveryStatus::Refused);
    assert_eq!(answer.current, CurrentFile::Nothing);
    let mut future = project_value();
    future["schemaVersion"] = json!(2);
    let answer = recovery.write(&token, None, future);
    assert_eq!(
        answer.error.unwrap().project.unwrap().code,
        crate::commands::project::ProjectCommandErrorCode::FutureSchemaVersion
    );
}

#[test]
fn the_answers_serialize_in_camel_case_with_no_empty_error() {
    let value = serde_json::to_value(ChangeAnswer::done(CurrentFile::NotKnown)).unwrap();
    assert_eq!(
        value,
        json!({ "owner": true, "status": "done", "current": "notKnown" })
    );
    let value =
        serde_json::to_value(ChangeAnswer::closed(false, RecoveryStatus::StaleSession)).unwrap();
    assert_eq!(value["status"], "staleSession");
    let value = serde_json::to_value(ChangeAnswer::execution_failed()).unwrap();
    assert_eq!(value["error"], json!({ "code": "commandExecutionFailed" }));
    let value = serde_json::to_value(OfferSummary {
        id: "0123456789abcdef".to_owned(),
        written_at_ms: 5,
        project_path: None,
    })
    .unwrap();
    assert_eq!(
        value,
        json!({ "id": "0123456789abcdef", "writtenAtMs": 5, "projectPath": null })
    );
    assert_eq!(
        serde_json::to_value(StartAnswer {
            token: "7".to_owned()
        })
        .unwrap(),
        json!({ "token": "7" })
    );
}

// The list.

#[test]
fn the_list_removes_temporary_files_and_invalid_offers_and_lists_the_newest_first() {
    let directory = TestDirectory::new();
    let recovery_directory = directory.recovery();
    fs::create_dir_all(&recovery_directory).unwrap();
    let old = "00000000000000a1";
    let new = "00000000000000b2";
    let same_time = "00000000000000a0";
    write_recovery_file(&offer_path(&directory, old), Some("/old.qcproj"));
    write_recovery_file(&offer_path(&directory, new), None);
    write_recovery_file(&offer_path(&directory, same_time), Some("/same.qcproj"));
    set_modified(&offer_path(&directory, old), 1_000_000);
    set_modified(&offer_path(&directory, new), 3_000_000);
    set_modified(&offer_path(&directory, same_time), 1_000_000);

    // Offers that are not valid recovery files.
    fs::write(offer_path(&directory, "00000000000000c3"), b"not json").unwrap();
    let mut future: Value = serde_json::from_slice(
        &file::encode(None, project_value(), PROJECT_FILE_MAX_BYTES).unwrap(),
    )
    .unwrap();
    future["recoveryVersion"] = json!(2);
    fs::write(
        offer_path(&directory, "00000000000000d4"),
        serde_json::to_vec(&future).unwrap(),
    )
    .unwrap();

    let temporary = [".current.json.tmp-12-34", ".current.json.tmp-1-0"];
    let unknown = [
        ".current.json.tmp-12-34x",
        ".current.json.tmp-12",
        ".current.json.tmp-01-00",
        ".current.json.tmp-4294967296-1",
        ".settings.json.tmp-1-2",
        "notes.txt",
        "offer-00000000000000E5.json",
        "offer-00000000000000f6.json.bak",
    ];
    for name in temporary.iter().chain(&unknown) {
        fs::write(recovery_directory.join(name), b"x").unwrap();
    }
    // A directory with the name of an offer is not a file of this record.
    fs::create_dir(offer_path(&directory, "00000000000000f7")).unwrap();

    let recovery = Recovery::new(Some(recovery_directory.clone()));
    let token = session_token(&recovery);
    let list = recovery.list_offers(&token);

    assert!(list.owner);
    assert_eq!(list.status, RecoveryStatus::Done);
    assert!(list.complete);
    assert_eq!(list.error, None);
    let ids: Vec<&str> = list.offers.iter().map(|offer| offer.id.as_str()).collect();
    assert_eq!(ids, [new, same_time, old]);
    assert_eq!(list.offers[0].written_at_ms, 3_000_000);
    assert_eq!(list.offers[0].project_path, None);
    assert_eq!(list.offers[2].written_at_ms, 1_000_000);
    assert_eq!(list.offers[2].project_path.as_deref(), Some("/old.qcproj"));

    let mut expected: Vec<String> = unknown.iter().map(|name| (*name).to_owned()).collect();
    expected.extend(
        [new, same_time, old, "00000000000000f7"]
            .iter()
            .map(|id| file::offer_file_name(id)),
    );
    expected.sort();
    assert_eq!(file_names(&directory), expected);
}

#[test]
fn the_list_removes_an_offer_larger_than_the_read_limit() {
    let directory = TestDirectory::new();
    let recovery = Recovery::with_project_limit(Some(directory.recovery()), 10);
    fs::create_dir_all(directory.recovery()).unwrap();
    let path = offer_path(&directory, "0000000000000001");
    fs::File::create(&path)
        .unwrap()
        .set_len(file::read_limit(10) + 1)
        .unwrap();
    let list = recovery.list_offers(&session_token(&recovery));
    assert!(list.complete);
    assert!(list.offers.is_empty());
    assert!(!path.exists());
}

#[cfg(unix)]
#[test]
fn an_offer_that_cannot_be_read_stays_and_the_list_is_not_complete() {
    let directory = TestDirectory::new();
    let readable = "0000000000000001";
    let unreadable = "0000000000000002";
    write_recovery_file(&offer_path(&directory, readable), None);
    write_recovery_file(&offer_path(&directory, unreadable), None);
    set_mode(&offer_path(&directory, unreadable), 0o000);
    if fs::read(offer_path(&directory, unreadable)).is_ok() {
        return;
    }
    let recovery = Recovery::new(Some(directory.recovery()));
    let list = recovery.list_offers(&session_token(&recovery));
    set_mode(&offer_path(&directory, unreadable), 0o644);

    assert!(list.owner);
    assert!(!list.complete);
    assert_eq!(list.status, RecoveryStatus::Failed);
    assert_eq!(list.error.unwrap().code, RecoveryErrorCode::ReadFailed);
    assert_eq!(list.offers.len(), 1);
    assert_eq!(list.offers[0].id, readable);
    assert!(offer_path(&directory, unreadable).is_file());
}

// One offer.

#[test]
fn a_read_answers_the_document_and_one_candidate_for_each_source() {
    let directory = TestDirectory::new();
    let id = "0123456789abcdef";
    let mut document = example_project();
    let mut second = document.sources[0].clone();
    second.id = "s2".to_owned();
    second.path = "/clips/other.mp4".to_owned();
    document.sources.push(second);
    fs::create_dir_all(directory.recovery()).unwrap();
    fs::write(
        offer_path(&directory, id),
        file::encode(
            Some("/Cuts/Stream.qcproj"),
            serde_json::to_value(&document).unwrap(),
            PROJECT_FILE_MAX_BYTES,
        )
        .unwrap(),
    )
    .unwrap();
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);

    let answer = recovery.read_offer(&token, id);
    assert_eq!(answer.status, RecoveryStatus::Done);
    let offer = answer.offer.unwrap();
    assert_eq!(offer.project_path.as_deref(), Some("/Cuts/Stream.qcproj"));
    assert_eq!(offer.project, document);
    assert_eq!(
        offer.candidates,
        vec![
            vec!["/clips/clip.mp4".to_owned()],
            vec!["/clips/other.mp4".to_owned()]
        ]
    );
    let value = serde_json::to_value(recovery.read_offer(&token, id).offer.unwrap()).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 3);
    assert!(value["projectPath"].is_string());
    // The read does not remove the offer.
    assert!(offer_path(&directory, id).is_file());

    let missing = recovery.read_offer(&token, "00000000000000ff");
    assert_eq!(missing.status, RecoveryStatus::Failed);
    assert_eq!(
        missing.error.unwrap().code,
        RecoveryErrorCode::OfferNotFound
    );

    let mut future: Value =
        serde_json::from_slice(&fs::read(offer_path(&directory, id)).unwrap()).unwrap();
    future["recoveryVersion"] = json!(2);
    fs::write(
        offer_path(&directory, id),
        serde_json::to_vec(&future).unwrap(),
    )
    .unwrap();
    let answer = recovery.read_offer(&token, id);
    assert_eq!(
        answer.error.unwrap().code,
        RecoveryErrorCode::UnsupportedRecoveryVersion
    );

    future["recoveryVersion"] = json!(1);
    future["project"] = refused_value();
    fs::write(
        offer_path(&directory, id),
        serde_json::to_vec(&future).unwrap(),
    )
    .unwrap();
    let error = recovery.read_offer(&token, id).error.unwrap();
    assert_eq!(error.code, RecoveryErrorCode::InvalidRecoveryFile);
    assert!(error.project.is_some());
}

#[test]
fn an_id_from_the_page_is_checked_before_a_path_is_made() {
    let directory = TestDirectory::new();
    fs::create_dir_all(directory.recovery()).unwrap();
    // A file that a path made from a bad id could name.
    let outside = directory.path.join("offer-x.json");
    write_recovery_file(&outside, None);
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    for id in [
        "../offer-x",
        "0123456789ABCDEF",
        "",
        "0123456789abcdef/../../x",
    ] {
        let read = recovery.read_offer(&token, id);
        assert_eq!(read.status, RecoveryStatus::Failed, "{id}");
        assert_eq!(read.error.unwrap().code, RecoveryErrorCode::InvalidOfferId);
        let discard = recovery.discard_offer(&token, id);
        assert_eq!(
            discard.error.unwrap().code,
            RecoveryErrorCode::InvalidOfferId
        );
        let finish = recovery.finish_restore(
            &token,
            id,
            Some(json!({ "projectPath": null, "project": project_value() })),
        );
        assert_eq!(finish.status, RecoveryStatus::Failed);
        assert_eq!(finish.current, CurrentFile::NotKnown);
        assert_eq!(
            finish.error.unwrap().code,
            RecoveryErrorCode::InvalidOfferId
        );
    }
    assert!(outside.is_file());
    assert!(!current_path(&directory).exists());
}

#[test]
fn a_discard_removes_one_offer() {
    let directory = TestDirectory::new();
    write_recovery_file(&offer_path(&directory, "0000000000000001"), None);
    write_recovery_file(&offer_path(&directory, "0000000000000002"), None);
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);

    let answer = recovery.discard_offer(&token, "0000000000000001");
    assert_eq!(answer, DiscardAnswer::closed(true, RecoveryStatus::Done));
    assert_eq!(
        offer_names(&directory),
        [file::offer_file_name("0000000000000002")]
    );
    // An offer that is already gone is a success.
    assert_eq!(
        recovery.discard_offer(&token, "0000000000000001").status,
        RecoveryStatus::Done
    );
}

// The end of a restore.

#[test]
fn a_finished_restore_writes_the_state_and_then_removes_the_offer() {
    let directory = TestDirectory::new();
    let id = "0123456789abcdef";
    write_recovery_file(&offer_path(&directory, id), Some("/old.qcproj"));
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);

    let answer = recovery.finish_restore(
        &token,
        id,
        Some(json!({ "projectPath": "/old.qcproj", "project": project_value() })),
    );
    assert_eq!(answer, ChangeAnswer::done(CurrentFile::Written));
    assert!(!offer_path(&directory, id).exists());
    let content = file::read(&current_path(&directory), PROJECT_FILE_MAX_BYTES)
        .unwrap()
        .0;
    assert_eq!(content.project_path.as_deref(), Some("/old.qcproj"));
    // The file belongs to the session: a clear removes it.
    assert_eq!(
        recovery.clear(&token),
        ChangeAnswer::done(CurrentFile::Nothing)
    );
    assert!(file_names(&directory).is_empty());
}

#[test]
fn a_finished_restore_with_nothing_removes_the_file_and_the_offer() {
    let directory = TestDirectory::new();
    let id = "0123456789abcdef";
    write_recovery_file(&offer_path(&directory, id), None);
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    recovery.write(&token, None, project_value());

    let answer = recovery.finish_restore(&token, id, None);
    assert_eq!(answer, ChangeAnswer::done(CurrentFile::Nothing));
    assert!(file_names(&directory).is_empty());
}

#[test]
fn a_refused_document_in_a_finished_restore_removes_the_file_and_keeps_the_offer() {
    let directory = TestDirectory::new();
    let id = "0123456789abcdef";
    write_recovery_file(&offer_path(&directory, id), None);
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    recovery.write(&token, None, project_value());

    let answer = recovery.finish_restore(
        &token,
        id,
        Some(json!({ "projectPath": null, "project": refused_value() })),
    );
    assert_eq!(answer.status, RecoveryStatus::Refused);
    assert_eq!(answer.current, CurrentFile::Nothing);
    assert_eq!(
        answer.error.unwrap().code,
        RecoveryErrorCode::DocumentRefused
    );
    assert!(!current_path(&directory).exists());
    assert!(offer_path(&directory, id).is_file());
}

#[cfg(unix)]
#[test]
fn a_failed_write_in_a_finished_restore_keeps_the_offer() {
    let directory = TestDirectory::new();
    let id = "0123456789abcdef";
    write_recovery_file(&offer_path(&directory, id), None);
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    assert!(recovery.list_offers(&token).owner);
    set_mode(&directory.recovery(), 0o555);
    if fs::write(directory.recovery().join("probe"), b"").is_ok() {
        return;
    }
    let answer = recovery.finish_restore(
        &token,
        id,
        Some(json!({ "projectPath": null, "project": project_value() })),
    );
    set_mode(&directory.recovery(), 0o755);
    assert_eq!(answer.status, RecoveryStatus::Failed);
    assert_eq!(answer.current, CurrentFile::NotKnown);
    assert_eq!(answer.error.unwrap().code, RecoveryErrorCode::WriteFailed);
    assert!(offer_path(&directory, id).is_file());
    assert!(!current_path(&directory).exists());
}

// The end of the recovery at a confirmed quit.

#[test]
fn the_end_removes_the_file_only_for_the_token_that_wrote_it() {
    let directory = TestDirectory::new();
    let recovery = Arc::new(Recovery::new(Some(directory.recovery())));
    let token = session_token(&recovery);
    recovery.write(&token, None, project_value());

    // No token, or another token: nothing ends, and nothing is removed.
    assert_eq!(recovery.end(None), EndOutcome::NotTheSession);
    assert_eq!(recovery.end(Some("999")), EndOutcome::NotTheSession);
    assert_eq!(recovery.end(Some("not a token")), EndOutcome::NotTheSession);
    assert!(current_path(&directory).is_file());
    assert_eq!(
        recovery.clear(&token).status,
        RecoveryStatus::Done,
        "the recovery did not end"
    );
    recovery.write(&token, None, project_value());

    assert_eq!(recovery.end(Some(&token)), EndOutcome::Removed);
    assert!(!current_path(&directory).exists());

    // Each later command changes nothing.
    let answer = recovery.write(&token, None, project_value());
    assert_eq!(answer.status, RecoveryStatus::StaleSession);
    assert!(!current_path(&directory).exists());
    assert_eq!(
        recovery.list_offers(&token).status,
        RecoveryStatus::StaleSession
    );
}

#[test]
fn the_end_of_a_new_page_does_not_remove_the_work_of_the_page_before_it() {
    let directory = TestDirectory::new();
    let recovery = Arc::new(Recovery::new(Some(directory.recovery())));
    let first = session_token(&recovery);
    recovery.write(&first, None, project_value());
    recovery.start_session();
    let second = session_token(&recovery);

    // The old token is not the session any more.
    assert_eq!(recovery.end(Some(&first)), EndOutcome::NotTheSession);
    // The token of the session did not write the file.
    assert_eq!(recovery.end(Some(&second)), EndOutcome::NothingToRemove);
    assert!(current_path(&directory).is_file());
}

#[test]
fn a_write_that_reaches_its_rename_after_the_end_does_not_name_the_file() {
    let directory = TestDirectory::new();
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    let bytes = file::encode(None, project_value(), PROJECT_FILE_MAX_BYTES).unwrap();

    // The command passed its first checks before the end.
    let mut entered = recovery.enter(&token).unwrap();
    recovery.ended.store(true, Ordering::SeqCst);
    let answer = recovery.write_current(&mut entered, &bytes);
    assert_eq!(answer.status, RecoveryStatus::StaleSession);
    assert_eq!(entered.state.writer, None);
    drop(entered);
    assert!(
        file_names(&directory).is_empty(),
        "no file and no temporary file"
    );
}

#[test]
fn the_end_waits_for_a_command_that_runs_for_its_budget_at_most() {
    let directory = TestDirectory::new();
    let recovery = Arc::new(Recovery::new(Some(directory.recovery())));
    let token = session_token(&recovery);
    recovery.write(&token, None, project_value());

    // A command that holds the lock for longer than the budget.
    let (held_sender, held) = std::sync::mpsc::channel();
    let (release, release_receiver) = std::sync::mpsc::channel::<()>();
    let holder = {
        let recovery = Arc::clone(&recovery);
        std::thread::spawn(move || {
            let _guard = recovery.lock_commands();
            held_sender.send(()).unwrap();
            let _ = release_receiver.recv();
        })
    };
    held.recv().unwrap();

    let started = Instant::now();
    // The worker sees the deadline before the lock, and the caller stops to wait at the same
    // deadline, so either answer can come first.
    let outcome = recovery.end(Some(&token));
    assert!(
        matches!(outcome, EndOutcome::CommandStillRan | EndOutcome::TimedOut),
        "{outcome:?}"
    );
    let elapsed = started.elapsed();
    assert!(elapsed >= END_BUDGET, "took {elapsed:?}");
    assert!(
        elapsed < END_BUDGET + Duration::from_millis(500),
        "took {elapsed:?}"
    );
    release.send(()).unwrap();
    holder.join().unwrap();

    // The recovery ended at once, also with no removal: a later command changes nothing.
    assert!(current_path(&directory).is_file());
    assert_eq!(recovery.clear(&token).status, RecoveryStatus::StaleSession);
    assert!(current_path(&directory).is_file());
}

#[test]
fn the_end_removes_the_file_when_the_command_that_runs_ends_in_time() {
    let directory = TestDirectory::new();
    let recovery = Arc::new(Recovery::new(Some(directory.recovery())));
    let token = session_token(&recovery);
    recovery.write(&token, None, project_value());

    let (held_sender, held) = std::sync::mpsc::channel();
    let holder = {
        let recovery = Arc::clone(&recovery);
        std::thread::spawn(move || {
            let _guard = recovery.lock_commands();
            held_sender.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(100));
        })
    };
    held.recv().unwrap();
    assert_eq!(
        recovery.end_within(Some(&token), Duration::from_secs(1)),
        EndOutcome::Removed
    );
    holder.join().unwrap();
    assert!(!current_path(&directory).exists());
}

#[test]
fn the_end_tries_a_refused_removal_again_until_its_budget_ends() {
    static ATTEMPTS: AtomicU64 = AtomicU64::new(0);
    fn refused_remove(_: &Path) -> io::Result<()> {
        ATTEMPTS.fetch_add(1, Ordering::SeqCst);
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    }
    let directory = TestDirectory::new();
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    recovery.write(&token, None, project_value());

    // The work of the worker, on this thread, so no step runs after the assertions.
    let budget = Duration::from_millis(100);
    let outcome = recovery.remove_at_end(
        parse_token(&token).unwrap(),
        Instant::now() + budget,
        refused_remove,
    );
    assert_eq!(outcome, EndOutcome::RemoveFailed);
    let attempts = ATTEMPTS.load(Ordering::SeqCst);
    // The first try, and more tries while the budget lasts. The pause between two tries is
    // `END_POLL_INTERVAL` at most, so a budget of 100 ms has room for many.
    assert!(attempts >= 2, "{attempts} attempts");
    // The note of the writer stays, as the file was not removed.
    assert_eq!(
        recovery.lock_commands().writer,
        Some(parse_token(&token).unwrap())
    );
}

#[test]
fn a_removal_that_blocks_does_not_hold_the_end_past_its_budget() {
    fn blocking_remove(_: &Path) -> io::Result<()> {
        std::thread::sleep(Duration::from_secs(3));
        Ok(())
    }
    let directory = TestDirectory::new();
    let recovery = Arc::new(Recovery::new(Some(directory.recovery())));
    let token = session_token(&recovery);
    recovery.write(&token, None, project_value());

    let started = Instant::now();
    let outcome = recovery.end_with(Some(&token), END_BUDGET, blocking_remove);
    let elapsed = started.elapsed();
    assert_eq!(outcome, EndOutcome::TimedOut);
    assert!(elapsed >= END_BUDGET, "took {elapsed:?}");
    assert!(
        elapsed < END_BUDGET + Duration::from_millis(500),
        "took {elapsed:?}"
    );
    // The recovery ended at once on the thread of the caller.
    assert!(recovery.ended.load(Ordering::SeqCst));
}

#[test]
fn the_end_tests_the_deadline_before_each_removal_and_before_the_lock() {
    fn refused_remove(_: &Path) -> io::Result<()> {
        panic!("no removal starts after the deadline");
    }
    let past = Instant::now();
    std::thread::sleep(Duration::from_millis(2));
    assert!(!remove_until(Path::new("unused"), past, refused_remove));

    let recovery = Recovery::new(None);
    assert!(recovery.lock_commands_until(past).is_none());
    assert_eq!(
        recovery.remove_at_end(1, past, refused_remove),
        EndOutcome::CommandStillRan
    );
}

#[test]
fn a_token_with_a_leading_zero_is_a_stale_token() {
    let directory = TestDirectory::new();
    let recovery = Arc::new(Recovery::new(Some(directory.recovery())));
    let token = session_token(&recovery);
    assert_eq!(token, "1");
    let answer = recovery.write("01", None, project_value());
    assert_eq!(answer.status, RecoveryStatus::StaleSession);
    assert!(!directory.recovery().exists());
    recovery.write(&token, None, project_value());
    assert_eq!(recovery.end(Some("01")), EndOutcome::NotTheSession);
    assert!(current_path(&directory).is_file());
}

#[test]
fn a_write_of_the_old_page_that_ends_after_the_page_load_is_noted_with_the_old_token() {
    let directory = TestDirectory::new();
    let recovery = Recovery::new(Some(directory.recovery()));
    let old = session_token(&recovery);
    let bytes = file::encode(Some("/old.qcproj"), project_value(), PROJECT_FILE_MAX_BYTES).unwrap();

    // The write entered with the token of the old page. The page loads again before the write
    // ends: the hook does not wait for the command.
    let mut entered = recovery.enter(&old).unwrap();
    recovery.start_session();
    let new = session_token(&recovery);
    assert_ne!(new, old);
    let answer = recovery.write_current(&mut entered, &bytes);
    assert_eq!(answer, ChangeAnswer::done(CurrentFile::Written));
    assert_eq!(entered.state.writer, Some(parse_token(&old).unwrap()));
    drop(entered);

    // The first command of the new page makes the file an offer.
    assert_eq!(
        recovery.clear(&new),
        ChangeAnswer::done(CurrentFile::Nothing)
    );
    assert!(!current_path(&directory).exists());
    let list = recovery.list_offers(&new);
    assert_eq!(list.offers.len(), 1);
    assert_eq!(list.offers[0].project_path.as_deref(), Some("/old.qcproj"));
}

#[test]
fn a_finished_restore_whose_offer_removal_fails_answers_failed_with_the_written_file() {
    let directory = TestDirectory::new();
    let id = "0123456789abcdef";
    // A directory with the name of the offer, with a file in it: its removal as a file fails.
    fs::create_dir_all(offer_path(&directory, id)).unwrap();
    fs::write(offer_path(&directory, id).join("inside"), b"x").unwrap();
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);

    let answer = recovery.finish_restore(
        &token,
        id,
        Some(json!({ "projectPath": null, "project": project_value() })),
    );
    assert!(answer.owner);
    assert_eq!(answer.status, RecoveryStatus::Failed);
    assert_eq!(answer.current, CurrentFile::Written);
    assert_eq!(answer.error.unwrap().code, RecoveryErrorCode::RemoveFailed);
    assert!(offer_path(&directory, id).exists());
    assert!(current_path(&directory).is_file());
}

#[test]
fn a_restore_state_of_a_wrong_shape_is_refused_and_keeps_the_offer() {
    let directory = TestDirectory::new();
    let id = "0123456789abcdef";
    write_recovery_file(&offer_path(&directory, id), None);
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    for state in [
        json!({ "projectPath": null }),
        json!({ "project": project_value() }),
        json!({ "projectPath": 5, "project": project_value() }),
        json!({ "projectPath": null, "project": project_value(), "extra": 1 }),
        // Only an object is a state: serde would read a sequence into the two fields.
        json!([null, project_value()]),
        json!([project_value()]),
        json!([]),
        json!("nothing"),
        json!(5),
        json!(false),
        json!(true),
    ] {
        recovery.write(&token, None, project_value());
        let answer = recovery.finish_restore(&token, id, Some(state.clone()));
        assert_eq!(answer.status, RecoveryStatus::Refused, "{state}");
        assert_eq!(answer.current, CurrentFile::Nothing, "{state}");
        let error = answer.error.unwrap();
        assert_eq!(error.code, RecoveryErrorCode::DocumentRefused);
        assert_eq!(
            error.project.unwrap().code,
            crate::commands::project::ProjectCommandErrorCode::InvalidJson
        );
        assert!(offer_path(&directory, id).is_file(), "{state}");
        assert!(!current_path(&directory).exists(), "{state}");
    }
}

#[test]
fn the_offers_are_ordered_by_the_full_time_of_the_file_system() {
    let directory = TestDirectory::new();
    // The same millisecond. The id of the newer file is the larger one, so an order by the
    // milliseconds and then the id would put it last.
    let older = "0000000000000001";
    let newer = "0000000000000002";
    write_recovery_file(&offer_path(&directory, older), None);
    write_recovery_file(&offer_path(&directory, newer), None);
    let base = UNIX_EPOCH + Duration::from_millis(1_000_000);
    for (id, offset) in [(older, 100_000), (newer, 900_000)] {
        let file = fs::OpenOptions::new()
            .write(true)
            .open(offer_path(&directory, id))
            .unwrap();
        file.set_modified(base + Duration::from_nanos(offset))
            .unwrap();
    }
    let read_time = |id| {
        fs::metadata(offer_path(&directory, id))
            .unwrap()
            .modified()
            .unwrap()
    };
    if read_time(older) == read_time(newer) {
        // The file system keeps no time finer than the millisecond.
        return;
    }
    let recovery = Recovery::new(Some(directory.recovery()));
    let list = recovery.list_offers(&session_token(&recovery));
    let ids: Vec<&str> = list.offers.iter().map(|offer| offer.id.as_str()).collect();
    assert_eq!(ids, [newer, older]);
    assert_eq!(list.offers[0].written_at_ms, list.offers[1].written_at_ms);
}

#[cfg(unix)]
#[test]
fn an_invalid_offer_whose_removal_fails_makes_the_list_not_complete() {
    let directory = TestDirectory::new();
    let valid = "0000000000000001";
    let invalid = "0000000000000002";
    write_recovery_file(&offer_path(&directory, valid), None);
    let recovery = Recovery::new(Some(directory.recovery()));
    let token = session_token(&recovery);
    // The process is the owner before the directory refuses each change.
    assert!(recovery.list_offers(&token).complete);
    fs::write(offer_path(&directory, invalid), b"not json").unwrap();
    set_mode(&directory.recovery(), 0o555);
    if fs::write(directory.recovery().join("probe"), b"").is_ok() {
        return;
    }
    let list = recovery.list_offers(&token);
    set_mode(&directory.recovery(), 0o755);

    assert!(list.owner);
    assert_eq!(list.status, RecoveryStatus::Failed);
    assert!(!list.complete);
    assert_eq!(list.error.unwrap().code, RecoveryErrorCode::RemoveFailed);
    assert_eq!(list.offers.len(), 1);
    assert_eq!(list.offers[0].id, valid);
    assert!(offer_path(&directory, invalid).is_file());
}
