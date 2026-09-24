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
    maximize: "Maximize",
    restore: "Restore Down",
    close: "Close",
  },
  titleBar: {
    menu: {
      file: "File",
      openMedia: "Open Media...",
      export: "Export...",
    },
    action: {
      export: "Export",
    },
    // The tooltip of the Export button. openVideoFirst and markSegmentFirst are a second,
    // muted line under "Export". {{duration}} is the total duration of the segments, as a
    // timecode such as "00:01:23:04" or "00:01:23.160".
    exportTooltip: {
      openVideoFirst: "Open a video first",
      markSegmentFirst: "Mark at least one segment first",
      exportSegments_one: "Export {{count}} segment ({{duration}})",
      exportSegments_other: "Export {{count}} segments ({{duration}})",
      showRunningExport: "Show the running export",
    },
    source: {
      segmentCount_one: "{{count}} segment",
      segmentCount_other: "{{count}} segments",
    },
  },
  dialog: {
    videoFilter: "Video Files",
  },
  preview: {
    empty: {
      title: "Open a video to start marking segments",
      openVideo: "Open Video...",
      dropHint: "or drop a video file here",
    },
    loading: "Loading media...",
    videoPlayerLabel: "Video preview for {{fileName}}",
    // The panel that replaces the picture when the web view cannot play the source. The
    // `<mono>` tags wrap the technical values, which the panel shows in a monospace font.
    // {{codec}} is a codec display name such as "HEVC" or "H.264". {{profile}} is the codec
    // profile as ffprobe reports it, such as "Main 10". {{pixelFormat}} is the ffprobe pixel
    // format, such as "yuv420p10le". {{container}} is a container name such as "AVI" or
    // "MKV". The noProfile, noPixelFormat, and codecOnly variants omit a value that ffprobe
    // did not state.
    decodeFailure: {
      title: "QuipClip cannot preview this video",
      // The element plays no picture: the system player does not decode the video stream.
      unsupportedCodec: {
        full: "The system player does not support <mono>{{codec}} {{profile}}</mono> (<mono>{{pixelFormat}}</mono>).",
        noProfile:
          "The system player does not support <mono>{{codec}}</mono> (<mono>{{pixelFormat}}</mono>).",
        noPixelFormat:
          "The system player does not support <mono>{{codec}} {{profile}}</mono>.",
        codecOnly: "The system player does not support <mono>{{codec}}</mono>.",
      },
      // The element reported an error whose cause QuipClip cannot name.
      cannotPlay: {
        full: "QuipClip cannot play this file (video: <mono>{{codec}} {{profile}}</mono>, <mono>{{pixelFormat}}</mono>).",
        noProfile:
          "QuipClip cannot play this file (video: <mono>{{codec}}</mono>, <mono>{{pixelFormat}}</mono>).",
        noPixelFormat:
          "QuipClip cannot play this file (video: <mono>{{codec}} {{profile}}</mono>).",
        codecOnly: "QuipClip cannot play this file (video: <mono>{{codec}}</mono>).",
      },
      unsupportedContainer:
        "The system player cannot open <mono>{{container}}</mono> files.",
      readFailed: "QuipClip could not read the file.",
      hint: {
        installHevc:
          "Install the HEVC Video Extensions from the Microsoft Store, then restart QuipClip and open the file again.",
        convertH264: "Convert the video to H.264 (8-bit, 4:2:0) MP4 to preview it.",
        convertMp4: "Convert the video to MP4 to preview it.",
      },
      openAnother: "Open Another File...",
    },
  },
  fileDrop: {
    release: "Release to open the video",
    unsupported: "No supported video file",
    othersIgnored: "QuipClip opens one file and ignores the others.",
  },
  // The confirmations before a quit or before another video replaces the open one (ADR 027).
  // Each message below `loss` and `replace.segments` is one line of a list in the dialog,
  // which shows only the lines that apply. A replacement keeps the segments with the old
  // video, and it loses the pending In point, so its dialog reuses `loss.pendingIn`.
  quitGuard: {
    quit: {
      title: "Quit QuipClip?",
      confirm: "Quit",
    },
    replace: {
      title: "Replace the open video?",
      segments_one:
        "The marked segment stays with the open video. Open that video again to see it.",
      segments_other:
        "The {{count}} marked segments stay with the open video. Open that video again to see them.",
      confirm: "Replace",
    },
    loss: {
      segments_one: "{{count}} marked segment will be lost.",
      segments_other: "{{count}} marked segments will be lost.",
      pendingIn: "The pending In point will be lost.",
      export: "The export will stop.",
      preset: "The unsaved changes to “{{name}}” will be lost.",
      presetUnnamed: "The unsaved changes to the preset will be lost.",
    },
  },
  transport: {
    action: {
      undo: "Undo",
      redo: "Redo",
      markIn: "In",
      markInAria: "Mark In Point",
      markOut: "Out",
      markOutAria: "Mark Out Point (Exclusive)",
      split: "Split",
      splitAria: "Split Segment at Playhead",
      newSegment: "New",
      newSegmentAria: "Start New Segment",
      deleteSegment: "Delete",
      deleteSegmentAria: "Delete Current Segment",
      play: "Play",
      pause: "Pause",
      previousStep: "Step Back One Frame",
      nextStep: "Step Forward One Frame",
    },
    disabledReason: {
      preciseMarkingUnavailable: "Precise marking is unavailable for this video.",
      markInFirst: "Mark an In point first.",
      selectSegment: "Select a segment first.",
      playheadInsideSegment: "Move the playhead between the In and Out points.",
      playheadBeforeOut: "Move the playhead before the Out point.",
      playheadAfterIn: "Move the playhead after the In point.",
      atInPoint: "The playhead is already at the In point.",
      atOutPoint: "The playhead is already at the Out point.",
      noFrameRate: "The source reports no frame rate.",
    },
  },
  // The names of the keys that are words, for the key chips of the tooltips and menus. Each
  // chip is a separate element, never part of a sentence. Keep the label that is printed on
  // the key cap. The space bar has no printed label, so its name is a word of the language.
  shortcut: {
    key: {
      space: "Space",
      home: "Home",
      end: "End",
      delete: "Delete",
      backspace: "Backspace",
      escape: "Esc",
      ctrl: "Ctrl",
      shift: "Shift",
    },
  },
  timeline: {
    emptyHint: "Marked segments appear here.",
    durationUnknown: "Duration unknown — seeking is unavailable",
    sourceLane: "Source Media",
    playhead: "Playhead",
    seekSlider: "Timeline seek",
    segmentList: "Timeline segments",
    segment: "Segment {{index}}",
    pendingInFlag: "In",
  },
  mediaError: {
    invalidPath: "The selected file path is invalid.",
    pathNotFound: "The selected file was not found.",
    pathNotFile: "The selected path is not a regular file.",
    pathNotUnicode: "The file path contains invalid Unicode characters.",
    metadataFailed: "Failed to read file metadata.",
    unsafeMetadata: "The file metadata exceeds safe limits.",
    appDataUnavailable: "The application data directory is unavailable.",
    ffmpegPairMissing: "Required FFmpeg or ffprobe executable was not found.",
    ffprobeSpawnFailed: "Failed to start the ffprobe process.",
    ffprobeProcessFailed: "ffprobe failed to inspect the media file.",
    ffprobeParseFailed: "Failed to parse media probe output.",
    ffprobeTimedOut:
      "ffprobe did not answer in time. The file might be on a drive or a share that stopped responding.",
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
    source: {
      summary: "{{width}} × {{height}} · {{fps}} fps",
      summaryNoRate: "{{width}} × {{height}}",
      resolution: "Source resolution: {{width}} × {{height}}",
      rateAverage: "Nominal frame rate: {{fps}} fps (avg_frame_rate)",
      rateReal: "Nominal frame rate: {{fps}} fps (r_frame_rate)",
      rateUnavailable: "Nominal frame rate: not reported by the source",
    },
    ffmpeg: {
      settingsHint: "Click to open FFmpeg settings.",
    },
    approximatePosition: "Approximate position",
    approximatePositionDetail:
      "The playhead follows the browser clock, not the exact frame timestamp.",
    approximatePositionMarks:
      "Mark In, Mark Out, and Split stay unavailable until the exact frame timestamp is known.",
    settings: "Settings",
    export: {
      preparing: "Preparing export",
      running: "Exporting {{percent}}",
      runningUnknown: "Exporting",
      remaining: "{{time}} left",
      publishing: "Finishing",
      canceling: "Stopping",
      finished: "Export finished",
      failed: "Export failed",
      canceled: "Export stopped",
      output: "Output: {{name}}",
      showHint: "Click to show the export window.",
      dismiss: "Dismiss",
    },
  },
  settings: {
    title: "Settings",
    tab: {
      general: "General",
      ffmpeg: "FFmpeg",
      presets: "Export Presets",
    },
    resetDamaged: "Reset Settings",
    resetDamagedHint:
      "The settings file cannot be read. A reset renames it to settings.invalid.json and writes fresh defaults.",
    language: {
      label: "Language",
      system: "System Default",
      en: "English",
      zhCN: "简体中文",
    },
    appearance: {
      label: "Appearance",
      system: "System Default",
      light: "Light",
      dark: "Dark",
    },
    timecode: {
      label: "Timecode",
      frames: "Frames (HH:MM:SS:FF)",
      milliseconds: "Milliseconds (HH:MM:SS.mmm)",
      hint: "A source with a variable or unknown frame rate always shows milliseconds.",
    },
    ffmpeg: {
      section: "FFmpeg Location",
      pathLabel: "Current Path",
      pathUnset: "No path set",
      chooseFolder: "Choose Folder...",
      chooseFile: "Choose File...",
      clear: "Clear",
      reprobe: "Re-check FFmpeg",
      hint: "Choose a folder or a single file. A folder that holds both FFmpeg and FFprobe is preferred.",
    },
    preset: {
      section: "Export Presets",
      newName: "New Preset",
      newNameNumbered: "New Preset {{n}}",
      add: "Add Preset",
      duplicate: "Duplicate Preset",
      copyName: "{{name}} Copy",
      copyNameNumbered: "{{name}} Copy {{n}}",
      duplicateBlockedUnsaved: "Save or cancel your changes to duplicate this preset.",
      delete: "Delete Preset",
      restoreDefaults: "Restore Defaults",
      setActive: "Set Active",
      activeBadge: "Active",
      encoderMarkTitle: "Encoder: {{name}}",
      empty: "No presets yet.",
      limitReached: "Limit of {{max}} presets reached.",
      unsaved: "Unsaved changes",
      saveBlocked_one: "Fix {{count}} problem to save.",
      saveBlocked_other: "Fix {{count}} problems to save.",
      unsavedPrompt: "“{{name}}” has unsaved changes.",
      discardConfirm: "Discard Changes",
      discardCancel: "Keep Editing",
      saveAndSwitch: "Save and Switch",
      saveAndAdd: "Save and Add",
      dontSave: "Don’t Save",
      deleteDialog: {
        title: "Delete preset “{{name}}”?",
        description: "You cannot undo this action.",
        descriptionActive:
          "You cannot undo this action. This preset is the active preset, so “{{next}}” will become the active preset.",
        descriptionLast:
          "You cannot undo this action. This is the only preset, so no preset will be active.",
        confirm: "Delete",
      },
      restoreDialog: {
        title: "Restore the default presets?",
        description:
          "This restores the built-in presets to their original settings and adds back any you deleted. It replaces the changes you made to them. Your own presets and the FFmpeg location stay as they are.",
      },
      groupGeneral: "General",
      groupVideo: "Video",
      groupAudio: "Audio",
      nameLabel: "Name",
      containerLabel: "Container",
      videoEncoderLabel: "Video Encoder",
      audioEncoderLabel: "Audio Encoder",
      audioBitrateLabel: "Audio Bitrate",
      audioBitrateDefault: "Encoder Default",
      audioBitrateValue: "{{value}} kbps",
      audioBitrateLossless: "A lossless encoder has no bitrate setting.",
      audioSampleRateLabel: "Sample Rate",
      audioSampleRateValue: "{{value}} kHz",
      audioChannelsLabel: "Channels",
      audioChannelsStereo: "Stereo",
      audioChannelsMono: "Mono",
      qualityKindLabel: "Quality Type",
      qualityValueLabel: "Quality Value",
      qualityHintCrf: "Lower is higher quality. The scale depends on the encoder.",
      qualityHintBitrate: "Target video bitrate.",
      qualityHintQualityScale:
        "Passed to the encoder as -q:v. The scale depends on the encoder.",
      resolutionLabel: "Resolution",
      resolutionValue: "{{w}} × {{h}}",
      frameRateLabel: "Frame Rate",
      frameRateValue: "{{value}} fps",
      widthLabel: "Width",
      heightLabel: "Height",
      frameRateNumeratorLabel: "Numerator",
      frameRateDenominatorLabel: "Denominator",
      unitKbps: "kbps",
      unitPixels: "px",
      sourceOption: "Same as Source",
      customOption: "Custom…",
    },
    quality: {
      crf: "Constant Quality (CRF)",
      bitrate: "Bitrate (kbps)",
      qualityScale: "Quality Scale",
    },
    encoder: {
      available: "Available",
      unavailable: "Unavailable",
      unknown: "Not checked",
      optionLabelAvailable: "{{name}} (Available)",
      optionLabelUnavailable: "{{name}} (Unavailable)",
      optionLabelUnknown: "{{name}} (Not checked)",
      reasonNotListed: "This FFmpeg build does not include the encoder.",
      reasonFailed: "The encoder failed its test on this machine.",
      reasonTimedOut: "The encoder did not respond in time.",
      reasonNotTested:
        "QuipClip tests a fixed set of encoders, and this name is not in it. Whether this FFmpeg build has it is unknown until an export uses it.",
      reasonNotProbed: "The capability probe has not reported on this encoder yet.",
      customLabel: "Custom Encoder Name",
      customHint:
        "Use 1 to 64 characters. Start with a letter or digit. After that, use only letters, digits, underscores, periods, or hyphens.",
    },
    field: {
      required: "This field is required.",
      tooLong: "Use {{max}} characters or fewer.",
      charset:
        "Use 1 to 64 characters. Start with a letter or digit. After that, use only letters, digits, underscores, periods, or hyphens.",
      outOfRange: "Enter a value from {{min}} to {{max}}.",
      positive: "Enter a whole number above zero.",
      notInteger: "Enter a whole number.",
      containerMismatch:
        "{{container}} cannot hold {{encoder}} audio. Choose MP4 or MKV, or another audio encoder.",
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
  ffmpeg: {
    status: {
      locating: "Locating FFmpeg...",
      probing: "Probing FFmpeg ({{done}}/{{total}})...",
      ready: "FFmpeg {{version}} ({{working}} of {{tested}} encoders work)",
      readyShort: "FFmpeg {{version}}",
      missing: "FFmpeg missing",
      failed: "FFmpeg probe failed",
    },
    detail: {
      program: "Program: {{path}}",
      version: "Version: {{version}}",
      searched: "Searched: {{path}}",
      searchedPair: {
        configured: "Searched: {{path}} (ffprobe: {{probe}}, origin: Configured path)",
        path: "Searched: {{path}} (ffprobe: {{probe}}, origin: System PATH)",
        appData:
          "Searched: {{path}} (ffprobe: {{probe}}, origin: Application data directory)",
      },
      raw: "{{detail}}",
      origin: {
        configured: "Origin: Configured path",
        path: "Origin: System PATH",
        appData: "Origin: Application data directory",
      },
      license: {
        gpl: "License: GPL",
        nonfree: "License: Non-free",
        version3: "License: Version 3 (GPL/LGPL v3)",
        none: "License: Default / unflagged",
      },
      hardware: "Hardware acceleration: {{methods}}",
      hardwareNone: "Hardware acceleration: None",
      workingEncoders: "Working encoders: {{encoders}}",
      noWorkingEncoders: "Working encoders: None",
    },
  },
  ffmpegError: {
    appDataUnavailable: "The application data directory is unavailable.",
    ffmpegPairMissing: "Required FFmpeg or ffprobe executable was not found.",
    ffmpegSpawnFailed: "Failed to start the FFmpeg process.",
    ffmpegProcessFailed: "FFmpeg process failed during capability probing.",
    versionParseFailed: "Failed to parse FFmpeg version output.",
    encoderListParseFailed: "Failed to parse FFmpeg encoder list.",
    cacheUnavailable: "FFmpeg capability cache is unavailable.",
    commandExecutionFailed: "The FFmpeg capability probe command failed to execute.",
    unknown: "An unknown error occurred while probing FFmpeg.",
  },
  settingsError: {
    appDataUnavailable: "The application data directory is unavailable.",
    readFailed: "Failed to read the settings file.",
    permissionDenied: "Permission was denied while accessing the settings file.",
    writeFailed: "Failed to write the settings file.",
    invalidJson: "The settings file contains invalid JSON.",
    invalidSettings: "The settings file contains invalid settings values.",
    unsafeSettingsValue: "A settings value exceeds safe limits.",
    futureSchemaVersion: "The settings file is from a newer version of QuipClip.",
    settingsUnreadable:
      "The existing settings file could not be read, so it was not overwritten.",
    settingsConflict:
      "Another window or another copy of QuipClip saved the settings after this copy loaded them. This save was refused so that the other change is not lost. The settings shown are now the ones on disk. Apply your change again.",
    backupFailed: "Failed to back up the existing settings file.",
    invalidPath: "The configured FFmpeg path is invalid.",
    commandExecutionFailed: "The settings command failed to execute.",
    dialogFailed: "Failed to open the file selection dialog.",
    unknown: "An unknown error occurred while processing settings.",
  },
  export: {
    title: "Export Video",
    setup: {
      presetLabel: "Preset",
      qualityLabel: "Quality",
      value: "{{value}}",
      qualityCrf: "CRF {{value}}",
      qualityBitrate: "{{value}} kbps",
      qualityScale: "Quality scale {{value}}",
      audioBitrateLossless: "Lossless",
      resolutionValue: "{{width}} × {{height}}",
      frameRateValue: "{{value}} fps",
      noPresets: "No export presets exist. Add one in Settings.",
      settingsErrorHint: "Open Settings to repair or reset the settings file.",
    },
    status: {
      preparing: "Preparing export...",
      running: "Exporting...",
      runningPercent: "Exporting... {{percent}}",
      remaining: "About {{time}} left",
      frames: "Frame {{frame}} of {{expectedFrames}}",
      speed: "{{speed}}×",
      publishing: "Finishing...",
      canceled: "The export was stopped.",
      canceling: "Stopping...",
      cancelingNote:
        "If the export is already finishing, it can still save the output file.",
      cancelingNotePublishing:
        "The export is already finishing. It will still save the output file.",
      stopUnavailable: "The export is finishing. You cannot stop it now.",
    },
    finished: {
      title: "Export finished",
      folder: "In {{folder}}",
      folderAndElapsed: "In {{folder}} · Took {{elapsed}}",
    },
    action: {
      chooseDestination: "Export…",
      exportAnyway: "Export Anyway",
      reimport: "Re-import",
      runInBackground: "Run in Background",
      stop: "Stop Export",
      stopConfirm: "Confirm Stop",
      hide: "Hide (export continues)",
      revealMac: "Show in Finder",
      revealWindows: "Show in File Explorer",
      open: "Open",
      done: "Done",
    },
  },
  exportOutputError: {
    outputUnknown: "QuipClip has no record of the file from this export.",
    outputMissing:
      "The exported file is not in its saved location. It may have been moved, renamed, or deleted.",
    outputNotVideo:
      "QuipClip opens only files with a video extension (MP4, MOV, or MKV). Show the file, and then open it from its folder.",
    revealFailed: "The system could not show the file.",
    openFailed:
      "The system could not open the file. Make sure that an application is set to open this file type.",
    unknown: "QuipClip could not show or open the exported file.",
  },
  exportError: {
    appDataUnavailable: "The application data directory is unavailable.",
    settingsUnreadable: "The settings file could not be read.",
    presetNotFound: "The selected export preset was not found.",
    ffmpegPairMissing: "Required FFmpeg or ffprobe executable was not found.",
    ffprobeSpawnFailed: "Failed to start the ffprobe process.",
    ffprobeProcessFailed: "ffprobe failed to inspect the media file.",
    ffprobeParseFailed: "Failed to parse media probe output.",
    ffprobeTimedOut:
      "ffprobe did not answer in time. The file might be on a drive or a share that stopped responding.",
    noSegments: "No segments are marked for export.",
    tooManySegments: "Too many segments are marked for export (maximum is 100).",
    invalidSegment: "One or more export segments have invalid start or end points.",
    sourcePathInvalid: "The source file path is invalid.",
    sourceNotFound: "The source video file was not found.",
    sourceNotFile: "The selected source path is not a regular file.",
    outputPathInvalid: "The export destination path is invalid.",
    outputDirectoryMissing: "The export destination folder does not exist.",
    outputEqualsSource: "The export destination cannot be the same as the source file.",
    outputNotWritable: "The destination folder cannot be written to.",
    outputReadOnly:
      "The destination file is read-only. Unlock it, or export to a different file name.",
    sourceFrameRateUnknown: "The source video frame rate could not be determined.",
    sourceAudioRateUnknown:
      "The source audio sample rate could not be determined, so the audio cannot be cut exactly.",
    encoderUnavailable: "The required encoder is not available on this system.",
    ffmpegSpawnFailed: "Failed to start the FFmpeg process.",
    ffmpegProcessFailed: "FFmpeg failed during video export.",
    frameCountMismatch:
      "The exported video frame count was incorrect, so the output file was not saved.",
    outputRenameFailed: "Failed to save the finished video to the destination path.",
    canceled: "The export was stopped.",
    commandExecutionFailed: "The export command failed to execute.",
    exportAlreadyRunning: "An export is already running.",
    dialogFailed: "Failed to open the export save dialog.",
    sourceRevisionChanged:
      "The video file on disk changed after it was opened. The marked segments may no longer name the same frames.",
    unknown: "An unknown error occurred during export.",
  },
} as const;
