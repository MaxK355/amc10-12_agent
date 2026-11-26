import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBoxed, isEquivalent, numericValue } from "../server/grade.mjs";

test("extractBoxed handles nested braces and picks the last box", () => {
  assert.equal(extractBoxed("so $x=\\boxed{\\frac{1}{2}}$."), "\\frac{1}{2}");
  assert.equal(extractBoxed("\\boxed{1} then \\boxed{2}"), "2");
  assert.equal(extractBoxed("no answer"), null);
});

test("equivalent answer forms are accepted", () => {
  assert.ok(isEquivalent("1/2", "\\frac{1}{2}"));
  assert.ok(isEquivalent("0.5", "\\dfrac12"));
  assert.ok(isEquivalent("2sqrt(3)", "2\\sqrt{3}"));
  assert.ok(isEquivalent("16pi", "16\\pi"));
  assert.ok(isEquivalent("60", "60^\\circ"));
  assert.ok(isEquivalent("25", "25 \\, \\text{km}"));
  assert.ok(isEquivalent("0.25", "\\$0.25"));
  assert.ok(isEquivalent("1000", "1,\\!000"));
  assert.ok(isEquivalent("x=5", "5"));
});

test("wrong or blank answers are rejected", () => {
  assert.ok(!isEquivalent("3", "4"));
  assert.ok(!isEquivalent("", "4"));
  assert.ok(!isEquivalent("1/3", "0.33"));
});

test("non-numeric answers fall back to string comparison", () => {
  assert.equal(numericValue("(1,2)"), null);
  assert.ok(isEquivalent("(1, 2)", "(1,2)"));
  assert.ok(isEquivalent("\\text{(C)}", "(C)"));
});
