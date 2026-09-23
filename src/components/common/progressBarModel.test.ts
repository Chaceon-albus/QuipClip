import { describe, expect, it } from "vitest";
import { resolveProgressBarModel } from "./progressBarModel";

describe("resolveProgressBarModel", () => {
  describe("indeterminate mode", () => {
    it("resolves null to indeterminate mode with no numeric values", () => {
      expect(resolveProgressBarModel(null)).toStrictEqual({
        mode: "indeterminate",
        fillPercent: null,
        ariaValueNow: undefined,
      });
    });

    it("resolves undefined to indeterminate mode with no numeric values", () => {
      expect(resolveProgressBarModel(undefined)).toStrictEqual({
        mode: "indeterminate",
        fillPercent: null,
        ariaValueNow: undefined,
      });
    });

    it("resolves NaN to indeterminate mode", () => {
      expect(resolveProgressBarModel(Number.NaN)).toStrictEqual({
        mode: "indeterminate",
        fillPercent: null,
        ariaValueNow: undefined,
      });
    });

    it("resolves Infinity to indeterminate mode", () => {
      expect(resolveProgressBarModel(Number.POSITIVE_INFINITY)).toStrictEqual({
        mode: "indeterminate",
        fillPercent: null,
        ariaValueNow: undefined,
      });
    });

    it("resolves -Infinity to indeterminate mode", () => {
      expect(resolveProgressBarModel(Number.NEGATIVE_INFINITY)).toStrictEqual({
        mode: "indeterminate",
        fillPercent: null,
        ariaValueNow: undefined,
      });
    });
  });

  describe("determinate mode clamping", () => {
    it("clamps negative values to 0 percent", () => {
      expect(resolveProgressBarModel(-10)).toStrictEqual({
        mode: "determinate",
        fillPercent: 0,
        ariaValueNow: 0,
      });
      expect(resolveProgressBarModel(-0.5)).toStrictEqual({
        mode: "determinate",
        fillPercent: 0,
        ariaValueNow: 0,
      });
    });

    it("clamps values above 100 to 100 percent", () => {
      expect(resolveProgressBarModel(105)).toStrictEqual({
        mode: "determinate",
        fillPercent: 100,
        ariaValueNow: 100,
      });
      expect(resolveProgressBarModel(999.9)).toStrictEqual({
        mode: "determinate",
        fillPercent: 100,
        ariaValueNow: 100,
      });
    });

    it("resolves boundary values at 0 and 100 exactly", () => {
      expect(resolveProgressBarModel(0)).toStrictEqual({
        mode: "determinate",
        fillPercent: 0,
        ariaValueNow: 0,
      });
      expect(resolveProgressBarModel(100)).toStrictEqual({
        mode: "determinate",
        fillPercent: 100,
        ariaValueNow: 100,
      });
    });
  });

  describe("fractional values and aria-valuenow rounding", () => {
    it("preserves fractions in fillPercent while rounding ariaValueNow", () => {
      expect(resolveProgressBarModel(42.7)).toStrictEqual({
        mode: "determinate",
        fillPercent: 42.7,
        ariaValueNow: 43,
      });
    });

    it("rounds ariaValueNow down when the fractional part is less than 0.5", () => {
      expect(resolveProgressBarModel(42.4)).toStrictEqual({
        mode: "determinate",
        fillPercent: 42.4,
        ariaValueNow: 42,
      });
      expect(resolveProgressBarModel(0.4)).toStrictEqual({
        mode: "determinate",
        fillPercent: 0.4,
        ariaValueNow: 0,
      });
    });

    it("rounds ariaValueNow up when the fractional part is 0.5 or greater", () => {
      expect(resolveProgressBarModel(42.5)).toStrictEqual({
        mode: "determinate",
        fillPercent: 42.5,
        ariaValueNow: 43,
      });
      expect(resolveProgressBarModel(0.5)).toStrictEqual({
        mode: "determinate",
        fillPercent: 0.5,
        ariaValueNow: 1,
      });
      expect(resolveProgressBarModel(99.5)).toStrictEqual({
        mode: "determinate",
        fillPercent: 99.5,
        ariaValueNow: 100,
      });
    });
  });
});
