//! The command lines of a remux window and of its PCM process (ADR 046).
//!
//! A remux window writes fragmented MP4 with `-c copy` and keeps the absolute source timestamps,
//! so the page can play it through a MediaSource with a known calibration. The PCM process
//! decodes the audio of the same window for the scrub cue.
//!
//! A window of a source that is not an FLV maps its audio stream by the absolute index that the
//! request names (ADR 070). The input of an FLV window holds the tags that Rust writes, with one
//! audio stream, so it maps the first audio stream of that input.

use std::path::Path;

/// The length of one fragment of a remux window, in microseconds. With `frag_keyframe` alone a
/// fragment waits for the next keyframe, so a long GOP would hold back the first picture
/// (ADR 046 measurement 10).
pub const FRAGMENT_DURATION_US: u32 = 500_000;
/// The sample rate of the PCM of the scrub cue.
pub const PCM_SAMPLE_RATE: u32 = 48_000;

/// The flags of every remux window: fragmented MP4 that keeps the absolute decode time of each
/// track in `tfdt` and has no edit list (ADR 046 measurement 4).
const MP4_OUTPUT: &[&str] = &[
    "-f",
    "mp4",
    "-movflags",
    "frag_keyframe+empty_moov+default_base_moof+frag_discont",
    "-frag_duration",
    "500000",
    "-use_editlist",
    "0",
    "-avoid_negative_ts",
    "disabled",
];

/// What a remux window does with the audio of the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AudioMode {
    /// Copy the audio, which the web view can decode.
    Copy,
    /// Transcode the audio to AAC, because the web view cannot decode it (ADR 046
    /// measurement 15). No delay filter: the encoder priming already sits before the first
    /// real sample.
    Transcode,
    /// No audio: the source has none, or the transcode failed.
    Omit,
}

/// The container of a source that FFmpeg seeks in itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SeekContainer {
    MpegTs,
    Matroska,
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|item| (*item).to_owned()).collect()
}

/// The map of the audio of an FLV window: the first audio stream of its input.
const FLV_AUDIO_MAP: &str = "0:a:0";

/// The map of the audio stream with the absolute index `index` (ADR 070, ADR 014).
fn stream_map(index: u32) -> String {
    format!("0:{index}")
}

fn push_maps(arguments: &mut Vec<String>, audio: AudioMode, audio_map: Option<&str>) {
    arguments.extend(strings(&["-map", "0:v:0"]));
    if let Some(map) = audio_map.filter(|_| audio != AudioMode::Omit) {
        arguments.extend(["-map".to_owned(), map.to_owned()]);
    }
}

fn push_codecs(arguments: &mut Vec<String>, audio: AudioMode, adts: bool) {
    // MPEG-TS carries AAC with ADTS headers, which the mp4 muxer refuses (ADR 046
    // measurement 6). The filter refuses every other codec, and a transcode reads the headers
    // itself, so it applies only to copied AAC.
    if audio == AudioMode::Copy && adts {
        arguments.extend(strings(&["-bsf:a", "aac_adtstoasc"]));
    }
    arguments.extend(strings(&["-c", "copy"]));
    if audio == AudioMode::Transcode {
        arguments.extend(strings(&["-c:a", "aac"]));
    }
}

/// A time in seconds as FFmpeg reads it, with six decimals.
fn seconds(value: f64) -> String {
    format!("{value:.6}")
}

/// The remux window of an FLV, read from stdin: the head and the slice that Rust writes there.
pub fn flv_remux_arguments(audio: AudioMode) -> Vec<String> {
    let mut arguments = strings(&[
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "flv",
        "-copyts",
        "-i",
        "pipe:0",
    ]);
    push_maps(&mut arguments, audio, Some(FLV_AUDIO_MAP));
    push_codecs(&mut arguments, audio, false);
    arguments.extend(strings(MP4_OUTPUT));
    arguments.push("pipe:1".to_owned());
    arguments
}

/// The remux window of a container that FFmpeg seeks in. `seek` is the input `-ss`, relative to
/// the container start (ADR 014 measurement 8), and `None` reads from the start of the file.
/// `length` limits what the input reads. It must stay an input option, before `-i`: an output
/// `-t` with `-copyts` is compared with the absolute timestamps and writes nothing (ADR 046
/// measurement 6). `audio_stream` is the absolute index of the audio stream that the window maps
/// (ADR 070). A window with no stream maps no audio, as an `Omit` window. `aac` says that the
/// audio stream is AAC.
pub fn seek_remux_arguments(
    path: &Path,
    container: SeekContainer,
    seek: Option<f64>,
    length: f64,
    audio: AudioMode,
    audio_stream: Option<u32>,
    aac: bool,
) -> Vec<String> {
    let audio = if audio_stream.is_some() {
        audio
    } else {
        AudioMode::Omit
    };
    let mut arguments = strings(&["-hide_banner", "-loglevel", "error", "-nostdin", "-copyts"]);
    push_seek(&mut arguments, seek, length, path);
    push_maps(
        &mut arguments,
        audio,
        audio_stream.map(stream_map).as_deref(),
    );
    push_codecs(
        &mut arguments,
        audio,
        aac && container == SeekContainer::MpegTs,
    );
    arguments.extend(strings(MP4_OUTPUT));
    // Without it, the moov of an MPEG-TS window holds no AudioSpecificConfig (ADR 046
    // measurement 12). It does no harm on Matroska.
    let movflags = arguments
        .iter()
        .position(|argument| argument == "-movflags")
        .expect("the MP4 flags hold -movflags")
        + 1;
    arguments[movflags].push_str("+delay_moov");
    arguments.push("pipe:1".to_owned());
    arguments
}

fn push_seek(arguments: &mut Vec<String>, seek: Option<f64>, length: f64, path: &Path) {
    if let Some(seek) = seek.filter(|seek| *seek > 0.0) {
        arguments.extend(["-ss".to_owned(), seconds(seek)]);
    }
    arguments.extend(["-t".to_owned(), seconds(length)]);
    arguments.extend(["-i".to_owned(), path.to_string_lossy().into_owned()]);
}

/// The filters that make sample 0 of the PCM the sample at `start_samples`, in samples of
/// [`PCM_SAMPLE_RATE`], with silence or a cut against the timestamps. `first_pts` counts samples
/// of the input rate of its filter, so the first `aresample` converts to 48 kHz and the second
/// one aligns. A tone in the PCM then starts within 0.35 ms of the same tone in the FFmpeg
/// decode of the source, at 44.1 and 48 kHz (ADR 046).
fn pcm_filter(start_samples: i64) -> String {
    format!("aresample={PCM_SAMPLE_RATE},aresample=async=1:first_pts={start_samples}")
}

fn push_pcm_output(arguments: &mut Vec<String>, audio_map: &str, start_samples: i64) {
    arguments.extend(["-map".to_owned(), audio_map.to_owned(), "-af".to_owned()]);
    arguments.push(pcm_filter(start_samples));
    arguments.extend(strings(&["-f", "s16le", "-ac", "1", "pipe:1"]));
}

/// The PCM of an FLV window, read from the same stdin bytes as its remux process.
/// `start_ms` is the decode time of the first tag of the window.
pub fn flv_pcm_arguments(start_ms: i64) -> Vec<String> {
    let mut arguments = strings(&[
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "flv",
        "-copyts",
        "-i",
        "pipe:0",
    ]);
    push_pcm_output(
        &mut arguments,
        FLV_AUDIO_MAP,
        start_ms * i64::from(PCM_SAMPLE_RATE / 1000),
    );
    arguments
}

/// The PCM window of a container that FFmpeg seeks in. `start_seconds` is the absolute time of
/// sample 0: the container start plus the seek. `audio_stream` is the absolute index of the audio
/// stream that the window decodes (ADR 070).
pub fn seek_pcm_arguments(
    path: &Path,
    seek: Option<f64>,
    length: f64,
    start_seconds: f64,
    audio_stream: u32,
) -> Vec<String> {
    let mut arguments = strings(&["-hide_banner", "-loglevel", "error", "-nostdin", "-copyts"]);
    push_seek(&mut arguments, seek, length, path);
    let start_samples = (start_seconds * f64::from(PCM_SAMPLE_RATE)).round() as i64;
    push_pcm_output(&mut arguments, &stream_map(audio_stream), start_samples);
    arguments
}

#[cfg(test)]
mod tests {
    use super::*;

    fn joined(arguments: &[String]) -> String {
        arguments.join(" ")
    }

    #[test]
    fn the_flv_remux_window_reads_stdin_and_writes_absolute_fragments() {
        assert_eq!(
            joined(&flv_remux_arguments(AudioMode::Copy)),
            "-hide_banner -loglevel error -f flv -copyts -i pipe:0 -map 0:v:0 -map 0:a:0 \
             -c copy -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof+frag_discont \
             -frag_duration 500000 -use_editlist 0 -avoid_negative_ts disabled pipe:1"
        );
        let transcode = joined(&flv_remux_arguments(AudioMode::Transcode));
        assert!(transcode.contains("-map 0:a:0 -c copy -c:a aac -f mp4"));
        assert!(!transcode.contains("adelay"));
        let omit = joined(&flv_remux_arguments(AudioMode::Omit));
        assert!(!omit.contains("0:a:0"));
    }

    #[test]
    fn the_seek_window_keeps_t_as_an_input_option() {
        let arguments = seek_remux_arguments(
            Path::new("/media/live.ts"),
            SeekContainer::MpegTs,
            Some(25.5),
            65.0,
            AudioMode::Copy,
            Some(1),
            true,
        );
        let position = |flag: &str| arguments.iter().position(|a| a == flag).unwrap();
        assert!(position("-ss") < position("-i"));
        assert!(position("-t") < position("-i"));
        assert_eq!(
            joined(&arguments),
            "-hide_banner -loglevel error -nostdin -copyts -ss 25.500000 -t 65.000000 \
             -i /media/live.ts -map 0:v:0 -map 0:1 -bsf:a aac_adtstoasc -c copy -f mp4 \
             -movflags frag_keyframe+empty_moov+default_base_moof+frag_discont+delay_moov \
             -frag_duration 500000 -use_editlist 0 -avoid_negative_ts disabled pipe:1"
        );
    }

    #[test]
    fn the_bitstream_filter_applies_only_to_copied_mpeg_ts_audio() {
        let path = Path::new("/media/a.mkv");
        let matroska = joined(&seek_remux_arguments(
            path,
            SeekContainer::Matroska,
            None,
            60.0,
            AudioMode::Copy,
            Some(1),
            true,
        ));
        assert!(!matroska.contains("aac_adtstoasc"));
        assert!(!matroska.contains("-ss"));
        assert!(matroska.contains("+delay_moov"));
        let transcoded = joined(&seek_remux_arguments(
            Path::new("/media/a.ts"),
            SeekContainer::MpegTs,
            Some(10.0),
            60.0,
            AudioMode::Transcode,
            Some(1),
            true,
        ));
        assert!(!transcoded.contains("aac_adtstoasc"));
        assert!(transcoded.contains("-c copy -c:a aac"));
        // Copied AC-3 in MPEG-TS takes no ADTS filter, which would refuse it.
        let ac3 = joined(&seek_remux_arguments(
            Path::new("/media/a.ts"),
            SeekContainer::MpegTs,
            Some(10.0),
            60.0,
            AudioMode::Copy,
            Some(1),
            false,
        ));
        assert!(!ac3.contains("aac_adtstoasc"));
    }

    #[test]
    fn a_seek_at_or_below_zero_is_left_out() {
        let arguments = seek_remux_arguments(
            Path::new("/media/a.ts"),
            SeekContainer::MpegTs,
            Some(0.0),
            60.0,
            AudioMode::Omit,
            Some(1),
            false,
        );
        assert!(!arguments.iter().any(|a| a == "-ss"));
        assert!(!arguments.iter().any(|a| a == "0:a:0" || a == "0:1"));
    }

    #[test]
    fn the_pcm_processes_start_their_samples_at_the_window_start() {
        assert_eq!(
            joined(&flv_pcm_arguments(60_000)),
            "-hide_banner -loglevel error -f flv -copyts -i pipe:0 -map 0:a:0 \
             -af aresample=48000,aresample=async=1:first_pts=2880000 -f s16le -ac 1 pipe:1"
        );
        let seek = joined(&seek_pcm_arguments(
            Path::new("/media/a.mkv"),
            Some(20.0),
            25.0,
            1254.567,
            1,
        ));
        assert!(seek.contains("-ss 20.000000 -t 25.000000 -i /media/a.mkv"));
        assert!(seek.contains("first_pts=60219216"));
    }

    #[test]
    fn a_seek_window_maps_its_audio_stream_by_the_absolute_index() {
        // The preferred stream of the file is its second audio stream, at index 3 (ADR 070).
        let path = Path::new("/media/two-tracks.mkv");
        for audio in [AudioMode::Copy, AudioMode::Transcode] {
            let remux = seek_remux_arguments(
                path,
                SeekContainer::Matroska,
                Some(10.0),
                60.0,
                audio,
                Some(3),
                false,
            );
            assert!(joined(&remux).contains("-i /media/two-tracks.mkv -map 0:v:0 -map 0:3 -c copy"));
            assert!(!remux.iter().any(|a| a == "0:a:0"));
        }
        let pcm = seek_pcm_arguments(path, Some(10.0), 25.0, 10.0, 3);
        assert!(joined(&pcm).contains("-i /media/two-tracks.mkv -map 0:3 -af aresample=48000"));
        assert!(!pcm.iter().any(|a| a == "0:a:0"));
    }

    #[test]
    fn a_seek_window_with_no_audio_stream_maps_no_audio() {
        let remux = joined(&seek_remux_arguments(
            Path::new("/media/a.ts"),
            SeekContainer::MpegTs,
            None,
            60.0,
            AudioMode::Copy,
            None,
            true,
        ));
        assert!(remux.contains("-map 0:v:0 -c copy -f mp4"));
        assert!(!remux.contains("aac_adtstoasc"));
        assert_eq!(remux.matches("-map").count(), 1);
    }

    #[test]
    fn an_flv_window_keeps_the_first_audio_stream_of_its_input() {
        for audio in [AudioMode::Copy, AudioMode::Transcode] {
            assert!(joined(&flv_remux_arguments(audio)).contains("-map 0:v:0 -map 0:a:0 -c copy"));
        }
        assert!(joined(&flv_pcm_arguments(0)).contains("-i pipe:0 -map 0:a:0 -af"));
    }
}
