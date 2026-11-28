import { describe, expect, it, vi } from "vitest";
import { flush } from "@/features/project/projectTestSupport";
import { createRecoveryController } from "./controller";
import { startPageRecovery } from "./pageController";

describe("startPageRecovery", () => {
  it("starts one recovery session when the shell starts two times, as in StrictMode", async () => {
    const startRecovery = vi.fn(() => Promise.resolve({ token: "3" }));
    const listRecoveryOffers = vi.fn(() =>
      Promise.resolve({
        owner: true,
        status: "done" as const,
        complete: true,
        offers: [],
      }),
    );
    const controller = createRecoveryController({
      clients: { startRecovery, listRecoveryOffers },
    });

    startPageRecovery(controller);
    startPageRecovery(controller);
    await flush();

    expect(startRecovery).toHaveBeenCalledTimes(1);
    expect(listRecoveryOffers).toHaveBeenCalledTimes(1);
    expect(controller.token()).toBe("3");
    controller.close();
  });
});
