import { describe, expect, it } from "vitest";
import { centsFromInput, dollars } from "./api";

/**
 * This is the boundary where a human types money and the system turns it into
 * the integer cents everything downstream depends on — the ledger, job
 * costing, the tax engine. Get it wrong by a cent on a $28,400 commercial
 * quote and the estimate, the invoice and the WIP schedule all disagree.
 */
describe("centsFromInput", () => {
  it("reads plain amounts", () => {
    expect(centsFromInput("1850")).toBe(185000);
    expect(centsFromInput("1850.00")).toBe(185000);
    expect(centsFromInput("0")).toBe(0);
    expect(centsFromInput(".5")).toBe(50);
    expect(centsFromInput("0.07")).toBe(7);
  });

  it("forgives how people actually type money", () => {
    expect(centsFromInput("$1,850.00")).toBe(185000);
    expect(centsFromInput("  1850  ")).toBe(185000);
    expect(centsFromInput("$11,000")).toBe(1100000);
  });

  /**
   * The reason this is not `Math.round(parseFloat(x) * 100)`.
   * parseFloat("11.29") * 100 === 1128.9999999999998 — one rounding decision
   * away from being a cent light, silently, on some values and not others.
   */
  it("does not lose a cent to binary floating point", () => {
    for (const [input, expected] of [
      ["11.29", 1129],
      ["1.005", 101], // half-up on the third digit
      ["8.115", 812],
      ["0.145", 15],
      ["1234.565", 123457],
    ] as const) {
      expect(centsFromInput(input), input).toBe(expected);
    }
  });

  it("truncates beyond a half-cent rather than rounding up", () => {
    expect(centsFromInput("1.004")).toBe(100);
    expect(centsFromInput("9.994")).toBe(999);
  });

  it("returns null for anything that is not a number", () => {
    for (const bad of ["", " ", ".", "abc", "1.2.3", "-5", "1e5", "$", "12,,3.4.5"]) {
      expect(centsFromInput(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("round-trips against the formatter", () => {
    for (const cents of [0, 7, 50, 1129, 185000, 2840000]) {
      expect(centsFromInput(dollars(cents))).toBe(cents);
    }
  });
});
