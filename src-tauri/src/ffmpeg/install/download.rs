//! The download of one archive of the manifest (ADR 058).
//!
//! The download writes the body of a URL into a file, and computes its SHA-256 while the bytes
//! arrive. It stops as soon as the body gets longer than the size of the manifest. At the end it
//! compares the size and the SHA-256 with the manifest. A failure of the network, an HTTP
//! status, a wrong size or a wrong SHA-256 makes it try the next URL of the archive. A local
//! failure or a cancel stops it at once.
//!
//! The bytes come from a [`Fetch`]: [`HttpFetch`] in the application, and a fake in the tests.
//! A cancel ends a request or a read that waits, at once, so a stalled read never holds the job.

use super::manifest::Archive;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::File;
use std::future::{poll_fn, Future};
use std::io::{self, Write};
use std::path::Path;
use std::pin::pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::Poll;
use std::time::Duration;
use tokio::sync::Notify;

/// The longest wait for a connection to open.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// The longest wait for the next chunk of a body. Until the head of the response arrives, the
/// same time is also one limit for the connection, the TLS, each redirect and the wait of the
/// server, because reqwest does not restart it there. The download itself has no limit of total
/// time, because a large archive on a slow line can take long.
pub const READ_TIMEOUT: Duration = Duration::from_secs(60);

/// The most redirects of one request.
pub const MAX_REDIRECTS: usize = 10;

/// The cancel of one install. [`Self::cancel`] wakes each wait of [`Self::canceled`].
#[derive(Debug, Default)]
pub struct Cancel {
    flag: AtomicBool,
    notify: Notify,
}

impl Cancel {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Cancel the install. A second call does nothing more.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    #[must_use]
    pub fn is_canceled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Ends when the install is canceled, also when that happened before the call.
    pub async fn canceled(&self) {
        loop {
            let mut notified = pin!(self.notify.notified());
            // Registered before the read of the flag, so a cancel between the two is not lost.
            notified.as_mut().enable();
            if self.is_canceled() {
                return;
            }
            notified.await;
        }
    }

    /// Runs `future` until it ends, or until the install is canceled, whichever is first.
    pub async fn or_canceled<F: Future>(&self, future: F) -> Result<F::Output, DownloadError> {
        let mut future = pin!(future);
        let mut canceled = pin!(self.canceled());
        poll_fn(|context| {
            if canceled.as_mut().poll(context).is_ready() {
                return Poll::Ready(Err(DownloadError::Canceled));
            }
            future.as_mut().poll(context).map(Ok)
        })
        .await
    }
}

/// The failure of a download.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DownloadError {
    /// The connection, the TLS, a read or a timeout failed. The text is the diagnostic.
    Network(String),
    /// The server answered with a status that is not a success.
    HttpStatus(u16),
    /// The body ended before the size of the manifest.
    Size {
        expected: u64,
        actual: u64,
    },
    /// The body got longer than the size of the manifest. The download stops there.
    TooLong {
        expected: u64,
    },
    /// The body had another SHA-256 than the manifest.
    Hash {
        actual: String,
    },
    /// The file of the download could not be written. The text is the diagnostic.
    Write(String),
    Canceled,
}

impl DownloadError {
    /// True for a failure of one URL, after which the next URL of the archive can work.
    #[must_use]
    pub const fn tries_next_url(&self) -> bool {
        matches!(
            self,
            Self::Network(_)
                | Self::HttpStatus(_)
                | Self::Size { .. }
                | Self::TooLong { .. }
                | Self::Hash { .. }
        )
    }

    /// True for a wrong size, short or long.
    #[must_use]
    pub const fn is_size(&self) -> bool {
        matches!(self, Self::Size { .. } | Self::TooLong { .. })
    }
}

impl fmt::Display for DownloadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Network(detail) => write!(formatter, "the network failed: {detail}"),
            Self::HttpStatus(status) => write!(formatter, "the server answered {status}"),
            Self::Size { expected, actual } => {
                write!(formatter, "the file has {actual} bytes, not {expected}")
            }
            Self::TooLong { expected } => {
                write!(formatter, "the file is longer than {expected} bytes")
            }
            Self::Hash { actual } => write!(formatter, "the file has the SHA-256 {actual}"),
            Self::Write(detail) => write!(formatter, "the file could not be written: {detail}"),
            Self::Canceled => formatter.write_str("the download was canceled"),
        }
    }
}

impl std::error::Error for DownloadError {}

/// The body of one response, read in chunks.
pub trait Body {
    type Chunk: AsRef<[u8]>;

    /// The next chunk, or `None` at the end of the body.
    fn chunk(&mut self) -> impl Future<Output = Result<Option<Self::Chunk>, DownloadError>>;
}

/// A source of the bytes of one URL.
pub trait Fetch {
    type Body: Body;

    /// Starts a request for `url`. An HTTP status that is not a success is an error.
    fn get(&self, url: &str) -> impl Future<Output = Result<Self::Body, DownloadError>>;
}

/// Download `archive` into the file `destination`. It tries each URL in order, as the module
/// doc says. `progress` gets the number of bytes of the current URL after each chunk, which can
/// be tens of thousands of times for one archive, so a caller that sends it on must throttle it.
///
/// When each URL fails, the result is the SHA-256 failure if one URL gave a wrong SHA-256, else
/// the size failure if one URL gave a wrong size, else the failure of the last URL (ADR 058).
///
/// The download writes the file with blocking calls. Drive it with `block_on` on an OS thread of
/// its own, never on a worker of the async runtime.
pub async fn download_archive<F: Fetch>(
    fetch: &F,
    archive: &Archive,
    destination: &Path,
    cancel: &Cancel,
    progress: &mut dyn FnMut(u64),
) -> Result<(), DownloadError> {
    let mut hash_failure = None;
    let mut size_failure = None;
    let mut last_failure = None;
    for url in &archive.urls {
        match download_url(fetch, url, archive, destination, cancel, progress).await {
            Ok(()) => return Ok(()),
            Err(error) if !error.tries_next_url() => return Err(error),
            Err(error) => {
                eprintln!("install: {url}: {error}");
                if matches!(error, DownloadError::Hash { .. }) {
                    hash_failure = hash_failure.or(Some(error));
                } else if error.is_size() {
                    size_failure = size_failure.or(Some(error));
                } else {
                    last_failure = Some(error);
                }
            }
        }
    }
    Err(hash_failure
        .or(size_failure)
        .or(last_failure)
        .unwrap_or_else(|| DownloadError::Network("the archive has no URL".to_owned())))
}

/// Download one URL of `archive` into `destination`, which it creates or truncates.
async fn download_url<F: Fetch>(
    fetch: &F,
    url: &str,
    archive: &Archive,
    destination: &Path,
    cancel: &Cancel,
    progress: &mut dyn FnMut(u64),
) -> Result<(), DownloadError> {
    let mut file = File::create(destination).map_err(write_error)?;
    let mut body = cancel.or_canceled(fetch.get(url)).await??;
    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    progress(0);
    while let Some(chunk) = cancel.or_canceled(body.chunk()).await?? {
        let bytes = chunk.as_ref();
        received = received.saturating_add(bytes.len() as u64);
        if received > archive.size {
            return Err(DownloadError::TooLong {
                expected: archive.size,
            });
        }
        file.write_all(bytes).map_err(write_error)?;
        hasher.update(bytes);
        progress(received);
    }
    file.flush().map_err(write_error)?;
    if received != archive.size {
        return Err(DownloadError::Size {
            expected: archive.size,
            actual: received,
        });
    }
    let actual = hex(&hasher.finalize());
    if actual != archive.sha256 {
        return Err(DownloadError::Hash { actual });
    }
    Ok(())
}

fn write_error(error: io::Error) -> DownloadError {
    DownloadError::Write(error.to_string())
}

/// The lowercase hexadecimal form of `bytes`.
fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut text, byte| {
            let _ = write!(text, "{byte:02x}");
            text
        })
}

/// What the client does with one redirect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Redirect {
    Follow,
    /// The redirect goes to an address that is not HTTPS.
    NotHttps,
    TooMany,
}

/// The rule for one redirect: at most [`MAX_REDIRECTS`] of them, each to an HTTPS address. No
/// list of hosts applies, because the SHA-256 of the manifest is what QuipClip trusts (ADR 058).
/// `previous` is the number of addresses before this one, the first request included.
#[must_use]
pub fn redirect_rule(scheme: &str, previous: usize, allow_http: bool) -> Redirect {
    if previous > MAX_REDIRECTS {
        Redirect::TooMany
    } else if scheme == "https" || (allow_http && scheme == "http") {
        Redirect::Follow
    } else {
        Redirect::NotHttps
    }
}

/// The HTTP client of the download: HTTPS only, the redirect rule above, the proxy of the system,
/// and the time limits above.
pub struct HttpFetch {
    client: reqwest::Client,
}

impl HttpFetch {
    pub fn new() -> Result<Self, DownloadError> {
        Self::with_http(false)
    }

    /// A client that also accepts `http`, for a test server on the loopback address.
    #[cfg(test)]
    fn for_loopback() -> Result<Self, DownloadError> {
        Self::with_http(true)
    }

    fn with_http(allow_http: bool) -> Result<Self, DownloadError> {
        let policy = reqwest::redirect::Policy::custom(move |attempt| {
            match redirect_rule(attempt.url().scheme(), attempt.previous().len(), allow_http) {
                Redirect::Follow => attempt.follow(),
                Redirect::NotHttps => attempt.error("a redirect to an address that is not HTTPS"),
                Redirect::TooMany => attempt.error("too many redirects"),
            }
        });
        let builder = reqwest::Client::builder()
            .https_only(!allow_http)
            .redirect(policy)
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT)
            .user_agent(concat!("QuipClip/", env!("CARGO_PKG_VERSION")));
        #[cfg(test)]
        let builder = if allow_http {
            builder.no_proxy()
        } else {
            builder
        };
        let client = builder
            .build()
            .map_err(|error| DownloadError::Network(describe(&error.without_url())))?;
        Ok(Self { client })
    }
}

/// The body of a response of [`HttpFetch`].
pub struct HttpBody(reqwest::Response);

impl Body for HttpBody {
    type Chunk = Vec<u8>;

    async fn chunk(&mut self) -> Result<Option<Vec<u8>>, DownloadError> {
        self.0
            .chunk()
            .await
            .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
            .map_err(|error| DownloadError::Network(describe(&error.without_url())))
    }
}

impl Fetch for HttpFetch {
    type Body = HttpBody;

    async fn get(&self, url: &str) -> Result<HttpBody, DownloadError> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|error| DownloadError::Network(describe(&error.without_url())))?;
        let status = response.status();
        if !status.is_success() {
            return Err(DownloadError::HttpStatus(status.as_u16()));
        }
        Ok(HttpBody(response))
    }
}

/// The text of an error and of each error under it, for the diagnostic of the failure.
fn describe(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !text.contains(&cause_text) {
            text.push_str(": ");
            text.push_str(&cause_text);
        }
        source = cause.source();
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::install::manifest::Entries;
    use std::collections::HashMap;
    use std::collections::VecDeque;
    use std::io::Read;
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    const BODY: &[u8] = b"the bytes of the archive";

    fn sha256_of(bytes: &[u8]) -> String {
        hex(&Sha256::digest(bytes))
    }

    fn archive(urls: &[&str], bytes: &[u8]) -> Archive {
        Archive {
            urls: urls.iter().map(|url| (*url).to_owned()).collect(),
            sha256: sha256_of(bytes),
            size: bytes.len() as u64,
            entries: Entries {
                ffmpeg: None,
                ffprobe: None,
            },
        }
    }

    /// One scripted answer of the fake.
    #[derive(Clone)]
    enum Answer {
        /// These chunks, then the end.
        Chunks(Vec<Vec<u8>>),
        /// These chunks, then a read that fails.
        Broken(Vec<Vec<u8>>),
        /// These chunks, then a read that never ends.
        Stalled(Vec<Vec<u8>>),
        Status(u16),
        /// A request that never answers.
        Hang,
    }

    struct FakeFetch {
        answers: HashMap<String, Answer>,
        requests: Mutex<Vec<String>>,
        /// Set when a request or a read starts to wait for ever.
        waiting: Arc<AtomicBool>,
    }

    impl FakeFetch {
        fn new(answers: &[(&str, Answer)]) -> Self {
            Self {
                answers: answers
                    .iter()
                    .map(|(url, answer)| ((*url).to_owned(), answer.clone()))
                    .collect(),
                requests: Mutex::new(Vec::new()),
                waiting: Arc::new(AtomicBool::new(false)),
            }
        }
    }

    struct FakeBody {
        chunks: VecDeque<Vec<u8>>,
        end: Answer,
        waiting: Arc<AtomicBool>,
    }

    impl Body for FakeBody {
        type Chunk = Vec<u8>;

        async fn chunk(&mut self) -> Result<Option<Vec<u8>>, DownloadError> {
            if let Some(chunk) = self.chunks.pop_front() {
                return Ok(Some(chunk));
            }
            match self.end {
                Answer::Broken(_) => Err(DownloadError::Network("reset".to_owned())),
                Answer::Stalled(_) => {
                    self.waiting.store(true, Ordering::SeqCst);
                    std::future::pending().await
                }
                _ => Ok(None),
            }
        }
    }

    impl Fetch for FakeFetch {
        type Body = FakeBody;

        async fn get(&self, url: &str) -> Result<FakeBody, DownloadError> {
            self.requests.lock().unwrap().push(url.to_owned());
            let answer = self
                .answers
                .get(url)
                .cloned()
                .unwrap_or(Answer::Status(404));
            let chunks = match &answer {
                Answer::Chunks(chunks) | Answer::Broken(chunks) | Answer::Stalled(chunks) => {
                    chunks.clone()
                }
                Answer::Status(status) => return Err(DownloadError::HttpStatus(*status)),
                Answer::Hang => {
                    self.waiting.store(true, Ordering::SeqCst);
                    std::future::pending().await
                }
            };
            Ok(FakeBody {
                chunks: chunks.into(),
                end: answer,
                waiting: Arc::clone(&self.waiting),
            })
        }
    }

    fn split(bytes: &[u8]) -> Vec<Vec<u8>> {
        bytes.chunks(5).map(<[u8]>::to_vec).collect()
    }

    fn run(
        fetch: &FakeFetch,
        archive: &Archive,
        destination: &Path,
        cancel: &Cancel,
    ) -> (Result<(), DownloadError>, Vec<u64>) {
        let mut seen = Vec::new();
        let result = tauri::async_runtime::block_on(download_archive(
            fetch,
            archive,
            destination,
            cancel,
            &mut |received| seen.push(received),
        ));
        (result, seen)
    }

    #[test]
    fn a_body_with_the_size_and_hash_of_the_manifest_is_written_whole() {
        let directory = crate::flv::test_support::TestDirectory::new();
        let destination = directory.path.join("a.zip");
        let fetch = FakeFetch::new(&[("https://a.test/a.zip", Answer::Chunks(split(BODY)))]);
        let (result, seen) = run(
            &fetch,
            &archive(&["https://a.test/a.zip"], BODY),
            &destination,
            &Cancel::new(),
        );
        assert_eq!(result, Ok(()));
        assert_eq!(std::fs::read(&destination).unwrap(), BODY);
        assert_eq!(seen.first(), Some(&0));
        assert_eq!(seen.last(), Some(&(BODY.len() as u64)));
        assert!(seen.windows(2).all(|pair| pair[0] <= pair[1]));
    }

    #[test]
    fn a_short_body_a_long_body_and_a_wrong_hash_each_fail() {
        let directory = crate::flv::test_support::TestDirectory::new();
        let destination = directory.path.join("a.zip");
        let url = "https://a.test/a.zip";
        let cases: [(Answer, fn(&DownloadError) -> bool); 3] = [
            (Answer::Chunks(split(&BODY[..10])), |error| {
                matches!(error, DownloadError::Size { actual: 10, .. })
            }),
            (Answer::Chunks(split(&[BODY, b"more"].concat())), |error| {
                matches!(error, DownloadError::TooLong { .. })
            }),
            (
                Answer::Chunks(split(&BODY.iter().map(|b| b ^ 1).collect::<Vec<_>>())),
                |error| matches!(error, DownloadError::Hash { .. }),
            ),
        ];
        for (answer, check) in cases {
            let fetch = FakeFetch::new(&[(url, answer)]);
            let (result, _) = run(&fetch, &archive(&[url], BODY), &destination, &Cancel::new());
            let error = result.unwrap_err();
            assert!(check(&error), "{error:?}");
        }
    }

    #[test]
    fn a_long_body_stops_at_the_first_byte_past_the_size() {
        let directory = crate::flv::test_support::TestDirectory::new();
        let destination = directory.path.join("a.zip");
        let url = "https://a.test/a.zip";
        // After the first chunk past the size, a further read would fail as a network error,
        // so a download that read on would give that error and not the size.
        let mut chunks = split(BODY);
        chunks.push(b"x".to_vec());
        let fetch = FakeFetch::new(&[(url, Answer::Broken(chunks))]);
        let (result, _) = run(&fetch, &archive(&[url], BODY), &destination, &Cancel::new());
        assert_eq!(
            result,
            Err(DownloadError::TooLong {
                expected: BODY.len() as u64
            })
        );
    }

    #[test]
    fn a_failed_url_tries_the_next_one() {
        let directory = crate::flv::test_support::TestDirectory::new();
        let destination = directory.path.join("a.zip");
        let urls = ["https://a.test/1", "https://a.test/2", "https://a.test/3"];
        let fetch = FakeFetch::new(&[
            (urls[0], Answer::Status(503)),
            (urls[1], Answer::Broken(split(&BODY[..5]))),
            (urls[2], Answer::Chunks(split(BODY))),
        ]);
        let (result, _) = run(&fetch, &archive(&urls, BODY), &destination, &Cancel::new());
        assert_eq!(result, Ok(()));
        assert_eq!(*fetch.requests.lock().unwrap(), urls);
        assert_eq!(std::fs::read(&destination).unwrap(), BODY);
    }

    #[test]
    fn when_each_url_fails_a_hash_failure_wins_then_a_size_failure() {
        let directory = crate::flv::test_support::TestDirectory::new();
        let destination = directory.path.join("a.zip");
        let urls = ["https://a.test/1", "https://a.test/2", "https://a.test/3"];
        let wrong = BODY.iter().map(|b| b ^ 1).collect::<Vec<_>>();
        let fetch = FakeFetch::new(&[
            (urls[0], Answer::Chunks(split(&BODY[..3]))),
            (urls[1], Answer::Chunks(split(&wrong))),
            (urls[2], Answer::Status(500)),
        ]);
        let (result, _) = run(&fetch, &archive(&urls, BODY), &destination, &Cancel::new());
        assert!(matches!(result, Err(DownloadError::Hash { .. })));

        let fetch = FakeFetch::new(&[
            (urls[0], Answer::Status(500)),
            (urls[1], Answer::Chunks(split(&BODY[..3]))),
            (urls[2], Answer::Status(404)),
        ]);
        let (result, _) = run(&fetch, &archive(&urls, BODY), &destination, &Cancel::new());
        assert!(matches!(result, Err(DownloadError::Size { .. })));

        let fetch = FakeFetch::new(&[
            (urls[0], Answer::Status(500)),
            (urls[1], Answer::Status(404)),
        ]);
        let (result, _) = run(
            &fetch,
            &archive(&urls[..2], BODY),
            &destination,
            &Cancel::new(),
        );
        assert_eq!(result, Err(DownloadError::HttpStatus(404)));
    }

    #[test]
    fn a_local_failure_stops_at_once() {
        let directory = crate::flv::test_support::TestDirectory::new();
        let destination = directory.path.join("missing").join("a.zip");
        let urls = ["https://a.test/1", "https://a.test/2"];
        let fetch = FakeFetch::new(&[(urls[1], Answer::Chunks(split(BODY)))]);
        let (result, _) = run(&fetch, &archive(&urls, BODY), &destination, &Cancel::new());
        assert!(matches!(result, Err(DownloadError::Write(_))));
        assert!(fetch.requests.lock().unwrap().is_empty());
    }

    #[test]
    fn a_cancel_ends_a_stalled_read_and_a_request_that_hangs() {
        for answer in [Answer::Stalled(split(&BODY[..5])), Answer::Hang] {
            let directory = crate::flv::test_support::TestDirectory::new();
            let destination = directory.path.join("a.zip");
            let url = "https://a.test/a.zip";
            let fetch = FakeFetch::new(&[(url, answer)]);
            let cancel = Arc::new(Cancel::new());
            let later = Arc::clone(&cancel);
            let waiting = Arc::clone(&fetch.waiting);
            // The cancel comes only once the fake waits, so the test checks the cancel of a
            // wait and not the cancel before the start.
            let canceler = std::thread::spawn(move || {
                while !waiting.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                later.cancel();
            });
            let (result, _) = run(
                &fetch,
                &archive(&[url, "https://a.test/b"], BODY),
                &destination,
                &cancel,
            );
            canceler.join().unwrap();
            assert_eq!(result, Err(DownloadError::Canceled));
            assert_eq!(
                fetch.requests.lock().unwrap().len(),
                1,
                "no next URL after a cancel"
            );
        }
    }

    #[test]
    fn a_cancel_before_the_start_ends_the_download_at_once() {
        let directory = crate::flv::test_support::TestDirectory::new();
        let destination = directory.path.join("a.zip");
        let url = "https://a.test/a.zip";
        let fetch = FakeFetch::new(&[(url, Answer::Chunks(split(BODY)))]);
        let cancel = Cancel::new();
        cancel.cancel();
        let (result, _) = run(&fetch, &archive(&[url], BODY), &destination, &cancel);
        assert_eq!(result, Err(DownloadError::Canceled));
    }

    #[test]
    fn only_a_failure_of_one_url_tries_the_next_url() {
        assert!(DownloadError::Network(String::new()).tries_next_url());
        assert!(DownloadError::HttpStatus(404).tries_next_url());
        assert!(DownloadError::Size {
            expected: 1,
            actual: 2
        }
        .tries_next_url());
        assert!(DownloadError::TooLong { expected: 1 }.tries_next_url());
        assert!(DownloadError::Hash {
            actual: String::new()
        }
        .tries_next_url());
        assert!(!DownloadError::Write(String::new()).tries_next_url());
        assert!(!DownloadError::Canceled.tries_next_url());
    }

    #[test]
    fn the_redirect_rule_follows_at_most_ten_https_redirects() {
        assert_eq!(redirect_rule("https", 1, false), Redirect::Follow);
        assert_eq!(
            redirect_rule("https", MAX_REDIRECTS, false),
            Redirect::Follow
        );
        assert_eq!(
            redirect_rule("https", MAX_REDIRECTS + 1, false),
            Redirect::TooMany
        );
        assert_eq!(redirect_rule("http", 1, false), Redirect::NotHttps);
        assert_eq!(redirect_rule("ftp", 1, true), Redirect::NotHttps);
        assert_eq!(redirect_rule("http", 1, true), Redirect::Follow);
    }

    /// Serves each request on the loopback address with `respond`, which gets the request line.
    fn serve(respond: impl Fn(&str) -> Vec<u8> + Send + 'static) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let mut request = Vec::new();
                let mut buffer = [0_u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&buffer[..read]),
                    }
                }
                let text = String::from_utf8_lossy(&request);
                let line = text.lines().next().unwrap_or_default().to_owned();
                let _ = stream.write_all(&respond(&line));
            }
        });
        format!("http://{address}")
    }

    #[test]
    fn the_http_client_downloads_follows_a_redirect_and_reports_a_status() {
        let base = serve(|line| {
            if line.starts_with("GET /moved ") {
                redirect_to("/a.zip")
            } else if line.starts_with("GET /a.zip ") {
                ok_body()
            } else {
                not_found()
            }
        });
        let fetch = HttpFetch::for_loopback().unwrap();
        let directory = crate::flv::test_support::TestDirectory::new();
        let destination = directory.path.join("a.zip");
        let moved = format!("{base}/moved");
        let result = tauri::async_runtime::block_on(download_archive(
            &fetch,
            &archive(&[&moved], BODY),
            &destination,
            &Cancel::new(),
            &mut |_| {},
        ));
        assert_eq!(result, Ok(()));
        assert_eq!(std::fs::read(&destination).unwrap(), BODY);

        let missing = format!("{base}/missing");
        let result = tauri::async_runtime::block_on(download_archive(
            &fetch,
            &archive(&[&missing], BODY),
            &destination,
            &Cancel::new(),
            &mut |_| {},
        ));
        assert_eq!(result, Err(DownloadError::HttpStatus(404)));
    }

    /// A redirect to `location`. Each answer closes its connection, so no request reuses it.
    fn redirect_to(location: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .into_bytes()
    }

    fn ok_body() -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            BODY.len()
        )
        .into_bytes();
        response.extend_from_slice(BODY);
        response
    }

    fn not_found() -> Vec<u8> {
        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
    }

    #[test]
    fn the_http_client_follows_ten_redirects_and_refuses_the_eleventh() {
        // `/r/N` redirects to `/r/N-1`, and `/r/0` answers the body, so `/r/N` takes N redirects.
        let base = serve(|line| {
            let path = line.split_whitespace().nth(1).unwrap_or_default();
            match path.strip_prefix("/r/").and_then(|n| n.parse::<u32>().ok()) {
                Some(0) => ok_body(),
                Some(n) => redirect_to(&format!("/r/{}", n - 1)),
                None => not_found(),
            }
        });
        let fetch = HttpFetch::for_loopback().unwrap();
        let get = |hops: usize| {
            tauri::async_runtime::block_on(fetch.get(&format!("{base}/r/{hops}"))).map(|_| ())
        };
        assert_eq!(get(MAX_REDIRECTS), Ok(()));
        let refused = get(MAX_REDIRECTS + 1);
        assert!(
            matches!(&refused, Err(DownloadError::Network(text)) if text.contains("too many redirects")),
            "{refused:?}"
        );
    }

    #[test]
    fn the_application_client_refuses_an_http_address_before_it_connects() {
        let requests = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&requests);
        let base = serve(move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            ok_body()
        });
        let fetch = HttpFetch::new().unwrap();
        let result =
            tauri::async_runtime::block_on(fetch.get(&format!("{base}/a.zip"))).map(|_| ());
        assert!(
            matches!(&result, Err(DownloadError::Network(text)) if text.contains("URL scheme is not allowed")),
            "{result:?}"
        );
        assert_eq!(requests.load(Ordering::SeqCst), 0);
    }
}
