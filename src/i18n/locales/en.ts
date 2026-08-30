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
  preview: {
    noMedia: "No media loaded",
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
      previousFrame: "Previous Frame",
      nextFrame: "Next Frame",
    },
  },
  timeline: {
    track: {
      videoTrack: "V1",
      toggleVisibility: "Toggle Track Visibility",
      toggleLock: "Toggle Track Lock",
    },
    playhead: "Playhead",
  },
  statusBar: {
    projectResolution: "Project Resolution: {{width}} × {{height}}",
    projectResolutionDefault: "Project Resolution: 1920 × 1080",
    frameRate: "Frame Rate: {{fps}} fps",
    frameRateDefault: "Frame Rate: 25 fps",
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
