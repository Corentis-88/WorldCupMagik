import test from "node:test";
import assert from "node:assert/strict";
import { buildBetRecommendations } from "../src/portfolio-builder.mjs";
import { buildLegCandidates } from "../src/scoring.mjs";
import policy from "../config/engine-policy.json" with { type: "json" };
import fixtures from "../data/fixtures.json" with { type: "json" };
import teamStats from "../data/team-stats.json" with { type: "json" };
import { buildMockNews, buildMockOdds } from "../src/providers/mock-data.mjs";

test("scores positive-edge legs with calculated risk tags", () => {
  const now = new Date("2026-06-05T09:00:00.000Z");
  const odds = buildMockOdds(fixtures, now);
  const news = buildMockNews(fixtures, now);
  const legs = buildLegCandidates({ fixtures, oddsSnapshots: odds, newsArticles: news, teamStats, policy, now });
  const eligible = legs.filter((leg) => !leg.hardBlocks.length);

  assert.ok(legs.length > 0);
  assert.ok(eligible.length > 0);
  assert.ok(eligible.some((leg) => ["calculated_risk", "longshot_value"].includes(leg.riskTag)));
});

test("builds doubles, trixies, and accumulators without same-fixture legs", () => {
  const now = new Date("2026-06-05T09:00:00.000Z");
  const odds = buildMockOdds(fixtures, now);
  const news = buildMockNews(fixtures, now);
  const legs = buildLegCandidates({ fixtures, oddsSnapshots: odds, newsArticles: news, teamStats, policy, now });
  const recommendations = buildBetRecommendations(legs, policy);

  assert.ok(recommendations.doubles.length > 0);
  assert.ok(recommendations.trixies.length > 0);
  assert.ok(recommendations.accumulators.length > 0);

  for (const combo of [...recommendations.doubles, ...recommendations.trixies, ...recommendations.accumulators]) {
    const fixtureIds = new Set(combo.legs.map((leg) => leg.fixtureId));
    assert.equal(fixtureIds.size, combo.legs.length);
    assert.equal(combo.hardBlocks.length, 0);
  }
});
