//! The remux windows of the preview of a container that the web view cannot open (ADR 046).
//!
//! - `arguments`: the command lines of a remux window and of its PCM process.
//! - `registry`: the running windows, one for each lane, and the credit of the page.
//! - `stream`: the processes, the stdin writer of an FLV window, and the readers.

pub mod arguments;
pub mod registry;
pub mod stream;

pub use registry::{Lane, PreviewWindows};
