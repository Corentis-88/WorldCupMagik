import test from "node:test";
import assert from "node:assert/strict";
import { shouldTakeSnapshot } from "../src/day-runner.mjs";
import policy from "../config/engine-policy.json" with { type: "json" };

test("daily snapshots start on the configured start date", () => {
  assert.equal(shouldTakeSnapshot(policy, new Date("2026-06-03T12:00:00.000Z")), false);
  assert.equal(shouldTakeSnapshot(policy, new Date("2026-06-04T09:00:00.000Z")), true);
});
