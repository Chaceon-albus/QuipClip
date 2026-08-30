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
  preview: {
    noMedia: "未加载媒体",
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
    track: {
      videoTrack: "V1",
      toggleVisibility: "切换轨道可见性",
      toggleLock: "切换轨道锁定",
    },
    playhead: "播放头",
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
