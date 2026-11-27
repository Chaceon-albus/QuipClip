import { describe, expect, it, vi } from "vitest";
import { VIDEO_FILE_EXTENSIONS } from "@/features/media/dialog";
import { ImportMediaError } from "@/features/media/types";
import { createOpenAction, OPEN_FILE_EXTENSIONS } from "./openAction";

describe("the Open action (ADR 072, One Open action)", () => {
  it("lists the videos and the project files in one filter", async () => {
    const openDialog = vi.fn().mockResolvedValue(null);
    await createOpenAction({
      openDialog,
      filterName: () => "Videos and QuipClip Projects",
      requestOpen: vi.fn(),
    })();

    expect(OPEN_FILE_EXTENSIONS).toEqual([...VIDEO_FILE_EXTENSIONS, "qcproj"]);
    expect(openDialog).toHaveBeenCalledWith({
      multiple: true,
      directory: false,
      filters: [
        { name: "Videos and QuipClip Projects", extensions: OPEN_FILE_EXTENSIONS },
      ],
    });
  });

  it("gives all the files of one dialog to one request", async () => {
    const requestOpen = vi.fn().mockResolvedValue([]);
    await createOpenAction({
      openDialog: vi.fn().mockResolvedValue(["/v/a.mp4", "/p/cut.qcproj", "/v/b.mp4"]),
      filterName: () => "Open",
      requestOpen,
    })();

    expect(requestOpen.mock.calls).toEqual([
      [["/v/a.mp4", "/p/cut.qcproj", "/v/b.mp4"]],
    ]);
  });

  it("makes no request after a cancel", async () => {
    const requestOpen = vi.fn();
    await createOpenAction({
      openDialog: vi.fn().mockResolvedValue(null),
      filterName: () => "Open",
      requestOpen,
    })();

    expect(requestOpen).not.toHaveBeenCalled();
  });

  it("shows no file dialog while the quit guard would refuse the request", async () => {
    const openDialog = vi.fn().mockResolvedValue(["/v/a.mp4"]);
    const requestOpen = vi.fn();
    const canOpen = vi.fn(() => false);

    await createOpenAction({
      openDialog,
      filterName: () => "Open",
      requestOpen,
      canOpen,
    })();

    expect(canOpen).toHaveBeenCalledTimes(1);
    expect(openDialog).not.toHaveBeenCalled();
    expect(requestOpen).not.toHaveBeenCalled();
  });

  it("asks the quit guard before the file dialog, not after it", async () => {
    const order: string[] = [];
    await createOpenAction({
      openDialog: vi.fn(() => {
        order.push("dialog");
        return Promise.resolve(["/v/a.mp4"]);
      }) as never,
      filterName: () => "Open",
      requestOpen: vi.fn(() => {
        order.push("request");
        return Promise.resolve([]);
      }),
      canOpen: () => {
        order.push("canOpen");
        return true;
      },
    })();

    expect(order).toEqual(["canOpen", "dialog", "request"]);
  });

  it("reports dialogFailed when the dialog fails", async () => {
    const reportError = vi.fn();
    const requestOpen = vi.fn();
    await createOpenAction({
      openDialog: vi.fn().mockRejectedValue(new Error("no dialog")),
      filterName: () => "Open",
      requestOpen,
      reportError,
    })();

    expect(requestOpen).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[0]).toBeInstanceOf(ImportMediaError);
    expect(reportError.mock.calls[0]?.[0]).toMatchObject({ code: "dialogFailed" });
  });

  it("reads the label of the filter at each run", async () => {
    const labels = ["Videos and QuipClip Projects", "视频和 QuipClip 项目"];
    const filterName = vi.fn(() => labels.shift() ?? "");
    const openDialog = vi.fn().mockResolvedValue(null);
    const run = createOpenAction({ openDialog, filterName, requestOpen: vi.fn() });

    await run();
    await run();

    const names = openDialog.mock.calls.map(
      (call) => (call[0] as { filters: { name: string }[] }).filters[0]?.name,
    );
    expect(names).toEqual(["Videos and QuipClip Projects", "视频和 QuipClip 项目"]);
  });
});
