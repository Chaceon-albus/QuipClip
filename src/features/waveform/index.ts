/**
 * The audio envelope of a source on the timeline (ADR 056).
 *
 * The page controller is not here: `instance.ts` starts it and subscribes it to the media store,
 * so only the modules of the main window that use it import that file.
 */

export * from "./types";
export * from "./protocol";
export * from "./client";
export * from "./buffer";
export * from "./data";
export * from "./geometry";
export * from "./envelopeRender";
export * from "./store";
export * from "./controller";
export * from "./menuAction";
