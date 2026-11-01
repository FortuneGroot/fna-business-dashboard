import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

// Both groups end up "cancelled" with fail = 0; only the second hook's error is a real failure.
describe("blocked group", () => {
  before(() => {
    throw new Error("BLOCKED: required local service is not available (fixture).");
  });
  test("needs the service", () => {});
});

describe("broken group", () => {
  before(() => {
    assert.equal(1, 2, "real setup assertion");
  });
  test("depends on setup", () => {});
});
