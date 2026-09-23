import { describe, expect, it } from "vitest";
import {
  AUDIO_SAMPLE_RATE_CHOICES,
  audioBitrateChoices,
  DEFAULT_AUDIO_BITRATE_KBPS,
  isAudioEncoderAllowedIn,
  isLosslessAudioEncoder,
  LOSSLESS_AUDIO_ENCODERS,
} from "./audioCodecs";

describe("audioCodecs", () => {
  describe("LOSSLESS_AUDIO_ENCODERS and isLosslessAudioEncoder", () => {
    it("pins lossless audio encoders to flac and alac", () => {
      expect(LOSSLESS_AUDIO_ENCODERS).toEqual(["flac", "alac"]);
    });

    it("identifies lossless audio encoders correctly", () => {
      expect(isLosslessAudioEncoder("flac")).toBe(true);
      expect(isLosslessAudioEncoder("alac")).toBe(true);
      expect(isLosslessAudioEncoder("aac")).toBe(false);
      expect(isLosslessAudioEncoder("libopus")).toBe(false);
      expect(isLosslessAudioEncoder("libmp3lame")).toBe(false);
      expect(isLosslessAudioEncoder("pcm_s16le")).toBe(false);
      expect(isLosslessAudioEncoder("")).toBe(false);
    });
  });

  describe("DEFAULT_AUDIO_BITRATE_KBPS", () => {
    it("pins DEFAULT_AUDIO_BITRATE_KBPS to 320", () => {
      expect(DEFAULT_AUDIO_BITRATE_KBPS).toBe(320);
    });
  });

  describe("audioBitrateChoices", () => {
    it("returns an empty array for lossless encoders", () => {
      expect(audioBitrateChoices("flac")).toEqual([]);
      expect(audioBitrateChoices("alac")).toEqual([]);
    });

    it("returns libopus-specific choices up to 510 kbps", () => {
      expect(audioBitrateChoices("libopus")).toEqual([
        64, 96, 128, 160, 192, 256, 320, 510,
      ]);
    });

    it("returns standard lossy choices for every other encoder name", () => {
      const standard = [96, 128, 160, 192, 256, 320];
      expect(audioBitrateChoices("aac")).toEqual(standard);
      expect(audioBitrateChoices("libmp3lame")).toEqual(standard);
      expect(audioBitrateChoices("aac_at")).toEqual(standard);
      expect(audioBitrateChoices("custom_encoder")).toEqual(standard);
      expect(audioBitrateChoices("")).toEqual(standard);
    });
  });

  describe("AUDIO_SAMPLE_RATE_CHOICES", () => {
    it("pins AUDIO_SAMPLE_RATE_CHOICES to 44100, 48000, 96000", () => {
      expect(AUDIO_SAMPLE_RATE_CHOICES).toEqual([44100, 48000, 96000]);
    });
  });

  describe("isAudioEncoderAllowedIn", () => {
    it("refuses flac and libopus in mov container", () => {
      expect(isAudioEncoderAllowedIn("mov", "flac")).toBe(false);
      expect(isAudioEncoderAllowedIn("mov", "libopus")).toBe(false);
    });

    it("allows other audio encoders in mov container", () => {
      expect(isAudioEncoderAllowedIn("mov", "aac")).toBe(true);
      expect(isAudioEncoderAllowedIn("mov", "alac")).toBe(true);
      expect(isAudioEncoderAllowedIn("mov", "libmp3lame")).toBe(true);
      expect(isAudioEncoderAllowedIn("mov", "aac_at")).toBe(true);
      expect(isAudioEncoderAllowedIn("mov", "custom_codec")).toBe(true);
    });

    it("allows flac and libopus in mp4 container", () => {
      expect(isAudioEncoderAllowedIn("mp4", "flac")).toBe(true);
      expect(isAudioEncoderAllowedIn("mp4", "libopus")).toBe(true);
      expect(isAudioEncoderAllowedIn("mp4", "aac")).toBe(true);
      expect(isAudioEncoderAllowedIn("mp4", "alac")).toBe(true);
    });

    it("allows flac and libopus in mkv container", () => {
      expect(isAudioEncoderAllowedIn("mkv", "flac")).toBe(true);
      expect(isAudioEncoderAllowedIn("mkv", "libopus")).toBe(true);
      expect(isAudioEncoderAllowedIn("mkv", "aac")).toBe(true);
      expect(isAudioEncoderAllowedIn("mkv", "alac")).toBe(true);
    });
  });
});
