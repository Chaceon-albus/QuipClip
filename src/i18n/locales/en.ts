/**
 * Source English message catalog for QuipClip.
 *
 * See ADR 011 (Localized interface with i18next).
 */

export const en = {
  app: {
    name: "QuipClip",
  },
  window: {
    minimize: "Minimize",
    toggleMaximize: "Toggle maximize/restore",
    close: "Close",
  },
  titleBar: {
    menu: {
      file: "File",
      openMedia: "Open Media...",
      newProject: "New Project",
      openProject: "Open Project...",
      save: "Save",
      export: "Export...",
    },
    project: {
      untitled: "Untitled Project",
      saved: "Saved",
      edited: "Edited",
    },
  },
  dialog: {
    videoFilter: "Video Files",
  },
  preview: {
    noMedia: "No media loaded",
    loading: "Loading media...",
    videoPlayerLabel: "Video preview for {{fileName}}",
    decodeError: "Native playback failed. A proxy is required to preview this format.",
    approximate: "Approx.",
    zoom: {
      fit: "Fit",
      zoom50: "50%",
      zoom100: "100%",
      zoom200: "200%",
    },
    action: {
      fullscreen: "Fullscreen",
      toggleFullscreen: "Toggle Fullscreen",
    },
  },
  transport: {
    action: {
      undo: "Undo",
      redo: "Redo",
      markIn: "In",
      markInDetail: "Mark In",
      markInAria: "Mark In Point",
      markOut: "Out (Exclusive)",
      markOutDetail: "Mark Out (Exclusive)",
      markOutAria: "Mark Out Point (Exclusive)",
      split: "Split",
      splitDetail: "Cut Clip",
      splitAria: "Split Segment",
      play: "Play",
      pause: "Pause",
      previousStep: "Nudge Backward",
      nextStep: "Nudge Forward",
    },
  },
  timeline: {
    emptyPrompt: "Open a video file to view the timeline",
    sourceLane: "Source Media",
    playhead: "Playhead",
    seekSlider: "Timeline seek",
  },
  mediaError: {
    invalidPath: "The selected file path is invalid.",
    pathNotFound: "The selected file was not found.",
    pathNotFile: "The selected path is not a regular file.",
    pathNotUnicode: "The file path contains invalid Unicode characters.",
    metadataFailed: "Failed to read file metadata.",
    unsafeMetadata: "The file metadata exceeds safe limits.",
    appDataUnavailable: "The application data directory is unavailable.",
    ffmpegPairMissing: "Required FFmpeg or FFprobe executable was not found.",
    ffprobeSpawnFailed: "Failed to start the ffprobe process.",
    ffprobeProcessFailed: "ffprobe failed to inspect the media file.",
    ffprobeParseFailed: "Failed to parse media probe output.",
    assetScopeDenied: "Access to the media file was denied by the asset protocol.",
    commandExecutionFailed: "The media import command failed to execute.",
    dialogFailed: "Failed to open the file selection dialog.",
    unknown: "An unknown error occurred while importing media.",
  },
  playbackError: {
    playbackFailed: "Failed to start playback.",
    seekFailed: "Failed to seek to the requested position.",
  },
  statusBar: {
    projectResolution: "Project Resolution: {{width}} × {{height}}",
    projectResolutionDefault: "Project Resolution: 1920 × 1080",
    sourceNominalRate: "Source Nominal Rate: {{fps}} fps",
    sourceNominalRateUnavailable: "Source Nominal Rate: —",
    settings: "Settings",
  },
  settings: {
    title: "Settings",
    language: {
      label: "Language",
      system: "System Default",
      en: "English",
      zhCN: "简体中文",
    },
  },
  common: {
    ok: "OK",
    cancel: "Cancel",
    close: "Close",
    save: "Save",
    error: "Error",
    loading: "Loading...",
  },
} as const;
