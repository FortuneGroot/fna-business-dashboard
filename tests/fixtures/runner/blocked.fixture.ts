import { before, test } from "node:test";

before(() => {
  throw new Error("BLOCKED: required local service is not available (fixture).");
});

test("needs the service", () => {});
