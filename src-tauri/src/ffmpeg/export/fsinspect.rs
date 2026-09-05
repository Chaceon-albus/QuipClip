//! The one production implementation of the filesystem inspection [`super::plan::build_plan`]
//! takes as an argument.
//!
//! `build_plan` is pure: every fact it needs about a real path reaches it through an injected
//! `impl Fn(&Path) -> PathFacts`, so its own tests drive the whole ADR 014 preflight from a fixed
//! table and never touch disk. [`inspect_path`] is the implementation the renderer will pass once
//! the unit that orchestrates an export lands -- nothing calls it yet. It is a plain function
//! rather than a closure, and it coerces to that `impl Fn` bound at the call site. It is intended
//! to be the only code in the export pipeline that reads the filesystem on the plan's behalf, and
//! the only place a [`PathIdentity`] is ever produced.
//!
//! **Why an identity, and not a path comparison.** The preflight refuses an export whose
//! destination is its own source, because the renderer finishes by renaming its temporary output
//! over the destination ([`super::output::PendingOutput::commit`]): a destination that resolves to
//! the source means the user's input video is replaced by a partial re-encode of itself, with no
//! error reported and nothing to recover from. Comparing the two paths catches only the easy case.
//! A hard link, a symlink, a `..` component, and a case-insensitive volume (APFS and NTFS both
//! default to one) each spell one file two different ways, and every one of them survives that
//! comparison. A `.` component does not, and this list deliberately leaves it out: `build_plan`
//! compares two `&Path` values, `Path`'s `PartialEq` compares `Components`, and `Components` drops
//! every `CurDir`, so `dir/./movie.mp4` already compares equal to `dir/movie.mp4`. Comparing what
//! the filesystem itself calls the file -- a device and inode pair on Unix, a volume serial number
//! and file index on Windows -- catches all four of the spellings that do survive.
//! [`PathFacts::File`] cannot be constructed without an identity precisely so this step cannot be
//! skipped; see the [`PathFacts`] doc comment for the failure that shaped that type.
//!
//! **The failure rule: an unreadable identity is not a file.** A path that exists but whose
//! identity cannot be read reports [`PathFacts::Other`], never [`PathFacts::File`]. `build_plan`
//! rejects `Other` in the destination position with `OutputPathInvalid` and in the source position
//! with `SourceNotFile`, so the export stops before anything is spawned. That is deliberate, and
//! it is the whole reason this module exists rather than a two-line `fs::metadata` call at the
//! call site: reporting a file with no identity would make "a different file" and "I could not
//! tell" compare the same, and the one case the check exists to catch -- the destination that *is*
//! the source -- is exactly the case that would then pass. Losing one export to a filesystem that
//! will not answer is strictly better than overwriting the user's source video.
//!
//! The same rule decides what a failed `stat` means, and there the danger runs the other way: an
//! error that is not "not found" reports `Other`, never [`PathFacts::Absent`]. `build_plan`
//! *accepts* an absent destination and skips the identity comparison for it, so an unreadable path
//! reported as `Absent` would be indistinguishable from an empty one and would walk straight past
//! the check. Both rules live in [`classify`], which is a separate function so that both can be
//! tested on every platform; see its doc comment.
//!
//! **Symlinks are followed.** Identity comes from [`fs::metadata`], never `fs::symlink_metadata`,
//! and the Windows handle is opened without `FILE_FLAG_OPEN_REPARSE_POINT`, so both arms resolve a
//! link to its target. The [`PathFacts`] contract requires this: a symlinked destination that
//! points at the source must report the *source's* identity, or it defeats the same-file check the
//! same way a missing identity would. The destination is the case that matters, since the user
//! picks it fresh on every export, while `commands::media::import_media` has already canonicalized
//! the source before any export can plan it.

use super::{PathFacts, PathIdentity};
use std::fs;
use std::io;
use std::path::Path;

/// Report what the filesystem says about `path`, as the [`PathFacts`] value `build_plan` consumes.
///
/// Pass this to [`super::plan::build_plan`] as its `inspect` argument. It is called three times
/// for one plan -- for the source, for the destination's parent directory, and for the destination
/// itself -- so it must stay cheap: one `stat`, plus one open-and-close on Windows for a path that
/// turns out to be a regular file. Only a regular file needs an identity, which is why the lookup
/// is guarded here rather than left to [`classify`]: a directory would otherwise pay for a handle
/// nothing reads.
///
/// [`classify`] holds the mapping itself, and its doc comment gives the full table.
#[must_use]
pub fn inspect_path(path: &Path) -> PathFacts {
    // fs::metadata follows symlinks; fs::symlink_metadata would not, and the PathFacts contract
    // requires the target's identity, not the link's.
    let metadata = fs::metadata(path);
    let identity = match &metadata {
        Ok(metadata) if metadata.is_file() => read_identity(path, metadata),
        Ok(_) | Err(_) => None,
    };
    classify(metadata.as_ref().map_err(io::Error::kind), identity)
}

/// Turn one `stat` result and one identity lookup into the fact `build_plan` reads.
///
/// The mapping:
///
/// - the `stat` failed with [`io::ErrorKind::NotFound`] -- [`PathFacts::Absent`];
/// - the `stat` failed any other way -- [`PathFacts::Other`]. Permission denied, a loop of
///   symlinks, or a path component that is not a directory all land here rather than in `Absent`,
///   for the reason this module's doc comment gives: `build_plan` accepts an absent destination
///   and skips the same-file comparison for it, so "I could not read this path" must never be
///   spelled the same way as "there is nothing here";
/// - the path is a directory -- [`PathFacts::Directory`], whatever `identity` holds;
/// - the path is a regular file and `identity` is `Some` -- [`PathFacts::File`];
/// - the path is a regular file and `identity` is `None` -- [`PathFacts::Other`], the failure rule
///   this module's doc comment states;
/// - the path is anything else, such as a device node, a socket, or a named pipe --
///   [`PathFacts::Other`].
///
/// This is a separate function from [`inspect_path`] only so that both fail-closed rules can be
/// tested everywhere. Neither is reachable from a test that has to go through a real filesystem on
/// both platforms at once: an identity lookup cannot fail on Unix, because `dev` and `ino` are
/// already in the `stat`, and denying a `stat` needs a Unix permission bit. Taking the two inputs
/// as plain values lets a test state "a real file, and no identity" or "a `stat` that failed with
/// `PermissionDenied`" directly, on any host, with no privileged setup.
///
/// One caveat about `NotFound` on Windows: it is wider there than `ENOENT` is on Unix. The
/// standard library also maps `ERROR_BAD_NETPATH`, `ERROR_BAD_NET_NAME`, and `ERROR_DEV_NOT_EXIST`
/// onto it, so an unreachable UNC destination arrives here as `Absent` rather than `Other`. That
/// opens no hole today, because `build_plan` inspects the destination's *parent directory* first,
/// and an unreachable share cannot answer `Directory` there, so the plan stops with
/// `OutputDirectoryMissing` before the destination is compared to anything. It is still why this
/// arm is written as "the `stat` said not found" and not as "the path does not exist".
fn classify(
    metadata: Result<&fs::Metadata, io::ErrorKind>,
    identity: Option<PathIdentity>,
) -> PathFacts {
    let metadata = match metadata {
        Ok(metadata) => metadata,
        Err(io::ErrorKind::NotFound) => return PathFacts::Absent,
        Err(_) => return PathFacts::Other,
    };
    if metadata.is_dir() {
        return PathFacts::Directory;
    }
    if !metadata.is_file() {
        return PathFacts::Other;
    }
    match identity {
        Some(identity) => PathFacts::File { identity },
        None => PathFacts::Other,
    }
}

/// Read the Unix file identity of `path` from the `stat` [`inspect_path`] already took.
///
/// `dev` names the filesystem and `ino` names the file within it, and the pair is what "the same
/// file" means on Unix: two hard links share it, and a resolved symlink reports its target's pair
/// because [`fs::metadata`] followed the link before this ran. Each half occupies its own 64 bits
/// of the [`PathIdentity`] value -- `dev` in bits 64 to 127, `ino` in bits 0 to 63 -- so the
/// packing is injective and no two distinct pairs can produce one `u128`. A collision there would
/// report two different files as one and refuse a legitimate export.
///
/// This arm never fails: the numbers are already in the `metadata` value, so no second call to the
/// filesystem is needed and there is nothing left to go wrong. `path` is unused here; the Windows
/// arm needs it, because a Windows file index is not in a `stat` at all.
#[cfg(unix)]
fn read_identity(_path: &Path, metadata: &fs::Metadata) -> Option<PathIdentity> {
    use std::os::unix::fs::MetadataExt;
    Some(PathIdentity::new(
        (u128::from(metadata.dev()) << 64) | u128::from(metadata.ino()),
    ))
}

/// Read the Windows file identity of `path` by opening a handle to it.
///
/// Windows keeps no inode number in a `stat`, so [`fs::Metadata`] cannot supply an identity here
/// at all: the volume serial number and the file index come from `GetFileInformationByHandle`,
/// which needs an open handle. This is the reason [`PathFacts::File`] carries the identity as a
/// required field rather than an `Option` -- an implementation that only called `fs::metadata`
/// would report every Windows file without one, and the same-file check would silently stop
/// working on the platform where NTFS hard links and case-insensitive names make it matter most.
///
/// The FFI is declared the way [`crate::fsutil::replace_file`] declares `MoveFileExW`: a local
/// `#[link(name = "Kernel32")] extern "system"` block, so the export pipeline gains no dependency
/// on a Windows binding crate for three calls.
///
/// The `CreateFileW` arguments each carry weight:
///
/// - the desired access is `0`, which is what the standard library's own `fs::metadata` asks for
///   on Windows. Nothing is read from the file, only from its handle, so a file the user cannot
///   read still yields an identity. Refusing to plan an export because the *source* could not be
///   opened for reading would be premature; `ffmpeg` is the process that has to read it, not this
///   one;
/// - `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE` shares everything, so inspecting a
///   path never denies access to another process holding it open, and a writer that already holds
///   it does not deny access here;
/// - `FILE_FLAG_BACKUP_SEMANTICS` is what lets a *directory* be opened. This function is only
///   called for a regular file today, since [`inspect_path`] guards the call with `is_file`, but
///   without the flag this call would fail on a directory rather than answer, and a later caller
///   would have to rediscover why;
/// - the flags deliberately omit `FILE_FLAG_OPEN_REPARSE_POINT`, so a symlink resolves to its
///   target, matching [`fs::metadata`] and the [`PathFacts`] contract.
///
/// The three fields pack into disjoint bit ranges: the volume serial number in bits 64 to 95, the
/// high half of the file index in bits 32 to 63, the low half in bits 0 to 31, and bits 96 to 127
/// unused. The serial is 32 bits wide but shifted by 64, the one place in this module where the
/// shift width does not match the field width, so it is worth stating plainly that the packing is
/// still injective: the ranges do not overlap, and no two distinct triples can produce one `u128`.
///
/// Returning `None` on any failure is the failure rule this module's doc comment states: the
/// caller turns it into [`PathFacts::Other`] and the export stops. Two known cases reach it. A
/// path longer than `MAX_PATH` without a verbatim prefix cannot be opened by this call, because
/// the wide string is passed to Win32 as written rather than through the standard library's own
/// verbatim-prefix conversion. A file another process has opened with a share mode that excludes
/// this open fails too. Both refuse the export instead of guessing at an identity, which is the
/// direction that cannot lose the user's video.
///
/// One caveat worth recording: on ReFS the 64-bit file index is a truncation of a 128-bit file id,
/// so two distinct files can in principle report one identity. That direction is safe -- it
/// refuses an export that would have been fine, and never permits one that overwrites the source.
/// A later unit that needs the exact id can read it with `GetFileInformationByHandleEx` and
/// `FileIdInfo`, but it does not drop into this `u128` as it stands: `FILE_ID_INFO` is a 64-bit
/// volume serial number *plus* a 128-bit file id, 192 bits in all, and the file id alone already
/// fills the newtype. Keeping the pairing that makes an identity meaningful would mean widening
/// [`PathIdentity`], or hashing the pair into it and accepting the collisions a hash brings.
#[cfg(windows)]
fn read_identity(path: &Path, _metadata: &fs::Metadata) -> Option<PathIdentity> {
    use std::ffi::c_void;
    use std::mem::MaybeUninit;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;

    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    const FILE_SHARE_DELETE: u32 = 0x4;
    const OPEN_EXISTING: u32 = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const INVALID_HANDLE_VALUE: *mut c_void = -1isize as *mut c_void;

    /// Win32 `BY_HANDLE_FILE_INFORMATION`, member for member and in order.
    ///
    /// The real structure has ten members but thirteen 32-bit words, 52 bytes in all: every
    /// member is a `DWORD` except the three `FILETIME`s, and a `FILETIME` is two `DWORD`s.
    /// Counting members instead of words moves the three offsets that matter --
    /// `dwVolumeSerialNumber` sits at byte 28, `nFileIndexHigh` at 44, `nFileIndexLow` at 48.
    /// Collapsing the `[u32; 2]` fields below into single `u32`s would still compile, and would
    /// read the last write time as the volume serial and the link count as the index half: an
    /// identity built from the wrong bytes, which is the failure this whole module exists to
    /// prevent. Every member is 4-byte aligned, so `#[repr(C)]` adds no padding.
    ///
    /// The fields this function never reads keep a leading underscore: they exist only to place
    /// the three that matter at the right offsets, and the underscore says so to a reader and to
    /// the `dead_code` lint alike.
    #[repr(C)]
    struct ByHandleFileInformation {
        _file_attributes: u32,
        _creation_time: [u32; 2],
        _last_access_time: [u32; 2],
        _last_write_time: [u32; 2],
        volume_serial_number: u32,
        _file_size_high: u32,
        _file_size_low: u32,
        _number_of_links: u32,
        file_index_high: u32,
        file_index_low: u32,
    }

    #[link(name = "Kernel32")]
    extern "system" {
        fn CreateFileW(
            file_name: *const u16,
            desired_access: u32,
            share_mode: u32,
            security_attributes: *mut c_void,
            creation_disposition: u32,
            flags_and_attributes: u32,
            template_file: *mut c_void,
        ) -> *mut c_void;
        fn GetFileInformationByHandle(
            file: *mut c_void,
            information: *mut ByHandleFileInformation,
        ) -> i32;
        fn CloseHandle(object: *mut c_void) -> i32;
    }

    /// Closes the handle it holds when it leaves scope.
    ///
    /// The read below has two exits, and a leaked handle would hold the user's source or
    /// destination file open for the life of the application. A guard closes it on every one of
    /// them, a panic included, the same way [`crate::fsutil::TemporaryFileCleanup`] removes its
    /// file on every exit path rather than trusting each early return to remember.
    ///
    /// Constructing one is a promise that the handle is live and owned. This type is built at
    /// exactly one place below, after the value has been checked against both
    /// `INVALID_HANDLE_VALUE` and null, so neither of those can ever reach `CloseHandle`.
    struct OwnedHandle(*mut c_void);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            // SAFETY: the only constructor of this type sits after the INVALID_HANDLE_VALUE and
            // null checks below, so self.0 is a live handle this value owns, and Drop runs once.
            unsafe { CloseHandle(self.0) };
        }
    }

    // An interior NUL byte cannot reach here: fs::metadata rejects such a path with
    // InvalidInput, and inspect_path has already turned that into PathFacts::Other.
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: `wide` is NUL-terminated and outlives the call, and the two null pointers are the
    // documented "no security attributes" and "no template file" arguments.
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE || raw.is_null() {
        return None;
    }
    let handle = OwnedHandle(raw);
    let mut information = MaybeUninit::<ByHandleFileInformation>::uninit();
    // SAFETY: the handle is open and owned by the guard, and the out pointer addresses a whole,
    // correctly aligned ByHandleFileInformation that Win32 fills before this returns non-zero.
    let read = unsafe { GetFileInformationByHandle(handle.0, information.as_mut_ptr()) };
    if read == 0 {
        return None;
    }
    // SAFETY: GetFileInformationByHandle returned non-zero, so it filled every field.
    let information = unsafe { information.assume_init() };
    Some(PathIdentity::new(
        (u128::from(information.volume_serial_number) << 64)
            | (u128::from(information.file_index_high) << 32)
            | u128::from(information.file_index_low),
    ))
}

/// Report no identity on a platform with neither Unix nor Windows semantics.
///
/// QuipClip ships on Windows and macOS only, and this arm exists so the crate still builds
/// elsewhere, exactly as [`crate::fsutil::replace_file`]'s own fallback arm does. The consequence
/// is stated rather than hidden: with no identity, [`inspect_path`] reports every regular file as
/// [`PathFacts::Other`] and no export can pass the preflight at all. A port to such a platform has
/// to write this arm before anything exports, which is the correct order -- the alternative,
/// answering with a constant, would make every destination compare equal to every source.
#[cfg(not(any(unix, windows)))]
fn read_identity(_path: &Path, _metadata: &fs::Metadata) -> Option<PathIdentity> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// The identity `inspect_path` reports for a path the test expects to be a regular file.
    fn identity_of(path: &Path) -> PathIdentity {
        match inspect_path(path) {
            PathFacts::File { identity } => identity,
            other => panic!(
                "expected {} to report a file, got {other:?}",
                path.display()
            ),
        }
    }

    #[test]
    fn a_regular_file_reports_a_file_with_an_identity() {
        let directory = TestDirectory::new();
        let path = directory.path.join("source.mp4");
        fs::write(&path, b"video").unwrap();
        assert!(matches!(inspect_path(&path), PathFacts::File { .. }));
    }

    #[test]
    fn a_directory_reports_a_directory() {
        let directory = TestDirectory::new();
        assert_eq!(inspect_path(&directory.path), PathFacts::Directory);
    }

    #[test]
    fn an_absent_path_reports_absent() {
        let directory = TestDirectory::new();
        let path = directory.path.join("nothing-was-ever-written-here.mp4");
        assert_eq!(inspect_path(&path), PathFacts::Absent);
    }

    // The two files differ in length as well as in name. Two identical files would leave the
    // Windows structure layout barely tested: every exposed field but the index would hold the
    // same value in both, so a field read from the wrong offset could still yield two distinct
    // identities and pass. A different byte length puts nFileSizeLow to work as a witness.
    #[test]
    fn two_different_files_report_different_identities() {
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        let destination = directory.path.join("destination.mp4");
        fs::write(&source, b"video").unwrap();
        fs::write(&destination, b"a considerably longer stand-in for a video").unwrap();
        assert_ne!(
            identity_of(&source),
            identity_of(&destination),
            "two files in one directory are two files"
        );
    }

    // Two paths for one file that need no special filesystem support, so this runs on Windows CI
    // as well and is the cheapest real exercise of the Windows arm the suite has.
    #[test]
    fn a_path_spelled_through_a_parent_component_reports_the_same_identity() {
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"video").unwrap();
        fs::create_dir(directory.path.join("sub")).unwrap();
        let indirect = directory.path.join("sub").join("..").join("source.mp4");
        assert_ne!(source, indirect, "the two spellings must differ as paths");
        assert_eq!(identity_of(&indirect), identity_of(&source));
    }

    // Two names for one file. This is the case a path comparison cannot see, and the reason
    // PathFacts::File carries an identity at all.
    //
    // The check stays on Unix because only there is the link certain to be creatable:
    // std::fs::hard_link maps to CreateHardLinkW on Windows, which needs NTFS, so the same test
    // would fail on a runner whose temporary directory sits on exFAT or on a network share. The
    // parent-component test above covers the same ground on Windows.
    #[cfg(unix)]
    #[test]
    fn two_hard_links_to_one_file_report_equal_identities() {
        let directory = TestDirectory::new();
        let source = directory.path.join("source.mp4");
        fs::write(&source, b"video").unwrap();
        let link = directory.path.join("also-source.mp4");
        fs::hard_link(&source, &link).unwrap();
        assert_eq!(identity_of(&source), identity_of(&link));
    }

    // A symlinked destination that points at the source is the case the PathFacts contract calls
    // out by name: following the link is what makes it report the source's identity instead of
    // the link's own.
    #[cfg(unix)]
    #[test]
    fn a_symlink_reports_the_identity_of_its_target() {
        let directory = TestDirectory::new();
        let target = directory.path.join("source.mp4");
        fs::write(&target, b"video").unwrap();
        let link = directory.path.join("destination.mp4");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert_eq!(identity_of(&link), identity_of(&target));
    }

    // A stat that fails with anything but NotFound must not answer Absent: build_plan accepts an
    // absent destination and skips the same-file comparison for it. Inside an unreadable
    // directory the stat returns EACCES for a child that exists and for one that never did, so
    // NotFound is not the discriminator here, and Other is the only safe answer for both.
    //
    // Permissions go back before the assertions run. A failing assertion panics, and a directory
    // left at mode 000 would defeat TestDirectory's own cleanup.
    #[cfg(unix)]
    #[test]
    fn a_path_whose_stat_is_denied_reports_other_not_absent() {
        use std::os::unix::fs::PermissionsExt;
        let directory = TestDirectory::new();
        let locked = directory.path.join("locked");
        fs::create_dir(&locked).unwrap();
        let existing = locked.join("source.mp4");
        fs::write(&existing, b"video").unwrap();
        let never_written = locked.join("destination.mp4");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        let existing_facts = inspect_path(&existing);
        let missing_facts = inspect_path(&never_written);
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(existing_facts, PathFacts::Other, "unreadable existing file");
        assert_eq!(missing_facts, PathFacts::Other, "unreadable absent path");
    }

    // The same rule, stated where every platform can check it and no permission bit is needed.
    #[test]
    fn classify_maps_only_not_found_to_absent_and_every_other_stat_error_to_other() {
        assert_eq!(
            classify(Err(io::ErrorKind::NotFound), None),
            PathFacts::Absent
        );
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::InvalidInput,
            io::ErrorKind::Other,
        ] {
            assert_eq!(
                classify(Err(kind), None),
                PathFacts::Other,
                "a {kind:?} stat must not read as an empty path"
            );
        }
    }

    // The other fail-closed rule. It is unreachable through inspect_path on Unix, where dev and
    // ino cannot fail, which is exactly why classify takes the identity as a value.
    #[test]
    fn classify_refuses_a_regular_file_whose_identity_could_not_be_read() {
        let directory = TestDirectory::new();
        let path = directory.path.join("source.mp4");
        fs::write(&path, b"video").unwrap();
        let file = fs::metadata(&path).unwrap();
        let folder = fs::metadata(&directory.path).unwrap();
        let identity = PathIdentity::new(7);
        assert_eq!(classify(Ok(&file), None), PathFacts::Other);
        assert_eq!(
            classify(Ok(&file), Some(identity)),
            PathFacts::File { identity }
        );
        assert_eq!(
            classify(Ok(&folder), None),
            PathFacts::Directory,
            "a directory never needed an identity"
        );
    }

    struct TestDirectory {
        path: PathBuf,
    }
    impl TestDirectory {
        fn new() -> Self {
            for _ in 0..1000 {
                let sequence = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "quipclip-fsinspect-test-{}-{sequence}",
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
    }
    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}
