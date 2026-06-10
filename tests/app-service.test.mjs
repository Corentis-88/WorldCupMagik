import test from "node:test";
import assert from "node:assert/strict";
import { buildRiskPolicy, selectBetslip, selectFixturesForWindow } from "../src/app-service.mjs";
import { buildMostLikelyPicks } from "../src/portfolio-builder.mjs";
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
  assert.equal(betslip[0].stake, 40);
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

test("most likely picks ignore risk score and choose highest model probability legs", () => {
  const legs = [
    likelyLeg("flashy-longshot", "flashy", 0.28, 99, 5.5),
    likelyLeg("p1", "safe one", 0.74, 71, 1.45),
    likelyLeg("p2", "safe two", 0.71, 70, 1.52),
    likelyLeg("p3", "safe three", 0.68, 69, 1.58),
    likelyLeg("p4", "safe four", 0.66, 68, 1.62),
    likelyLeg("p5", "safe five", 0.64, 67, 1.66),
    likelyLeg("p6", "safe six", 0.62, 66, 1.7),
    likelyLeg("p7", "safe seven", 0.6, 65, 1.74),
    likelyLeg("p8", "safe eight", 0.58, 64, 1.8)
  ];
  const picks = buildMostLikelyPicks(legs, {
    riskProfile: {
      minLegEdge: 0,
      minLegConfidence: 0.5
    }
  });

  assert.deepEqual(picks.map((pick) => pick.category), ["single", "double", "trixie", "accumulator_4", "accumulator_8"]);
  assert.deepEqual(picks.find((pick) => pick.category === "trixie").legs.map((leg) => leg.fixtureId), ["p1", "p2", "p3"]);
  assert.ok(!picks.find((pick) => pick.category === "accumulator_8").legs.some((leg) => leg.fixtureId === "flashy-longshot"));
});

test("most likely long accumulators prefer survivable legs over fragile BTTS value", () => {
  const steadyLegs = Array.from({ length: 8 }, (_, index) => {
    return likelyLeg(`safe-${index + 1}`, `safe ${index + 1}`, 0.7 - index * 0.015, 70 - index, 1.5 + index * 0.04);
  });
  const fragileBtts = {
    ...likelyLeg("fragile-btts", "Spain vs Saudi Arabia: Both teams to score: Yes", 0.69, 96, 2.46),
    market: "both_teams_to_score",
    outcome: "Yes",
    rawModelProbability: 0.69,
    marketImpliedProbability: 1 / 2.46,
    independentEdge: 0.28,
    edge: 0.24,
    riskTag: "calculated_risk",
    components: {
      intelligenceConfidence: 0.78,
      oddsFreshness: 1,
      nonMarketSignalCount: 6,
      expectedGoals: 3.03,
      homeExpectedGoals: 1.59,
      awayExpectedGoals: 1.45,
      homeBttsRate: 0.55,
      awayBttsRate: 0.2,
      homeOver25Rate: 0.7,
      awayOver25Rate: 0.1
    }
  };
  const picks = buildMostLikelyPicks([...steadyLegs, fragileBtts], {
    riskProfile: {
      minLegEdge: 0,
      minLegConfidence: 0.5
    }
  });
  const eightLeg = picks.find((pick) => pick.category === "accumulator_8");

  assert.ok(eightLeg);
  assert.ok(!eightLeg.legs.some((leg) => leg.fixtureId === "fragile-btts"));
  assert.ok(Number(eightLeg.averageSurvivalProbability) > 0.55);
});

test("most likely long accumulators avoid all-one-market goal slips when alternatives exist", () => {
  const overLegs = Array.from({ length: 8 }, (_, index) => ({
    ...likelyLeg(`over-${index + 1}`, `open game ${index + 1}: Over 2.5 goals`, 0.71 - index * 0.01, 84 - index, 1.6 + index * 0.03),
    market: "over_2_5_goals",
    outcome: "over_2_5_goals",
    components: {
      intelligenceConfidence: 0.76,
      oddsFreshness: 1,
      nonMarketSignalCount: 5,
      expectedGoals: 2.8,
      homeExpectedGoals: 1.45,
      awayExpectedGoals: 1.35
    }
  }));
  const resultLegs = Array.from({ length: 4 }, (_, index) => likelyLeg(`result-${index + 1}`, `result ${index + 1}: team to win`, 0.66 - index * 0.01, 74 - index, 1.58 + index * 0.04));
  const picks = buildMostLikelyPicks([...overLegs, ...resultLegs], {
    riskProfile: {
      minLegEdge: 0,
      minLegConfidence: 0.5
    }
  });
  const eightLeg = picks.find((pick) => pick.category === "accumulator_8");

  assert.ok(eightLeg);
  const overCount = eightLeg.legs.filter((leg) => leg.market === "over_2_5_goals").length;
  assert.ok(overCount <= 5);
  assert.ok(eightLeg.legs.some((leg) => leg.market === "match_winner"));
});

test("most likely long accumulators limit repeated team correlation when alternatives exist", () => {
  const canadaLegs = Array.from({ length: 6 }, (_, index) => likelyLeg(
    `canada-${index + 1}`,
    `Canada fixture ${index + 1}: Canada to win`,
    0.72 - index * 0.006,
    82 - index,
    1.55 + index * 0.03,
    { homeTeam: "Canada", awayTeam: `Opponent ${index + 1}`, fixtureDate: `2026-06-${String(12 + index).padStart(2, "0")}T19:00:00.000Z` }
  ));
  const alternatives = Array.from({ length: 6 }, (_, index) => likelyLeg(
    `alt-${index + 1}`,
    `Alternative ${index + 1}: home to win`,
    0.66 - index * 0.006,
    74 - index,
    1.62 + index * 0.03,
    { homeTeam: `Home ${index + 1}`, awayTeam: `Away ${index + 1}`, fixtureDate: `2026-06-${String(12 + index).padStart(2, "0")}T21:00:00.000Z` }
  ));
  const picks = buildMostLikelyPicks([...canadaLegs, ...alternatives], {
    riskProfile: {
      minLegEdge: 0,
      minLegConfidence: 0.5
    }
  });
  const eightLeg = picks.find((pick) => pick.category === "accumulator_8");

  assert.ok(eightLeg);
  const canadaExposure = eightLeg.legs.filter((leg) => [leg.homeTeam, leg.awayTeam].includes("Canada")).length;
  assert.ok(canadaExposure <= 4, `Canada exposure was ${canadaExposure}`);
  assert.ok(Number.isFinite(eightLeg.correlationPenalty));
  assert.equal(eightLeg.marketFamilyMix.result >= 1, true);
});

test("most likely picks only show categories the fixture window can support", () => {
  const legs = [
    likelyLeg("p1", "safe one", 0.74, 71, 1.45),
    likelyLeg("p1", "same match backup", 0.71, 70, 1.52),
    likelyLeg("p2", "safe two", 0.69, 69, 1.58)
  ];
  const picks = buildMostLikelyPicks(legs, {
    riskProfile: {
      minLegEdge: 0,
      minLegConfidence: 0.5
    }
  }, { fixtureCount: 3 });

  assert.deepEqual(picks.map((pick) => pick.category), ["single", "double", "trixie"]);
  assert.equal(picks.find((pick) => pick.category === "trixie").legs.length, 3);
  assert.equal(picks.find((pick) => pick.category === "trixie").shortWindowFallback, true);
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

function likelyLeg(fixtureId, label, modelProbability, score, decimalOdds, overrides = {}) {
  return {
    id: `leg-${fixtureId}`,
    fixtureId,
    fixtureDate: overrides.fixtureDate || "2026-06-13T19:00:00.000Z",
    homeTeam: overrides.homeTeam || `Home ${fixtureId}`,
    awayTeam: overrides.awayTeam || `Away ${fixtureId}`,
    market: "match_winner",
    selectionLabel: label,
    bookmaker: "Public Test Book",
    decimalOdds,
    modelProbability,
    impliedProbability: 1 / decimalOdds,
    edge: Math.max(0.01, modelProbability - (1 / decimalOdds)),
    confidence: 0.76,
    score,
    riskTag: score > 90 ? "longshot_value" : "steady_edge",
    hardBlocks: [],
    components: {
      intelligenceConfidence: 0.72,
      oddsFreshness: 1
    },
    thesis: `${label} thesis`
  };
}
