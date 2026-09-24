# 031. Order the buttons of a dialog by the platform, and choose each default focus

- Status: Accepted
- Date: 2026-09-24
- Deciders: capric98
- Amends: ADR 025, ADR 027

## Context

The dialogs of QuipClip put their buttons in one fixed order on both platforms. macOS and
Windows use different orders. The Apple Human Interface Guidelines put the default button at
the right end of the group, Cancel to its left, and a destructive button that discards work
at the far left. The Windows guidelines, and the WinUI content dialog, put the primary button
first and the close button last. A user who opens QuipClip next to other applications of the
same system expects the order of that system. The user chose an order for each platform.

The first Tab stop of the export and settings dialogs was the close control at the top right.
The default focus of several footers was not stated.

## Decision

One component, `DialogActions`, draws the button group of every dialog footer. A pure rule,
`orderDialogActions` in `src/components/common/dialogActionsModel.ts`, orders the buttons by
role and by platform.

| Role          | Meaning                                                   |
| ------------- | --------------------------------------------------------- |
| `primary`     | The action that the dialog exists for                     |
| `cancel`      | The action that closes the dialog with no change          |
| `discard`     | An action that throws away work, such as Don't Save       |
| `alternative` | Any other action, such as Show or Re-import               |

- **macOS:** `discard` at the far left, apart from the others, then the alternatives, then
  `cancel`, then `primary` at the right end.
- **Windows and every other platform:** `primary` first, then `discard`, then the
  alternatives, then `cancel` last.

The group is aligned to the right on both platforms. The order in the document is the visual
order, so the Tab order follows what the user sees.

The footers of the export dialog use these roles:

- Setup: Export... is `primary`.
- The confirmation after a source change: Export Anyway is `primary`, Re-import is an
  alternative.
- Run: Run in Background is `primary`, and Stop Export is `discard`, because it throws away
  the encode (ADR 025).
- Finished: Done is `cancel`, because it only closes the dialog, and Show and Open are
  alternatives.
- Result: Close is `cancel`, and Back or Open Settings is `primary`.

### The default focus

- A dialog that asks to confirm a lossy action focuses Cancel. That covers the quit and
  replace prompts of ADR 027, Delete Preset, Restore Built-in Presets and the unsaved-draft
  prompts.
- The setup step focuses Export... When that button is disabled, the first control of the
  step takes the focus, and otherwise the dialog itself.
- The confirmation after a source change focuses Cancel. The finished step focuses Done. The
  run and result steps focus the dialog itself.

The close control of the export and settings dialogs comes after the footer in the
document, so it is the last Tab stop.

## Consequences

- On Windows the quit and replace prompts show Quit or Replace first. Cancel is still the
  default button (ADR 027).
- The Stop Export button of ADR 025 stands at the far left on macOS and after Run in
  Background on Windows. The reason that ADR 025 gives for the name Stop Export, a Cancel
  button in the same place, no longer describes where the button stands, but the name stays.
- A new dialog must use `DialogActions` and give each button a role.
