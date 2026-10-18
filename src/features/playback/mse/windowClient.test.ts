import { describe, expect, it, vi } from "vitest";
import { BACKEND_COMMANDS, type InvokeFn } from "@/lib/ipc";
import {
  nextSequence,
  openPreviewWindow,
  parseWindowEnd,
  parseWindowOpened,
  PreviewWindowError,
  toPreviewWindowError,
  type WindowChannel,
  type WindowEnd,
  type WindowRequest,
} from "./windowClient";

const REQUEST: WindowRequest = {
  path: "/media/live.flv",
  size: 427000000,
  mtime: 1729000000,
  lane: "video",
  container: "flv",
  start: { kind: "time", seconds: 1294.5 },
  audio: "copy",
  audioCodec: "aac",
  pcm: true,
};

const OPENED = {
  windowId: 7,
  method: "bisection",
  nonMonotonic: false,
  firstKeyframePtsMs: 1294467,
  pcmStartSeconds: 1294.4,
  seekSeconds: null,
};

const END = {
  type: "end",
  status: "complete",
  reachedEnd: false,
  next: { offset: 9000000, ptsMs: 1354467 },
  bytesRead: 8800000,
  nonMonotonic: false,
  damaged: false,
  detail: null,
};

/** A fake of the invoke function and the two channels of a request. */
function harness(reply: () => Promise<unknown>) {
  const channels: WindowChannel[] = [];
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
  let resolveOpen: (value: unknown) => void = () => undefined;
  let rejectOpen: (reason: unknown) => void = () => undefined;
  const invoke = vi.fn((command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === BACKEND_COMMANDS.OPEN_PREVIEW_WINDOW) {
      return new Promise((resolve, reject) => {
        resolveOpen = resolve;
        rejectOpen = reject;
      }).then(() => reply());
    }
    return Promise.resolve(undefined);
  }) as unknown as InvokeFn;
  const createChannel = (): WindowChannel => {
    const channel: WindowChannel = { onmessage: () => undefined };
    channels.push(channel);
    return channel;
  };
  return {
    invoke,
    createChannel,
    calls,
    video: () => channels[0],
    audio: () => channels[1],
    open: () => resolveOpen(undefined),
    fail: (reason: unknown) => rejectOpen(reason),
  };
}

function listener() {
  return {
    chunks: [] as Uint8Array[],
    ends: [] as WindowEnd[],
    pcm: [] as Uint8Array[],
    pcmEnds: [] as WindowEnd[],
    onChunk(bytes: Uint8Array) {
      this.chunks.push(bytes);
    },
    onEnd(end: WindowEnd) {
      this.ends.push(end);
    },
    onPcmChunk(bytes: Uint8Array) {
      this.pcm.push(bytes);
    },
    onPcmEnd(end: WindowEnd) {
      this.pcmEnds.push(end);
    },
  };
}

describe("nextSequence", () => {
  it("counts microseconds of the clock and always rises", () => {
    const now = () => 1729000000123.4;
    const first = nextSequence("audio", now);
    expect(first).toBe(1729000000123400);
    expect(nextSequence("audio", now)).toBe(first + 1);
    expect(nextSequence("audio", () => 1729000000200)).toBe(1729000000200000);
  });
});

describe("parseWindowEnd", () => {
  it("reads an end message", () => {
    expect(parseWindowEnd(END)).toEqual({
      status: "complete",
      reachedEnd: false,
      next: { offset: 9000000, ptsMs: 1354467 },
      bytesRead: 8800000,
      nonMonotonic: false,
      damaged: false,
      detail: null,
    });
    expect(
      parseWindowEnd({ ...END, next: null, status: "failed", detail: "x" }),
    ).toMatchObject({
      next: null,
      status: "failed",
      detail: "x",
    });
  });

  it.each([
    null,
    "end",
    { ...END, type: "chunk" },
    { ...END, status: "done" },
    { ...END, reachedEnd: 1 },
    { ...END, bytesRead: -1 },
    { ...END, next: { offset: 1.5, ptsMs: 0 } },
    { ...END, next: { offset: 1, ptsMs: "0" } },
    { ...END, detail: 3 },
  ])("refuses %j", (message) => {
    expect(parseWindowEnd(message)).toBeNull();
  });
});

describe("parseWindowOpened", () => {
  it("reads the reply of the command", () => {
    expect(parseWindowOpened(OPENED)).toEqual(OPENED);
    expect(
      parseWindowOpened({
        windowId: 1,
        method: null,
        nonMonotonic: true,
        seekSeconds: 20.5,
      }),
    ).toEqual({
      windowId: 1,
      method: null,
      nonMonotonic: true,
      firstKeyframePtsMs: null,
      pcmStartSeconds: null,
      seekSeconds: 20.5,
    });
  });

  it.each([
    { ...OPENED, windowId: -1 },
    { ...OPENED, method: 3 },
    { ...OPENED, nonMonotonic: "no" },
    { ...OPENED, pcmStartSeconds: Number.NaN },
  ])("refuses %j", (reply) => {
    expect(parseWindowOpened(reply)).toBeNull();
  });
});

describe("toPreviewWindowError", () => {
  it("keeps a stable code and its detail", () => {
    const error = toPreviewWindowError({ code: "readFailed", detail: "timed out" });
    expect(error).toBeInstanceOf(PreviewWindowError);
    expect(error.code).toBe("readFailed");
    expect(error.detail).toBe("timed out");
  });

  it("names every other failure commandExecutionFailed", () => {
    expect(toPreviewWindowError({ code: "unknown" }).code).toBe(
      "commandExecutionFailed",
    );
    expect(toPreviewWindowError(new Error("boom")).detail).toBe("boom");
  });
});

describe("openPreviewWindow", () => {
  it("sends the request with a rising sequence and both channels", async () => {
    const fake = harness(() => Promise.resolve(OPENED));
    const session = openPreviewWindow(REQUEST, listener(), {
      invoke: fake.invoke,
      createChannel: fake.createChannel,
      now: () => 1729000001000,
    });
    fake.open();
    await expect(session.opened).resolves.toEqual(OPENED);
    expect(fake.calls[0]?.command).toBe(BACKEND_COMMANDS.OPEN_PREVIEW_WINDOW);
    expect(fake.calls[0]?.args).toEqual({
      request: { ...REQUEST, sequence: 1729000001000000 },
      channel: fake.video(),
      audioChannel: fake.audio(),
    });
  });

  it("passes the pieces and the end in order, and drops what comes after the end", async () => {
    const fake = harness(() => Promise.resolve(OPENED));
    const output = listener();
    const session = openPreviewWindow(REQUEST, output, {
      invoke: fake.invoke,
      createChannel: fake.createChannel,
    });
    // Pieces can arrive before the command returns.
    fake.video().onmessage(new Uint8Array([1, 2, 3]).buffer);
    fake.open();
    await session.opened;
    fake.video().onmessage(new Uint8Array([4, 5]));
    fake.video().onmessage(END);
    fake.video().onmessage(new Uint8Array([6]).buffer);

    expect(output.chunks.map((chunk) => Array.from(chunk))).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    expect(output.ends).toHaveLength(1);
    expect(output.ends[0]?.next).toEqual({ offset: 9000000, ptsMs: 1354467 });
  });

  it("ends a window whose end message has the wrong shape as failed", () => {
    const fake = harness(() => Promise.resolve(OPENED));
    const output = listener();
    openPreviewWindow(REQUEST, output, {
      invoke: fake.invoke,
      createChannel: fake.createChannel,
    }).opened.catch(() => undefined);
    fake.video().onmessage({ type: "end", status: "?" });
    expect(output.ends).toEqual([
      {
        status: "failed",
        reachedEnd: false,
        next: null,
        bytesRead: 0,
        nonMonotonic: false,
        damaged: false,
        detail: "invalidResponse",
      },
    ]);
  });

  it("passes the PCM of the second channel to its own handlers", () => {
    const fake = harness(() => Promise.resolve(OPENED));
    const output = listener();
    openPreviewWindow(REQUEST, output, {
      invoke: fake.invoke,
      createChannel: fake.createChannel,
    }).opened.catch(() => undefined);
    fake.audio().onmessage(new Uint8Array([9, 9]).buffer);
    fake.audio().onmessage({ ...END, next: null });
    fake.audio().onmessage(new Uint8Array([8]).buffer);
    expect(output.pcm.map((chunk) => Array.from(chunk))).toEqual([[9, 9]]);
    expect(output.pcmEnds).toHaveLength(1);
    expect(output.chunks).toHaveLength(0);
  });

  it("holds the acknowledged bytes until it knows the window, then sends them as one", async () => {
    const fake = harness(() => Promise.resolve(OPENED));
    const session = openPreviewWindow(REQUEST, listener(), {
      invoke: fake.invoke,
      createChannel: fake.createChannel,
    });
    session.ack(1000);
    session.ack(24);
    session.ack(0);
    fake.open();
    await session.opened;
    session.ack(500);
    const acks = fake.calls.filter(
      (call) => call.command === BACKEND_COMMANDS.ACK_PREVIEW_WINDOW,
    );
    expect(acks.map((call) => call.args)).toEqual([
      { windowId: 7, bytes: 1024 },
      { windowId: 7, bytes: 500 },
    ]);
  });

  it("closes a window that the page closed before the command returned", async () => {
    const fake = harness(() => Promise.resolve(OPENED));
    const output = listener();
    const session = openPreviewWindow(REQUEST, output, {
      invoke: fake.invoke,
      createChannel: fake.createChannel,
    });
    session.close();
    session.ack(10);
    fake.video().onmessage(new Uint8Array([1]).buffer);
    fake.open();
    await session.opened;
    expect(session.isClosed()).toBe(true);
    expect(output.chunks).toHaveLength(0);
    const commands = fake.calls.map((call) => call.command);
    expect(commands).toEqual([
      BACKEND_COMMANDS.OPEN_PREVIEW_WINDOW,
      BACKEND_COMMANDS.CLOSE_PREVIEW_WINDOW,
    ]);
    expect(fake.calls[1]?.args).toEqual({ windowId: 7 });
  });

  it("sends one close for a known window", async () => {
    const fake = harness(() => Promise.resolve(OPENED));
    const session = openPreviewWindow(REQUEST, listener(), {
      invoke: fake.invoke,
      createChannel: fake.createChannel,
    });
    fake.open();
    await session.opened;
    session.close();
    session.close();
    expect(
      fake.calls.filter(
        (call) => call.command === BACKEND_COMMANDS.CLOSE_PREVIEW_WINDOW,
      ),
    ).toHaveLength(1);
  });

  it("rejects with the stable code of the command", async () => {
    const fake = harness(() =>
      Promise.reject(Object.assign(new Error("superseded"), { code: "superseded" })),
    );
    const session = openPreviewWindow(REQUEST, listener(), {
      invoke: fake.invoke,
      createChannel: fake.createChannel,
    });
    fake.open();
    await expect(session.opened).rejects.toMatchObject({ code: "superseded" });
  });

  it("rejects a reply of the wrong shape", async () => {
    const fake = harness(() => Promise.resolve({ windowId: "7" }));
    const session = openPreviewWindow(REQUEST, listener(), {
      invoke: fake.invoke,
      createChannel: fake.createChannel,
    });
    fake.open();
    await expect(session.opened).rejects.toMatchObject({ code: "invalidResponse" });
  });

  it("reports an acknowledgement that fails, and keeps the window", async () => {
    const reported: unknown[] = [];
    const invoke = vi.fn((command: string) =>
      command === BACKEND_COMMANDS.OPEN_PREVIEW_WINDOW
        ? Promise.resolve(OPENED)
        : Promise.reject(new Error("ipc down")),
    ) as unknown as InvokeFn;
    const session = openPreviewWindow(REQUEST, listener(), {
      invoke,
      createChannel: () => ({ onmessage: () => undefined }),
      onBackgroundError: (error) => reported.push(error),
    });
    await session.opened;
    session.ack(10);
    await Promise.resolve();
    await Promise.resolve();
    expect(reported).toHaveLength(1);
    expect(session.isClosed()).toBe(false);
  });
});
