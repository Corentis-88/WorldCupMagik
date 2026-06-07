import test from "node:test";
import assert from "node:assert/strict";
import { buildRiskPolicy, selectBetslip, selectFixturesForWindow } from "../src/app-service.mjs";
import policy from "../config/engine-policy.json" with { type: "json" };

const fixtures = [
  { id: "mex-rsa", date: "2026-06-06T20:00:00.000Z", homeTeam: "Mexico", awayTeam: "South Africa", sourceType: "public-web" },
  { id: "bra-hai", date: "2026-06-07T17:00:00.000Z", homeTeam: "Brazil", awayTeam: "Haiti", sourceType: "public-web" },
  { id: "eng-cro", date: "2026-06-08T19:00:00.000Z", homeTeam: "England", awayTeam: "Croatia", sourceType: "public-web" }
];

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
  assert.equal(selected[0].id, "mex-rsa");
});

test("betslip selection returns the fixed category set it can support", () => {
  const recommendations = {
    singles: [
      combo("single", 1.9, 91, 1)
    ],
    doubles: [
      combo("double", 4.2, 90, 2),
      combo("double", 3.4, 82, 2)
    ],
    trixies: [
      combo("trixie", 8.4, 88, 3)
    ],
    accumulatorsByLegCount: {
      3: [combo("accumulator", 9.2, 86, 3)],
      4: [combo("accumulator", 18.5, 84, 4)]
    },
    accumulators: []
  };
  const betslip = selectBetslip({ recommendations, stake: 40, risk: 55 });

  assert.equal(betslip.length, 5);
  assert.deepEqual(betslip.map((bet) => bet.label), ["Single", "Double", "Trixie", "3-leg accumulator", "4-leg accumulator"]);
  assert.equal(betslip[0].stake, 8);
  assert.ok(betslip[0].potentialReturn > 10);
});

test("single selection shifts from steady to riskier value as risk rises", () => {
  const steady = combo("single", 1.53, 84, 1);
  steady.averageEdge = 0.044;
  steady.expectedValue = 0.07;
  steady.legs[0].edge = 0.044;
  steady.legs[0].confidence = 0.81;
  steady.legs[0].riskTag = "steady_edge";
  steady.legs[0].selectionLabel = "Mexico vs South Africa: Mexico to win";

  const spicy = combo("single", 2.13, 86, 1);
  spicy.averageEdge = 0.226;
  spicy.expectedValue = 0.45;
  spicy.legs[0].edge = 0.226;
  spicy.legs[0].confidence = 0.81;
  spicy.legs[0].riskTag = "calculated_risk";
  spicy.legs[0].selectionLabel = "Mexico vs South Africa: Both teams to score: Yes";

  const recommendations = { singles: [steady, spicy], doubles: [], trixies: [], accumulatorsByLegCount: {}, accumulators: [] };

  assert.equal(selectBetslip({ recommendations, stake: 10, risk: 5 })[0].legs[0].selectionLabel, "Mexico vs South Africa: Mexico to win");
  assert.equal(selectBetslip({ recommendations, stake: 10, risk: 90 })[0].legs[0].selectionLabel, "Mexico vs South Africa: Both teams to score: Yes");
});

function combo(type, odds, score, legCount) {
  return {
    id: `${type}_${odds}`,
    type,
    score,
    legCount,
    combinedDecimalOdds: odds,
    combinedProbability: 0.31,
    expectedValue: 0.18,
    averageConfidence: 0.72,
    riskLegCount: type === "double" ? 0 : 1,
    legs: Array.from({ length: legCount }, (_, index) => ({
      id: `${type}_${odds}_${index}`,
      selectionLabel: `Public fixture ${index + 1} value`,
      decimalOdds: 1.8 + index * 0.15
    })),
    thesis: "Public fixture combo"
  };
}
