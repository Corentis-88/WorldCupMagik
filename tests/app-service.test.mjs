import test from "node:test";
import assert from "node:assert/strict";
import { buildRiskPolicy, selectBetslip, selectFixturesForWindow } from "../src/app-service.mjs";
import policy from "../config/engine-policy.json" with { type: "json" };
import fixtures from "../data/fixtures.json" with { type: "json" };

test("risk slider makes low risk stricter than high risk", () => {
  const low = buildRiskPolicy(policy, 8).riskProfile;
  const high = buildRiskPolicy(policy, 88).riskProfile;

  assert.ok(low.minLegEdge > high.minLegEdge);
  assert.ok(low.minLegConfidence > high.minLegConfidence);
  assert.ok(low.minIntelligenceConfidence > high.minIntelligenceConfidence);
  assert.ok(low.contrarianWeight < high.contrarianWeight);
  assert.ok(low.maxCombinedOdds < high.maxCombinedOdds);
});

test("days ahead selects fixtures in the intended local window", () => {
  const selected = selectFixturesForWindow(fixtures, 1, new Date("2026-06-06T10:00:00.000Z"));

  assert.equal(selected.length, 2);
  assert.equal(selected[0].id, "demo-eng-bra");
});

test("betslip selection respects requested count and calculates returns", () => {
  const recommendations = {
    doubles: [
      combo("double", 4.2, 90),
      combo("double", 3.4, 82)
    ],
    trixies: [
      combo("trixie", 8.4, 88)
    ],
    accumulators: [
      combo("accumulator", 14.2, 84)
    ]
  };
  const betslip = selectBetslip({ recommendations, stake: 20, betCount: 2, risk: 55 });

  assert.equal(betslip.length, 2);
  assert.equal(betslip[0].stake, 10);
  assert.ok(betslip[0].potentialReturn > 10);
});

function combo(type, odds, score) {
  return {
    id: `${type}_${odds}`,
    type,
    score,
    legCount: type === "double" ? 2 : 3,
    combinedDecimalOdds: odds,
    combinedProbability: 0.31,
    expectedValue: 0.18,
    averageConfidence: 0.72,
    riskLegCount: type === "double" ? 0 : 1,
    legs: [
      { id: `${type}_${odds}_1`, selectionLabel: "Team A to win", decimalOdds: 1.8 },
      { id: `${type}_${odds}_2`, selectionLabel: "Team B over 2.5", decimalOdds: 2.1 }
    ],
    thesis: "Demo combo"
  };
}
