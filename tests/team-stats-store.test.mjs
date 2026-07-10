import test from "node:test";
import assert from "node:assert/strict";
import { mergeTeamStatsRecords } from "../src/team-stats-store.mjs";

test("team stat persistence retains unscanned teams and resists a weak transient refresh", () => {
  const existing = [
    team("Brazil", 20, 0.72, "2026-07-01T00:00:00.000Z"),
    team("Japan", 20, 0.7, "2026-07-01T00:00:00.000Z")
  ];
  const fresh = [team("Brazil", 0, 0.22, "2026-07-10T00:00:00.000Z")];
  const merged = mergeTeamStatsRecords(existing, fresh, { now: new Date("2026-07-10T01:00:00.000Z") });

  assert.equal(merged.length, 2);
  assert.equal(merged.find((record) => record.team === "Brazil").sourceMatchCount, 20);
  assert.equal(merged.find((record) => record.team === "Japan").sourceMatchCount, 20);
});

function team(name, matches, completeness, updatedAt) {
  return {
    team: name,
    sourceMatchCount: matches,
    statsCompleteness: completeness,
    eventMetricQuality: matches ? 0.34 : 0.22,
    realMetricMatchCount: 0,
    updatedAt
  };
}
