//! The one slot of the measurements of loudness (ADR 061).
//!
//! A measurement follows the envelope job of ADR 056: one runs at a time in the application, a
//! request carries the time of its page, a page load sets a floor and cancels the running
//! measurement, and the exit closes the registry. The rules are those of
//! [`WaveformJobs`](crate::ffmpeg::waveform::registry::WaveformJobs), so the measurement uses that
//! registry, in an instance of its own. Its slot is therefore separate from the slot of the
//! envelope and from the export queue (ADR 049): a measurement and an envelope can run at the
//! same time.

use crate::ffmpeg::waveform::registry::WaveformJobs;
use std::ops::Deref;

/// The registry of the measurements, managed by Tauri apart from the registry of the envelope.
#[derive(Default)]
pub struct LoudnessJobs(WaveformJobs);

impl Deref for LoudnessJobs {
    type Target = WaveformJobs;

    fn deref(&self) -> &WaveformJobs {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffmpeg::waveform::registry::Refusal;

    #[test]
    fn a_measurement_holds_a_slot_of_its_own() {
        let envelopes = WaveformJobs::default();
        let measurements = LoudnessJobs::default();
        let envelope = envelopes.begin(10).unwrap();
        let measurement = measurements.begin(10).unwrap();
        assert_eq!(measurements.begin(11).unwrap_err(), Refusal::Busy);
        measurements.finish(measurement.id);
        assert!(measurements.begin(12).is_ok());
        envelopes.finish(envelope.id);
    }

    #[test]
    fn a_page_load_and_the_exit_refuse_the_requests_of_the_measurement() {
        let measurements = LoudnessJobs::default();
        let running = measurements.begin(10).unwrap();
        measurements.cancel_all(20);
        assert!(running.is_canceled());
        measurements.finish(running.id);
        assert_eq!(measurements.begin(19).unwrap_err(), Refusal::Superseded);
        measurements.close_for_exit();
        assert_eq!(measurements.begin(30).unwrap_err(), Refusal::Closed);
    }
}
