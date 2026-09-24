import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BACKEND_COMMANDS, BACKEND_EVENTS } from "./ipc";

/**
 * Reads the leaf names registered with `tauri::generate_handler!` out of the Rust source.
 *
 * Every value of `BACKEND_COMMANDS` and its Rust registration are two independent hand-written
 * copies of the same string, and until this test existed nothing compared them. Most commands
 * fail loudly when they drift, because the caller surfaces the rejection, but
 * `read_source_revision` does not: `sourceRevisionStillMatches` treats every read failure as
 * "no mismatch observed", which is correct for a deleted file or a share that stopped
 * answering, and makes an unknown command indistinguishable from an unchanged file. A rename on
 * the Rust side alone would switch the whole replacement warning off with no failing test and
 * no user-visible symptom (ADR 010).
 */
const GENERATE_HANDLER_PATTERN =
  /\.invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/;

function readRustRegisteredCommands(): string[] {
  const source = readFileSync(
    fileURLToPath(new URL("../../src-tauri/src/lib.rs", import.meta.url)),
    "utf8",
  );

  const invocation = GENERATE_HANDLER_PATTERN.exec(source);
  expect(invocation).not.toBeNull();

  // Each entry is a module path such as `commands::media::read_source_revision`; the command
  // name is its last segment.
  const paths = invocation![1].matchAll(
    /^\s*(?:[a-z_][a-z0-9_]*::)+([a-z_][a-z0-9_]*)\s*,?\s*$/gm,
  );
  return Array.from(paths, (match) => match[1]);
}

describe("Backend command parity", () => {
  it("registers every BACKEND_COMMANDS name in the Rust invoke handler", () => {
    const registered = readRustRegisteredCommands();

    // Guards the parse itself: a moved lib.rs or a reformatted handler list would otherwise
    // read as an empty registration and pass the comparison below.
    expect(registered.length).toBeGreaterThan(8);
    expect(new Set(registered).size).toBe(registered.length);

    const missing = Object.values(BACKEND_COMMANDS).filter(
      (command) => !registered.includes(command),
    );
    expect(missing).toEqual([]);
  });
});

describe("Backend event parity", () => {
  it("names the quit request event exactly as the Rust constant does", () => {
    // A rename on one side only leaves every quit held back by Rust with no dialog to answer
    // it (ADR 027), so the two copies of the name are compared here.
    const source = readFileSync(
      fileURLToPath(new URL("../../src-tauri/src/commands/quit.rs", import.meta.url)),
      "utf8",
    );
    const match = /pub const QUIT_REQUESTED_EVENT: &str = "([^"]+)";/.exec(source);

    expect(match).not.toBeNull();
    expect(match![1]).toBe(BACKEND_EVENTS.QUIT_REQUESTED);
  });

  it("names the menu action event exactly as the Rust constant does", () => {
    // A rename on one side only leaves every command item of the macOS menu with no listener,
    // so Open Media, Export and Settings in the menu would do nothing.
    const source = readFileSync(
      fileURLToPath(new URL("../../src-tauri/src/menu.rs", import.meta.url)),
      "utf8",
    );
    const match = /pub const MENU_ACTION_EVENT: &str = "([^"]+)";/.exec(source);

    expect(match).not.toBeNull();
    expect(match![1]).toBe(BACKEND_EVENTS.MENU_ACTION);
  });
});
