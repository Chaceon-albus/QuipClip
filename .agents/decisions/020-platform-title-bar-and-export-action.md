# 020. Split the title bar by platform and keep one export action in it

- Status: Accepted
- Date: 2026-09-21
- Deciders: capric98

## Context

QuipClip draws its own title bar. No record stated why, or what each platform
gets. The rules existed only in one component and in two configuration files.

Tauri merges a platform configuration file over the base file. A platform file
replaces the whole `windows` array. It does not merge the entries of that array.
`src-tauri/tauri.macos.conf.json` and `src-tauri/tauri.windows.conf.json`
therefore repeat every window property. A file that listed only the difference
would discard the size, the minimum size and the drag-and-drop setting.

The two platforms need different chrome:

- macOS takes `titleBarStyle: "Overlay"` and `hiddenTitle: true`. The system
  draws the three window buttons over the top left of the web view. The system
  draws no title text.
- Windows takes `decorations: false`. The system draws nothing. The application
  therefore draws a minimize button, a maximize button and a close button.

The title bar has three zones. The left zone held the application icon, the
application name, a separator and the File menu. The centre zone holds the name
of the open file. The right zone held the window buttons of Windows. The right
zone held nothing on macOS.

The left zone starts 78 pixels from the left edge on macOS. The three system
buttons occupy that space. That reservation pushed the icon and the name to the
right, and the result looked unbalanced. The user reported it.

Export had one entry point, an item in the File menu. Export is the purpose of
the application. A user does it every session, and a menu item is a poor place
for such an action.

## Decision

The three zones carry different content on each platform.

The left zone holds only the File menu on macOS. It holds the application icon,
the application name, a separator and the File menu on every other platform.

macOS puts the identity of an application in the menu bar. A document window
there shows the name of the document. A window that repeats the name of the
application disagrees with every other application on that system. The centre
zone already shows the name of the open file, so the bar already carries the
identity the user needs.

The 78 pixel reservation stays. It is the width the three system buttons need.
The space to the left of the File menu is empty on macOS, and that is correct.

(Changed on 2026-09-24.) The three system buttons are centred vertically in the 40 pixel
bar. Tauri 2.11 cannot move them in a window that is already open, so on macOS the main
window is not created from the configuration (`create: false`). A setup hook measures the
close button of a hidden probe window of the same style, its height `h` and its distance
`b` from the bottom of the title bar, and builds the main window from the same
configuration with the vertical position `y = floor((39 − h) / 2) + b` and the horizontal
position 12. On macOS 26 and later that gives `y = 21`, which is also the configured
fallback. The reservation is 84 pixels: 12, three buttons at a 23 point spacing, and a 12
pixel gap. In full screen the buttons are hidden, and the reservation becomes the normal
12 pixel padding.

The right zone holds the export button, before the window buttons. The zone is
empty on macOS, so the button sits at the right edge there. The button sits to
the left of the minimize button on Windows. Both positions agree with the
conventions of their platform.

The export button and the File menu item call one handler. The dialog has one
mount, in the title bar component, so the button needs no new state.

The button is disabled only while no media is open. The export flow controller
examines the segments, the source revision and the `ffmpeg` installation. It
reports each failure with its own code. A second condition on the button would
duplicate a rule that already exists, and the two copies would disagree.

`src/lib/platform.ts` holds the platform test. It has a pure function that reads
a user agent string. It has a second function that reads the environment. The
pure function has unit tests. The title bar component held that logic before this
decision, as a private function, and no unit test covered it.

## Consequences

- The platform test reads the user agent. Everything that is not macOS takes the
  Windows branch. Linux therefore gets the Windows title bar.
- Linux has no configuration file of its own. It keeps the native decorations of
  the base configuration, and it also draws the application title bar. The result
  is two title bars. This is a known fault. Linux is not a target of version 1,
  and this record does not correct it.
- A change to one platform configuration file must repeat every window property.
  A reader who removes a repeated property removes it from that platform.
- The export action has two entry points. A change to the export flow must keep
  both correct, because both call one handler.
- The title bar is the drag surface of the window. Every control added to it must
  take its own clicks. If a control does not, the user drags the window instead
  of operating the control.
- (Added on 2026-09-23.) The centre of the title bar shows the open file name, with the
  extension kept when the name is cut, and the number of segments. With no media, macOS
  shows a muted "QuipClip" and Windows shows nothing, because its left area already names
  the application. The native window title follows the file as "<file> — QuipClip", so
  Mission Control, the Window menu, the task bar and Alt+Tab name the file, although no
  platform draws that title in the window. This needs the `core:window:allow-set-title`
  permission. The full path is in a hover tooltip only, because a focusable title would
  stop the window drag.
