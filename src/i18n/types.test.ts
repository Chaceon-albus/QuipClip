import { describe, expect, expectTypeOf, it } from "vitest";
import type { DeepStringSchema } from "./types";

/**
 * Compile-time tests for `DeepStringSchema`, the type every target catalog must satisfy.
 *
 * `pnpm typecheck` checks this file. Each `@ts-expect-error` below marks a catalog that must
 * not compile: if the schema accepts that catalog, the directive is unused, and an unused
 * directive is itself a type error. The runtime assertions only keep vitest from reporting a
 * suite with no tests. Each catalog stays on one line, so that the error and its directive
 * cannot move apart when Prettier formats the file.
 */

/** A source catalog with an ordinary message and a plural family with two forms. */
type PluralCatalog = DeepStringSchema<{
  readonly label: "Label";
  readonly x_one: "{{count}} item";
  readonly x_other: "{{count}} items";
}>;

/** A source catalog with a nested group whose key name ends in a plural suffix. */
type NestedCatalog = DeepStringSchema<{
  readonly group_one: { readonly title: "Title" };
}>;

describe("DeepStringSchema", () => {
  it("accepts a catalog with every key of the source", () => {
    const complete: PluralCatalog = { label: "L", x_one: "1", x_other: "n" };
    expect(complete).toBeTypeOf("object");
  });

  it("accepts a catalog without a plural category that its language does not use", () => {
    // Chinese uses only the `other` category, so it has no `_one` form.
    const withoutOne: PluralCatalog = { label: "L", x_other: "n" };
    expect(withoutOne).toBeTypeOf("object");
    expectTypeOf<PluralCatalog["x_one"]>().toEqualTypeOf<string | undefined>();
  });

  it("refuses a catalog without the `_other` form", () => {
    // @ts-expect-error -- every language uses the `other` category, so it stays required.
    const withoutOther: PluralCatalog = { label: "L", x_one: "1" };
    expect(withoutOther).toBeTypeOf("object");
    expectTypeOf<PluralCatalog["x_other"]>().toEqualTypeOf<string>();
  });

  it("refuses a plural category that the source catalog does not have", () => {
    // @ts-expect-error -- `x_few` is not a key of the source catalog.
    const extraFew: PluralCatalog = { label: "L", x_other: "n", x_few: "f" };
    expect(extraFew).toBeTypeOf("object");
  });

  it("refuses a catalog without an ordinary message", () => {
    // @ts-expect-error -- `label` has no plural suffix, so it stays required.
    const withoutLabel: PluralCatalog = { x_one: "1", x_other: "n" };
    expect(withoutLabel).toBeTypeOf("object");
  });

  it("keeps a nested group with a plural suffix required, with its object type", () => {
    const complete: NestedCatalog = { group_one: { title: "T" } };
    expect(complete).toBeTypeOf("object");
    expectTypeOf<NestedCatalog>().toHaveProperty("group_one");
    expectTypeOf<NestedCatalog["group_one"]>().not.toBeUndefined();
    expectTypeOf<NestedCatalog["group_one"]>().toHaveProperty("title");

    // @ts-expect-error -- only a message can be a plural form. A group stays required.
    const withoutGroup: NestedCatalog = {};
    expect(withoutGroup).toBeTypeOf("object");

    // @ts-expect-error -- the group keeps its object type, so a string is refused.
    const groupAsString: NestedCatalog = { group_one: "T" };
    expect(groupAsString).toBeTypeOf("object");

    // @ts-expect-error -- the keys inside the group stay required.
    const groupWithoutTitle: NestedCatalog = { group_one: {} };
    expect(groupWithoutTitle).toBeTypeOf("object");
  });
});
