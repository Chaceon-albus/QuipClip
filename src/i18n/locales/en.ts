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
      openMedia: "Open Media…",
      export: "Export…",
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
      openVideo: "Open Video…",
      dropHint: "or drop a video file here",
    },
    loading: "Loading media…",
    // Screen reader text only. A polite live region says it once when the buffering spinner
    // shows: during playback, the video waited for data for more than a short time.
    buffering: "Buffering",
    videoPlayerLabel: "Video preview for {{fileName}}",
    // The current time under the video is a button. It becomes a text field where the user
    // types a time to go to (ADR 028). `currentTime` is screen reader text before the value on
    // the button, and `openHint` describes the button. `fieldLabel` names the field, and
    // `fieldHint` describes it in the timecode format of the video. An `error` message shows
    // above the field when the typed text is not a time that QuipClip can go to. `+` and `-`
    // are the characters that the user types. After `+` or `-` the user types a time in the
    // same format: in the frame format `+10` is 10 frames, and in the millisecond format `+1.5`
    // is 1.5 seconds.
    timecodeEntry: {
      currentTime: "Current time",
      openHint: "Press Enter to type a time to go to.",
      fieldLabel: "Go to time",
      fieldHint: {
        frames:
          "Type a time as HH:MM:SS:FF. To go forward or back, type + or - and a time, for example +10 for 10 frames. Press Enter to go to the time. Press Escape to cancel.",
        milliseconds:
          "Type a time as HH:MM:SS.mmm. To go forward or back, type + or - and a time, for example +1.5 for 1.5 seconds. Press Enter to go to the time. Press Escape to cancel.",
      },
      error: {
        invalid: {
          frames:
            "This is not a time. Type a time as HH:MM:SS:FF, for example 00:01:05:12, or type + or - and a time, for example +10 for 10 frames.",
          milliseconds:
            "This is not a time. Type a time as HH:MM:SS.mmm, for example 00:01:05.500, or type + or - and a time, for example +1.5 for 1.5 seconds.",
        },
        tooManyDecimals: "Type a maximum of three digits after the decimal point.",
        tooLarge: "This time is too large.",
      },
    },
    // The badges in the corner of the picture while the frame on screen is a segment
    // boundary. `in` and `out` are the badge text, which shows in capital letters. Each other
    // message is one line of the tooltip of a badge, and a polite live region reads the lines
    // once when the badge shows. {{index}} is the segment number, as in `timeline.segment`. The
    // Out point is the first frame after the segment, so that frame is not in the segment.
    boundaryBadge: {
      in: "In",
      out: "Out",
      inOfSegment:
        "This frame is the In point of segment {{index}}. It is the first frame of the segment.",
      inPending:
        "This frame is the pending In point. Mark an Out point to make a segment.",
      outOfSegment:
        "This frame is the Out point of segment {{index}}. It is the first frame after the segment. It is not in the segment.",
    },
    // The accessible name of the preview area. The focus returns to it when a notice that
    // held the focus leaves.
    regionLabel: "Preview",
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
      openAnother: "Open Another File…",
    },
    // The notices over an open video. An import error stays until the user dismisses it or
    // opens another file. A playback error leaves by itself after a few seconds. `dismiss`
    // is the accessible name of the close button of a notice.
    notice: {
      dismiss: "Dismiss",
    },
    // An import that failed. With no video open, the error takes the place of the empty
    // state: `title`, then the `mediaError` message, then `ffmpegHint` for an error that the
    // FFmpeg settings can correct, then the actions. `ffmpegHint` names the Settings dialog
    // and its FFmpeg tab (`settings.title`, `settings.tab.ffmpeg`), and the button
    // `chooseAnother` with its label. Running text names a label without its ellipsis.
    // `details.show` and `details.hide` label the disclosure of the diagnostic text from the
    // operating system or ffprobe, which is never translated, while it is closed and while it
    // is open. They match `export.details`. The Copy button and its feedback use
    // `common.diagnostic`.
    importError: {
      title: "QuipClip could not open the video",
      ffmpegHint:
        "Install FFmpeg, or set its location in Settings > FFmpeg. Then choose the video again with Choose Another File.",
      chooseAnother: "Choose Another File…",
      openSettings: "Open Settings…",
      details: {
        show: "Show Details",
        hide: "Hide Details",
      },
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
      markOutAria: "Mark Out Point (First Frame After the Segment)",
      split: "Split",
      splitAria: "Split Segment at Playhead",
      // Ends the segment that is being built: the current segment, or a pending In point.
      // The next Mark In then starts a new segment. The English word "finish" also names
      // the last phase of an export, when QuipClip saves the output file
      // (`export.status.publishing`, `statusBar.export.publishing`). The two are different
      // actions, so a translation can use a different word for each.
      finishSegment: "Finish",
      finishSegmentAria: "Finish Segment",
      deleteSegment: "Delete",
      deleteSegmentAria: "Delete Current Segment",
      play: "Play",
      pause: "Pause",
      previousStep: "Step Back One Frame",
      nextStep: "Step Forward One Frame",
      // A toggle. The name stays the same while it is on, and the button reports the state.
      // It silences the preview and the frame step sound, not the export.
      mute: "Mute Audio",
    },
    // The description of Mark In while an In point waits for its Out point. It is the second
    // line of the tooltip, and assistive technology reads it on the button.
    state: {
      inPending: "An In point is pending. Mark an Out point to make a segment.",
    },
    // The label above the duration at the right end of the transport bar. `segment` names the
    // current segment. {{index}} is its number, as in `timeline.segment`. `pending` names the
    // segment from the pending In point to the frame on screen, before Mark Out makes it.
    segmentDuration: {
      segment: "Segment {{index}} duration",
      pending: "New segment duration",
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
      numpad: "Num",
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
    segmentLabel:
      "Segment {{index}}, In {{inTime}}, Out {{outTime}}, duration {{duration}}",
    segmentDescription:
      "Export order: {{order}} of {{total}}. The Out point is the first frame after the segment.",
    // `notIncluded` follows the Out time in the tooltip. The Out time is the first frame
    // after the segment.
    segmentTooltip: {
      exportOrder: "Export order: {{order}} of {{total}}",
      in: "In",
      out: "Out",
      notIncluded: "(not in the segment)",
      duration: "Duration",
    },
    pendingInFlag: "In",
    // The label of the hover line in the ruler. {{time}} is the time under the pointer, as a
    // timecode such as "00:01:23:04". It comes from a pixel position, so "≈" marks it as
    // approximate.
    hoverTime: "≈ {{time}}",
    // The notice of a drag trim of a segment edge that ended with no change, because the frame
    // of the target did not arrive in time or another action replaced the trim.
    trimNotApplied: "The trim was not applied.",
    zoom: {
      group: "Timeline zoom",
      zoomIn: "Zoom In",
      zoomOut: "Zoom Out",
      fit: "Zoom to Fit",
    },
    // The splitter between the preview and the timeline. `label` is its accessible name.
    // `value` is the text that assistive technology reads for its value. {{height}} is the
    // height of the timeline in CSS pixels, such as "180".
    splitter: {
      label: "Timeline height",
      value: "{{height}} pixels",
    },
  },
  mediaError: {
    invalidPath: "The selected file path is invalid.",
    pathNotFound: "The selected file was not found.",
    pathNotFile: "The selected path is not a regular file.",
    pathNotUnicode: "The file path contains invalid Unicode characters.",
    metadataFailed: "QuipClip could not read the file metadata.",
    unsafeMetadata: "The file metadata exceeds safe limits.",
    appDataUnavailable: "The application data directory is unavailable.",
    ffmpegPairMissing:
      "QuipClip could not find the required FFmpeg or ffprobe program.",
    ffprobeSpawnFailed: "QuipClip could not start the ffprobe process.",
    ffprobeProcessFailed: "ffprobe could not examine the media file.",
    ffprobeParseFailed: "QuipClip could not parse the ffprobe output.",
    ffprobeTimedOut:
      "ffprobe did not answer in time. The file might be on a drive or a share that stopped responding.",
    assetScopeDenied: "The asset protocol denied access to the media file.",
    commandExecutionFailed: "QuipClip could not run the media import command.",
    dialogFailed: "QuipClip could not open the file selection dialog.",
    unknown: "An unknown error occurred while importing media.",
  },
  playbackError: {
    playbackFailed: "QuipClip could not start playback.",
    seekFailed: "QuipClip could not seek to the requested position.",
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
    // The warning chip for a video that cannot calibrate. It stays for the whole session, so
    // its tooltip, `approximatePositionDetail` then `approximatePositionMarks`, gives a next
    // step. `approximatePosition` is also the accessible name of the badge beside the
    // preview timecode, which shows the same tooltip.
    approximatePosition: "Approximate position · marking unavailable",
    approximatePositionDetail:
      "The playhead follows the system player clock, not the exact frame timestamp.",
    approximatePositionMarks:
      "Mark In, Mark Out, and Split are unavailable for this video. They can become available if you convert the video to MP4 and open the converted file.",
    // The neutral chip while a video that was just opened calibrates. It names the preview, so
    // it cannot be read as `export.preparing`. Its tooltip shows `preparingPositionDetail`,
    // then `preparingPositionMarks`.
    preparingPosition: "Preparing the preview…",
    preparingPositionDetail:
      "The preview waits for the first frame of the video to find the exact frame timestamps.",
    preparingPositionMarks:
      "Mark In, Mark Out, and Split stay unavailable until the exact frame timestamp is known.",
    settings: "Settings",
    export: {
      preparing: "Preparing export…",
      running: "Exporting {{percent}}",
      runningUnknown: "Exporting…",
      runningWithRemaining: "Exporting {{percent}} · {{time}} left",
      remaining: "{{time}} left",
      publishing: "Finishing…",
      canceling: "Stopping…",
      // A Stop request failed, and the export continues (ADR 025).
      stopFailed: "Stop failed · export continues",
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
      pathLabel: "FFmpeg in Use",
      pathUnset: "No path set",
      chooseFolder: "Choose Folder…",
      chooseFile: "Choose File…",
      useAutomatic: "Use Automatic Detection",
      reprobe: "Check Again",
      // Spoken once when a check starts. The visible status line gives the steps.
      checking: "Checking FFmpeg…",
      hint: "Choose a folder or a single file. If possible, choose a folder that holds both FFmpeg and ffprobe.",
      source: {
        user: "Chosen by you:",
        automatic: "Detected automatically:",
        notDetected: "QuipClip did not detect FFmpeg automatically.",
        // The check stopped before QuipClip found a program. The status block names the cause.
        unknown:
          "QuipClip could not identify which FFmpeg to use. The status below gives the reason.",
      },
      origin: {
        path: "Found in a folder in PATH.",
        pathMac: "Found in a folder in PATH or in a standard Homebrew folder.",
        appData: "Found in the bin folder in the QuipClip application data folder.",
      },
      fallback:
        "QuipClip cannot use the path that you chose. It uses the FFmpeg that it detected automatically.",
      unusable:
        "QuipClip cannot use the path that you chose, and it did not detect FFmpeg in another location.",
      // A label. The chosen path follows it on its own line.
      chosenPath: "Chosen path:",
      // The Copy button and its result use the `common.diagnostic` messages.
      install: {
        title: "Install FFmpeg",
        macPrerequisite:
          "Homebrew must be installed first. For the Homebrew install steps, go to <mono>{{url}}</mono>.",
        macIntro: "To install FFmpeg with Homebrew, run this command in Terminal:",
        // Names the Check Again button with its exact label (`settings.ffmpeg.reprobe`).
        macAfter:
          "After the install, click Check Again. QuipClip always searches the standard Homebrew folders, so you do not have to restart QuipClip.",
        windowsIntro:
          "To install FFmpeg with winget, run this command in PowerShell or Command Prompt:",
        windowsAfter:
          "After the install, quit QuipClip and open it again from the Start menu. QuipClip gets PATH when it starts, and a terminal that was open before the install still has the old PATH.",
      },
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
      restoreBuiltIn: "Restore Built-in Presets",
      moreActions: "More Actions",
      setDefault: "Set as Default",
      defaultBadge: "Default",
      encoderMarkTitle: "Encoder: {{name}}",
      empty: "No presets yet.",
      noSelection: "No preset selected.",
      rowSummaryCrf: "{{container}} · {{encoder}} · CRF {{value}}",
      rowSummaryBitrate: "{{container}} · {{encoder}} · {{value}} kbps",
      rowSummaryQualityScale: "{{container}} · {{encoder}} · Quality scale {{value}}",
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
        descriptionDefault:
          "You cannot undo this action. This preset is the default preset, so “{{next}}” will become the default preset.",
        descriptionLast:
          "You cannot undo this action. This is the only preset, so no preset will be the default preset.",
        confirm: "Delete",
      },
      restoreDialog: {
        title: "Restore the built-in presets?",
        description:
          "This restores the built-in presets to their original settings, including the built-in presets that you deleted. It replaces the changes that you made to them. Your own presets and the FFmpeg location stay as they are.",
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
        "QuipClip tests a fixed set of encoders, and this name is not in that set. QuipClip does not know whether this FFmpeg build has the encoder until an export uses it.",
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
    loading: "Loading…",
    diagnostic: {
      copy: "Copy",
      copied: "Copied",
      selectedMac: "The text is selected. Press ⌘C to copy it.",
      selectedWindows: "The text is selected. Press Ctrl+C to copy it.",
    },
  },
  ffmpeg: {
    status: {
      locating: "Locating FFmpeg…",
      probing: "Probing FFmpeg ({{done}}/{{total}})…",
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
    ffmpegPairMissing:
      "QuipClip could not find the required FFmpeg or ffprobe program.",
    ffmpegSpawnFailed: "QuipClip could not start the FFmpeg process.",
    ffmpegProcessFailed: "The FFmpeg process failed during capability probing.",
    versionParseFailed: "QuipClip could not parse the FFmpeg version output.",
    encoderListParseFailed: "QuipClip could not parse the FFmpeg encoder list.",
    cacheUnavailable: "The FFmpeg capability cache is unavailable.",
    commandExecutionFailed:
      "QuipClip could not run the FFmpeg capability probe command.",
    unknown: "An unknown error occurred while probing FFmpeg.",
  },
  settingsError: {
    appDataUnavailable: "The application data directory is unavailable.",
    readFailed: "QuipClip could not read the settings file.",
    permissionDenied: "QuipClip does not have permission to access the settings file.",
    writeFailed: "QuipClip could not write the settings file.",
    invalidJson: "The settings file contains invalid JSON.",
    invalidSettings: "The settings file contains invalid settings values.",
    unsafeSettingsValue: "A settings value exceeds safe limits.",
    futureSchemaVersion: "The settings file is from a newer version of QuipClip.",
    settingsUnreadable:
      "QuipClip could not read the existing settings file, so it did not overwrite the file.",
    settingsConflict:
      "Another window or another copy of QuipClip saved the settings after this copy loaded them. QuipClip did not save your change, so that it does not replace the other change. The settings shown are now the ones on disk. Apply your change again.",
    backupFailed: "QuipClip could not back up the existing settings file.",
    invalidPath: "The configured FFmpeg path is invalid.",
    commandExecutionFailed: "QuipClip could not run the settings command.",
    dialogFailed: "QuipClip could not open the file selection dialog.",
    unknown: "An unknown error occurred while processing settings.",
  },
  export: {
    title: "Export Video",
    setup: {
      // The first line of the setup step. {{fileName}} is the name of the open file with its
      // extension, shortened in the middle when it is long. {{duration}} is the total duration
      // of the segments, as the Export tooltip shows it: "00:01:23:04" or "00:01:23.160".
      summary_one: "Export {{count}} segment from {{fileName}} · {{duration}} in total",
      summary_other:
        "Export {{count}} segments from {{fileName}} · {{duration}} in total",
      presetLabel: "Preset",
      qualityLabel: "Quality",
      value: "{{value}}",
      qualityCrf: "CRF {{value}}",
      qualityBitrate: "{{value}} kbps",
      qualityScale: "Quality scale {{value}}",
      audioBitrateLossless: "Lossless",
      resolutionValue: "{{width}} × {{height}}",
      frameRateValue: "{{value}} fps",
      // A "Same as Source" value with the value of the open file. {{value}} of the frame rate is
      // a number such as "29.97", and {{value}} of the sample rate is a number of kHz such as
      // "48" or "44.1".
      sourceResolution: "Same as Source ({{width}} × {{height}})",
      sourceFrameRate: "Same as Source ({{value}} fps)",
      sourceSampleRate: "Same as Source ({{value}} kHz)",
      sourceChannels_one: "Same as Source ({{count}} channel)",
      sourceChannels_other: "Same as Source ({{count}} channels)",
      noSourceAudio: "The source has no audio, so the exported file has no audio.",
      // {{size}} is a number with its unit, such as "120 MB" or "1.2 GB".
      estimatedSize: "Estimated size: about {{size}}",
      estimatedSizeBelowOneKilobyte: "Estimated size: less than 1 kB",
      noPresets: "No export presets exist. Add one in Settings.",
      settingsErrorHint: "Open Settings to repair or reset the settings file.",
    },
    status: {
      preparing: "Preparing export…",
      running: "Exporting…",
      runningPercent: "Exporting {{percent}}",
      remaining: "About {{time}} left",
      frames: "Frame {{frame}} of {{expectedFrames}}",
      speed: "{{speed}}×",
      publishing: "Finishing…",
      canceled: "The export was stopped.",
      canceling: "Stopping…",
      cancelingNote:
        "If the export is already finishing, it can still save the output file.",
      cancelingNotePublishing:
        "The export is already finishing. It will still save the output file.",
      stopUnavailable: "The export is finishing. You cannot stop it now.",
      // A Stop request that failed while the export continues (ADR 025).
      stopFailed: "QuipClip could not stop the export. The export continues.",
    },
    // The readout of an active run in the dialog. `<num>` wraps the frame number, which the
    // dialog shows in a slot as wide as the total, so the line does not move as it counts.
    // Each combination of the frame count and the speed is one sentence (ADR 011).
    progress: {
      framesAndSpeed: "Frame <num>{{frame}}</num> of {{expectedFrames}} · {{speed}}×",
      frames: "Frame <num>{{frame}}</num> of {{expectedFrames}}",
      frameCountAndSpeed: "Frame {{frame}} · {{speed}}×",
      frameCount: "Frame {{frame}}",
      elapsed: "Elapsed {{time}}",
    },
    finished: {
      title: "Export finished",
      folder: "In {{folder}}",
      folderAndElapsed: "In {{folder}} · Took {{elapsed}}",
    },
    // The title of the export dialog while it asks for a confirmation, because the video file
    // on disk changed after it was opened. The dialog shows `exportError.sourceRevisionChanged`
    // below the title, and the buttons Re-import, Cancel, and Export Anyway.
    sourceChanged: {
      title: "Export the changed video?",
    },
    action: {
      chooseDestination: "Export…",
      exportAnyway: "Export Anyway",
      reimport: "Re-import…",
      runInBackground: "Run in Background",
      stop: "Stop Export",
      stopConfirm: "Confirm Stop",
      hide: "Hide (export continues)",
      revealMac: "Show in Finder",
      revealWindows: "Show in File Explorer",
      open: "Open",
      done: "Done",
      openSettings: "Open Settings…",
      // Under the preset select of the setup step. Opens the Presets tab of Settings.
      managePresets: "Manage Presets…",
      back: "Back",
    },
    details: {
      show: "Show Details",
      hide: "Hide Details",
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
    settingsUnreadable: "QuipClip could not read the settings file.",
    presetNotFound: "The selected export preset was not found.",
    ffmpegPairMissing:
      "QuipClip could not find the required FFmpeg or ffprobe program.",
    ffprobeSpawnFailed: "QuipClip could not start the ffprobe process.",
    ffprobeProcessFailed: "ffprobe could not examine the media file.",
    ffprobeParseFailed: "QuipClip could not parse the ffprobe output.",
    ffprobeTimedOut:
      "ffprobe did not answer in time. The file might be on a drive or a share that stopped responding.",
    noSegments: "No segments are marked for export.",
    tooManySegments: "Too many segments are marked for export (maximum is 100).",
    invalidSegment: "One or more export segments have invalid In or Out points.",
    sourcePathInvalid: "The source file path is invalid.",
    sourceNotFound: "The source video file was not found.",
    sourceNotFile: "The selected source path is not a regular file.",
    outputPathInvalid: "The export destination path is invalid.",
    outputDirectoryMissing: "The export destination folder does not exist.",
    outputEqualsSource: "The export destination cannot be the same as the source file.",
    outputNotWritable: "QuipClip cannot write to the destination folder.",
    outputReadOnly:
      "The destination file is read-only. Unlock it, or export to a different file name.",
    sourceFrameRateUnknown:
      "QuipClip could not determine the frame rate of the source video.",
    sourceAudioRateUnknown:
      "QuipClip could not determine the sample rate of the source audio, so it cannot cut the audio exactly.",
    encoderUnavailable: "The required encoder is not available on this system.",
    ffmpegSpawnFailed: "QuipClip could not start the FFmpeg process.",
    ffmpegProcessFailed: "FFmpeg failed during video export.",
    frameCountMismatch:
      "The frame count of the exported video was incorrect, so QuipClip did not save the output file.",
    outputRenameFailed:
      "QuipClip could not save the finished video to the destination path.",
    canceled: "The export was stopped.",
    commandExecutionFailed: "QuipClip could not run the export command.",
    exportAlreadyRunning: "An export is already running.",
    dialogFailed: "QuipClip could not open the export save dialog.",
    sourceRevisionChanged:
      "The video file on disk changed after it was opened. The marked segments may no longer name the same frames.",
    unknown: "An unknown error occurred during export.",
  },
} as const;
