# 011. Localize the interface with i18next

- Status: Accepted
- Date: 2026-08-29
- Deciders: capric98

## Context

QuipClip must initially support English and Simplified Chinese. On initial launch, the
application must select a language from the user's system preferences. The user must also
be able to select a language in the application settings.

Interface text will exist in React components, dialogs, notifications, and error
messages. Hard-coded strings would make coverage difficult to check. They would also let
the English and Simplified Chinese interfaces drift apart as features are added.

The language preference belongs to the application, not to an editing project. Storing it
in a `.qcproj` file would make the interface language change when the user opens a project.

## Decision

Use `i18next` for message lookup and formatting. Use `react-i18next` to connect the message
catalogs to React.

The first catalogs are `en` and `zh-CN`. English is the source language and the fallback
language. Both catalogs are bundled with the application. Catalogs use stable semantic
keys. The key hierarchy states the component and intent, such as `timeline.action.cut`.
Components must not use complete English sentences as keys.

The application setting has three values: `system`, `en`, and `zh-CN`. Its default is
`system`. The application persists this setting outside the project file, in the web view
under the `localStorage` key `quipclip.language_preference`. The settings
UI uses `Language` and `语言` as its labels. It uses `System Default` and `系统默认` for
the `system` option. Both catalogs show the language names as the autonyms `English` and
`简体中文`.

When the setting is `system`, examine `navigator.languages` in order. Select `zh-CN` when
the first supported primary language subtag is `zh`. Select `en` when the first supported
primary language subtag is `en`. Use `en` if no entry matches a supported language. This
rule means that a Traditional Chinese system locale uses the Simplified Chinese catalog
until QuipClip adds a Traditional Chinese catalog.

A language change in the settings takes effect without an application restart. Number,
date, and list formatting use `Intl` with the resolved locale. Media timecode, file paths,
technical identifiers, and raw `ffmpeg` output keep their original format.

Rust and Tauri commands return stable error codes and named values for errors that the
application generates. They do not return user-facing sentences. The frontend translates
these errors. It may append unchanged diagnostic text beside the translated message.

**The diagnostic may come from Rust as well as from the operating system or `ffmpeg`.** The
rule that matters is which string the interface renders as its message, not which process
produced the other one. The localized code is always the message. A diagnostic is supplementary
text a user copies into a bug report, and it is never translated, so its origin does not change
what the user is told.

Whether to carry one is decided by the condition, not by the origin:

- A condition the application can enumerate has a code of its own, and that code is the whole
  account. A refusal QuipClip decides for itself — a read-only destination, a revision that does
  not match — needs no sentence beside it, because no system call was made and there is nothing
  a diagnostic could add that the code does not already say.
- A condition whose failure modes cannot be enumerated carries its diagnostic. Creating a
  temporary file, walking a directory, or spawning a process can fail in ways that are not worth
  a code each and are not predictable in advance. Dropping the text there leaves the user and a
  bug report with a bare code and no way to tell two different faults apart.

The earlier reading of this record dropped every diagnostic that did not carry a raw
operating-system code, on the ground that a Rust-authored string is untranslated English. That
protected nothing the first rule above does not already protect, and it discarded the only detail
some corner cases produce.

Each translation change must maintain message-key parity across catalogs. Plural forms
follow the CLDR rules that `i18next` applies to each language. The parity check normalizes
recognized cardinal and ordinal plural suffixes before it compares semantic base keys. For
each count-based key, it requires every category that `Intl.PluralRules` returns for the
locale and plural type. An exact-count `_zero` form is an optional override.

Translators must receive the complete source message, named placeholders such as
`{{count}}` and `{{fileName}}`, placeholder definitions, and interface context. Do not use
positional placeholders such as `%s` or `{0}`. Components must not assemble sentences
from translated fragments.

Before a catalog commit, check whether the `agy` command exists. If it exists, Gemini must
check and polish new or changed English and Simplified Chinese interface text. For each
changed key, give Gemini the English message, the Simplified Chinese message, placeholder
definitions, and interface context. Use the project's controlled-language skills when the
text is technical. The main agent must check Gemini's proposed changes before accepting
them.

Gemini language review is additional to the independent review that ADR 008 requires. It
never replaces that review. If Gemini makes no accepted edit, add
`Reviewed-By: agy/<model-id>`. If the catalog accepts a Gemini edit, add
`Assisted-By: agy/<model-id>` instead. If `agy` does not exist or its review
fails, the independent review still applies without a Gemini trailer.

## Consequences

- `i18next` and `react-i18next` become runtime dependencies before feature work starts.
- A future localization feature must add initialization, bundled catalogs, type-safe keys,
  the persisted application setting, and the language control.
- Tests must check catalog key parity, fallback behavior, and system-language resolution.
  They must also check immediate language changes and a persisted user override across a
  restart. A test must return the setting to `system` and check system-language resolution.
- The initial release provides one Simplified Chinese catalog. Traditional Chinese needs
  a separate catalog in a later decision.
- The language setting does not change the `.qcproj` schema.
