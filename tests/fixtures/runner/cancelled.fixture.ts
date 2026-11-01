import { before, describe, test } from "node:test";

// node:test reports these as "cancelled" with fail = 0 and the process still exiting non-zero.
describe("setup hook throws", () => {
  before(() => {
    throw new Error("setup failed");
  });
  test("never runs", () => {});
});

test("times out", { timeout: 100 }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 2000));
});
