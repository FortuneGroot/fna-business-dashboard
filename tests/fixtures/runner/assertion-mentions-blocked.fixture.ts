import assert from "node:assert/strict";
import { before, test } from "node:test";

before(() => {
  assert.equal(1, 2, "BLOCKED: an assertion message is not an environment blocker");
});

test("depends on setup", () => {});
