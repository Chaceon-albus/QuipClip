/**
 * Simplified Chinese (zh-CN) message catalog for QuipClip.
 *
 * Maintains full semantic key parity with the source English catalog.
 * See ADR 011 (Localized interface with i18next).
 */

import type { TranslationCatalog } from "../types";

export const zhCN: TranslationCatalog = {
  app: {
    name: "QuipClip",
  },
  window: {
    minimize: "最小化",
    toggleMaximize: "切换最大化/还原",
    close: "关闭",
  },
  titleBar: {
    menu: {
      file: "文件",
      openMedia: "打开媒体...",
      newProject: "新建项目",
      openProject: "打开项目...",
      save: "保存",
      export: "导出...",
    },
    project: {
      untitled: "未命名项目",
      saved: "已保存",
      edited: "已编辑",
    },
  },
  dialog: {
    videoFilter: "视频文件",
  },
  preview: {
    noMedia: "未加载媒体",
    loading: "正在加载媒体...",
    videoPlayerLabel: "视频预览：{{fileName}}",
    decodeError: "原生播放失败，预览此格式需要生成代理文件。",
    zoom: {
      fit: "适应窗口",
      zoom50: "50%",
      zoom100: "100%",
      zoom200: "200%",
    },
    action: {
      fullscreen: "全屏",
      toggleFullscreen: "切换全屏",
    },
  },
  transport: {
    action: {
      undo: "撤销",
      redo: "重做",
      markIn: "入点",
      markInDetail: "标记入点",
      markInAria: "标记入点",
      markOut: "出点（不含）",
      markOutDetail: "标记出点（不含）",
      markOutAria: "标记出点（不含）",
      split: "分割",
      splitDetail: "裁剪片段",
      splitAria: "分割片段",
      play: "播放",
      pause: "暂停",
      previousFrame: "上一帧",
      nextFrame: "下一帧",
    },
  },
  timeline: {
    emptyPrompt: "打开视频文件以查看时间轴",
    sourceLane: "源媒体",
    playhead: "播放头",
  },
  mediaError: {
    invalidPath: "所选文件路径无效。",
    pathNotFound: "未找到所选文件。",
    pathNotFile: "所选路径不是常规文件。",
    pathNotUnicode: "文件路径包含无效的 Unicode 字符。",
    metadataFailed: "读取文件元数据失败。",
    unsafeMetadata: "文件元数据超出安全限制。",
    appDataUnavailable: "应用程序数据目录不可用。",
    ffmpegPairMissing: "未找到所需的 FFmpeg 或 FFprobe 可执行文件。",
    ffprobeSpawnFailed: "启动 ffprobe 进程失败。",
    ffprobeProcessFailed: "ffprobe 检测媒体文件失败。",
    ffprobeParseFailed: "解析媒体检测输出失败。",
    assetScopeDenied: "资源协议拒绝访问该媒体文件。",
    commandExecutionFailed: "媒体导入命令执行失败。",
    dialogFailed: "打开文件选择对话框失败。",
    unknown: "导入媒体时发生未知错误。",
  },
  playbackError: {
    playbackFailed: "播放启动失败。",
    seekFailed: "跳转到指定帧失败。",
  },
  statusBar: {
    projectResolution: "项目分辨率：{{width}} × {{height}}",
    projectResolutionDefault: "项目分辨率：1920 × 1080",
    frameRate: "帧率：{{fps}} fps",
    frameRateDefault: "帧率：25 fps",
    settings: "设置",
  },
  settings: {
    title: "设置",
    language: {
      label: "语言",
      system: "系统默认",
      en: "English",
      zhCN: "简体中文",
    },
  },
  common: {
    ok: "确定",
    cancel: "取消",
    close: "关闭",
    save: "保存",
    error: "错误",
    loading: "加载中...",
  },
};
