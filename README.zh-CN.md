# QuipClip

<img src="src/assets/brand/app-icon.svg" alt="" width="96" align="right">

[English](README.md) | 简体中文

在视频上标记入点和出点，然后把标记的片段按顺序拼接导出。

QuipClip 是一款适用于 Windows 和 macOS 的小型视频编辑器，只做一件事：打开一个视频，标记需要的部分，再把它们导出为一个文件。它只有一条轨道，也没有特效。

## 项目状态

QuipClip 尚处于早期阶段。

QuipClip 可以：

- 打开并播放视频，前进或后退一帧。
- 把多个视频依次排在时间轴上。
- 预览 FLV、MPEG-TS 和 MKV 文件。
- 按源视频的显示时间戳（PTS）标记片段。
- 在时间轴上修改片段：可以拖动片段边缘、分割片段，也可以撤销编辑。
- 使用预设导出片段。输出可以同时包含视频和音频，也可以只含视频或只含音频。导出单个片段时，可以复制源音频。
- 另一个导出正在运行时，将导出加入队列。
- 查找 `ffmpeg`，并测试哪些编码器能在本机上使用。
- 以英文或简体中文显示界面，使用浅色或深色主题。

QuipClip 目前还不能：

- 保存项目文件。QuipClip 只在退出前保留片段。如果退出会丢失片段，QuipClip 会先询问。
- 下载 `ffmpeg`。必须自行安装。
- 预览 AVI 或 WMV 文件，或采用系统 WebView 无法解码的编码格式的视频。在 Windows 上，要预览 HEVC，请从 Microsoft Store 安装“HEVC 视频扩展”。

## 安装

从[发布页面](https://github.com/Chaceon-albus/QuipClip/releases)下载 QuipClip。

本文件描述的是 `main` 分支。最新发布版可能比 `main` 旧，此时本文件提到的部分功能和快捷键在该版本中不存在。

| 系统                  | 安装包                             |
| --------------------- | ---------------------------------- |
| macOS（Apple 芯片）   | `QuipClip_<version>_aarch64.dmg`   |
| Windows x64，安装程序 | `QuipClip_<version>_x64-setup.exe` |
| Windows x64，MSI      | `QuipClip_<version>_x64_en-US.msi` |

没有适用于 Intel 处理器 Mac 的安装包。

安装包没有开发者身份签名。在 Windows 上，SmartScreen 会在首次启动时显示警告。macOS 会阻止首次启动。要允许首次启动：

1. 打开**系统设置**。
2. 打开**隐私与安全性**。
3. 点击**仍要打开**。

## ffmpeg

QuipClip 不附带 `ffmpeg`。它需要位于同一文件夹中的 `ffmpeg` 和 `ffprobe`，缺少它们就无法打开视频。

- macOS，使用 [Homebrew](https://brew.sh)：`brew install ffmpeg`。安装完成后，在设置中点击**重新检测**。
- Windows，在 PowerShell 或“命令提示符”中：`winget install -e --id Gyan.FFmpeg --source winget`。安装完成后，退出 QuipClip，然后从“开始”菜单重新打开。

QuipClip 按以下顺序搜索这两个程序：

1. 在设置中设定的路径。
2. 您的 `PATH`。在 macOS 上，QuipClip 还会搜索 `/opt/homebrew/bin` 和 `/usr/local/bin`。
3. 应用程序数据文件夹中的 `bin` 文件夹：
   - Windows：`%APPDATA%\io.github.capric98.quipclip\bin`
   - macOS：`~/Library/Application Support/io.github.capric98.quipclip/bin`

## 使用

1. 打开视频：在 macOS 上按 `Cmd+O`，在 Windows 上按 `Ctrl+O`，或者把文件拖到窗口中。打开或拖入更多视频，即可将其添加到时间轴。
2. 跳转到要保留的第一帧，按 `I`。
3. 跳转到要保留的最后一帧之后的那一帧，按 `O`。出点帧不在片段内。
4. 按 `Esc` 结束该片段，然后标记下一个片段。
5. 按 `Cmd+E` 或 `Ctrl+E`。
6. 选择预设和要导出的流。
7. 点击**导出…**，然后选择文件的保存位置。

QuipClip 按标记的先后为片段编号。分割会把右半部分直接排在左半部分之后。导出按片段编号的顺序拼接片段，而不是按片段在时间轴上的位置。

一次导出最多拼接 256 个部分，最多使用 85 个源文件。在时间轴上跨过某个视频结尾的片段，会为每个视频各产生一个部分。

设置中包括 `ffmpeg` 路径、语言、主题、时间码格式和导出预设。

控件有快捷键时，其工具提示会注明该快捷键。下表列出主要快捷键。`Cmd` 是 macOS 上的按键，在 Windows 上请改用 `Ctrl`。

| 快捷键               | 操作                                                                          |
| -------------------- | ----------------------------------------------------------------------------- |
| `Space`              | 播放或暂停                                                                    |
| `/`                  | 播放当前片段，或播放头所在的片段。在该片段的最后一帧停止                      |
| `←` `→`              | 暂停时：移动一帧。播放时：跳 5 s。按住 `Shift` 时为 1 s，按住 `Cmd` 时为 30 s |
| `,` `.` 或 `D` `F`   | 移动一帧。按住 `Shift` 时移动 10 帧                                           |
| `↑` `↓`              | 跳转到上一个或下一个编辑点                                                    |
| `Home` `End`         | 跳转到开头或结尾                                                              |
| `I` `O`              | 标记入点、标记出点。在当前片段的出点处按 `O` 会结束该片段                     |
| `Shift+I` `Shift+O`  | 跳转到当前片段的入点或出点                                                    |
| `Esc`                | 结束当前片段。标记入点后，在播放头处结束片段                                  |
| `Delete` `Backspace` | 删除所选片段                                                                  |
| `Cmd+A`              | 选择全部片段                                                                  |
| `Cmd+Z`              | 撤销                                                                          |
| `Cmd+Shift+Z`        | 重做。在 Windows 上，`Ctrl+Y` 也可以重做                                      |
| `=` `-`              | 放大或缩小时间轴                                                              |
| `\` 或 `Shift+Z`     | 将时间轴缩放至适合                                                            |
| `Cmd+O` `Cmd+E`      | 打开视频、导出                                                                |
| `Cmd+,`              | 打开设置                                                                      |

## 工作原理

- 预览在系统 WebView 中播放文件。对于 FLV 和 MPEG-TS，以及 macOS 上的 MKV，`ffmpeg` 把要播放的范围复制为分片 MP4，不解码视频。然后由 WebView 通过 MediaSource 播放。
- 每个编辑点都是源视频流中的一个显示时间戳。因此编辑点能保留可变帧率的时间信息，每个源也保留各自的时间戳。
- 片段使用半开区间 `[inPts, outPts)` 作为边界。导出时用 `trim` 按源 PTS 剪切每个部分，把来自不同源的部分统一为相同的画面尺寸、帧率和音频格式，再按片段顺序拼接。
- 导出会比较输出的帧数与预期帧数。出现差异时，导出会报告差异，而不是写出错误的剪切结果。

## 构建

要求：Node 26 或更高版本、pnpm，以及 Rust 1.90 或更高版本。平台库见 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/)。

```bash
pnpm install
pnpm tauri dev      # run
pnpm tauri build    # package
```

[`AGENTS.md`](AGENTS.md) 列出了检查代码的命令。

## 文档

- [`docs/architecture.md`](docs/architecture.md) — 架构说明，以及决策记录的索引。
- [`docs/releasing.md`](docs/releasing.md) — 发布步骤。
- [`.agents/decisions/`](.agents/decisions) — 每项决策一份记录。
- [`AGENTS.md`](AGENTS.md) — agent 在本仓库中遵循的规则。

## 许可证

MIT。见 [LICENSE](LICENSE)。
