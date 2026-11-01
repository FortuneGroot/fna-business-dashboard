import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

describe("blocked group", () => {
  before(() => {
    throw new Error("BLOCKED: required local service is not available (fixture).");
  });
  test("needs the service", () => {});
});

test("a real assertion failure", () => {
  assert.equal(1, 2);
});
