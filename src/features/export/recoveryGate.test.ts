import { describe, expect, it } from "vitest";
import { createExportRecoveryGate } from "./recoveryGate";

describe("export recovery gate", () => {
  it("is open when no recovery runs", () => {
    expect(createExportRecoveryGate().pending()).toBeNull();
  });

  it("holds until every close is opened again", async () => {
    const gate = createExportRecoveryGate();
    const openFirst = gate.close();
    const openSecond = gate.close();
    const pending = gate.pending();
    expect(pending).not.toBeNull();
    let passed = false;
    void pending?.then(() => {
      passed = true;
    });

    openFirst();
    openFirst();
    await Promise.resolve();
    expect(passed).toBe(false);
    expect(gate.pending()).toBe(pending);

    openSecond();
    await pending;
    expect(passed).toBe(true);
    expect(gate.pending()).toBeNull();
  });
});
