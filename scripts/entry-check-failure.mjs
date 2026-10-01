// A test preload. It makes `realpathSync` throw when the `isEntryPoint` function of one
// script calls it. This simulates a path that Node cannot resolve. The tests use it to
// show that a direct run of the script then fails, and does not exit with 0.
//
//   ENTRY_CHECK_FAILS=<file name> node --import <URL of this file> scripts/<file name>
//
// ENTRY_CHECK_FAILS names the script, for example `release-assets.mjs`. For all other
// callers, the wrapper calls the real function.

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const target = process.env.ENTRY_CHECK_FAILS;
const realpathSync = fs.realpathSync;

fs.realpathSync = Object.assign(
  /** @param {Parameters<typeof realpathSync>} args */
  (...args) => {
    if (!target) return realpathSync(...args);
    const inCheck = (new Error().stack ?? "")
      .split("\n")
      .some((line) => line.includes("isEntryPoint") && line.includes(`/${target}:`));
    if (inCheck) throw new Error(`simulated realpath failure in ${target}`);
    return realpathSync(...args);
  },
  { native: realpathSync.native },
);

// The scripts import `realpathSync` from `node:fs` as a named export. This call gives
// that export the function above.
syncBuiltinESMExports();
