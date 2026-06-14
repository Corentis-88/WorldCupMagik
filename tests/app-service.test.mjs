import test from "node:test";
import assert from "node:assert/strict";
import { buildRiskPolicy, selectBetslip, selectFixturesForWindow } from "../src/app-service.mjs";
import { buildBetRecommendations, buildMostLikelyPicks } from "../src/portfolio-builder.mjs";
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

test("fixture window excludes same-day matches that already kicked off", () => {
  const selected = selectFixturesForWindow([
    { id: "past-today", date: "2026-06-13T01:00:00.000Z", homeTeam: "USA", awayTeam: "Paraguay", sourceType: "public-web" },
    { id: "future-today", date: "2026-06-13T19:00:00.000Z", homeTeam: "Canada", awayTeam: "Bosnia", sourceType: "public-web" },
    { id: "future-tomorrow", date: "2026-06-14T17:00:00.000Z", homeTeam: "Germany", awayTeam: "Curacao", sourceType: "public-web" }
  ], 1, new Date("2026-06-13T14:30:00.000Z"));

  assert.deepEqual(selected.map((fixture) => fixture.id), ["future-today", "future-tomorrow"]);
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

test("risk-zero single selection starts from the most likely survival pick", () => {
  const likely = combo("single", 1.53, 82, 1);
  likely.combinedProbability = 0.71;
  likely.survivalCombinedProbability = 0.72;
  likely.averageSurvivalProbability = 0.72;
  likely.averageConfidence = 0.82;
  likely.displayRating = 0.86;
  likely.averageIndependentEdge = 0.05;
  likely.expectedValue = 0.08;
  likely.legs[0].edge = 0.05;
  likely.legs[0].independentEdge = 0.05;
  likely.legs[0].confidence = 0.82;
  likely.legs[0].riskTag = "steady_edge";
  likely.legs[0].selectionLabel = "Mexico vs South Africa: Over 2.5 goals";

  const value = combo("single", 2.13, 98, 1);
  value.combinedProbability = 0.62;
  value.survivalCombinedProbability = 0.62;
  value.averageSurvivalProbability = 0.62;
  value.averageConfidence = 0.8;
  value.displayRating = 0.82;
  value.averageIndependentEdge = 0.22;
  value.expectedValue = 0.45;
  value.legs[0].edge = 0.22;
  value.legs[0].independentEdge = 0.22;
  value.legs[0].confidence = 0.8;
  value.legs[0].riskTag = "calculated_risk";
  value.legs[0].selectionLabel = "Mexico vs South Africa: Both teams to score: Yes";

  const recommendations = { singles: [likely, value], doubles: [], trixies: [], accumulatorsByLegCount: {}, accumulators: [] };

  assert.equal(selectBetslip({ recommendations, stake: 10, risk: 0 })[0].legs[0].selectionLabel, "Mexico vs South Africa: Over 2.5 goals");
  assert.equal(selectBetslip({ recommendations, stake: 10, risk: 100 })[0].legs[0].selectionLabel, "Mexico vs South Africa: Both teams to score: Yes");
});

test("high risk still rejects thin survival when only price edge is better", () => {
  const likely = combo("single", 1.62, 82, 1);
  likely.combinedProbability = 0.69;
  likely.survivalCombinedProbability = 0.7;
  likely.averageSurvivalProbability = 0.7;
  likely.averageConfidence = 0.82;
  likely.displayRating = 0.86;
  likely.averageIndependentEdge = 0.05;
  likely.expectedValue = 0.08;
  likely.legs[0].edge = 0.05;
  likely.legs[0].independentEdge = 0.05;
  likely.legs[0].confidence = 0.82;
  likely.legs[0].riskTag = "steady_edge";
  likely.legs[0].selectionLabel = "Mexico vs South Africa: Over 1.5 goals";

  const thinLongshot = combo("single", 7.5, 100, 1);
  thinLongshot.combinedProbability = 0.31;
  thinLongshot.survivalCombinedProbability = 0.31;
  thinLongshot.averageSurvivalProbability = 0.31;
  thinLongshot.averageConfidence = 0.62;
  thinLongshot.displayRating = 0.66;
  thinLongshot.averageIndependentEdge = 0.38;
  thinLongshot.expectedValue = 1.32;
  thinLongshot.legs[0].edge = 0.38;
  thinLongshot.legs[0].independentEdge = 0.38;
  thinLongshot.legs[0].confidence = 0.62;
  thinLongshot.legs[0].riskTag = "longshot_value";
  thinLongshot.legs[0].selectionLabel = "Mexico vs South Africa: exact-value longshot";

  const recommendations = { singles: [likely, thinLongshot], doubles: [], trixies: [], accumulatorsByLegCount: {}, accumulators: [] };

  assert.equal(selectBetslip({ recommendations, stake: 10, risk: 100 })[0].legs[0].selectionLabel, "Mexico vs South Africa: Over 1.5 goals");
});

test("short date windows still populate long risk slips from real legs", () => {
  const baseLegs = [
    likelyLeg("f1", "Fixture 1: favourite to win", 0.66, 82, 1.62),
    likelyLeg("f2", "Fixture 2: favourite to win", 0.64, 81, 1.7),
    likelyLeg("f3", "Fixture 3: favourite to win", 0.62, 80, 1.78),
    likelyLeg("f4", "Fixture 4: favourite to win", 0.6, 79, 1.86)
  ];
  const extraLegs = [
    likelyLeg("f1-u35", "Fixture 1: under 3.5 goals", 0.71, 88, 1.54, { fixtureId: "f1", market: "under_3_5_goals", outcome: "Under" }),
    likelyLeg("f2-u35", "Fixture 2: under 3.5 goals", 0.69, 87, 1.58, { fixtureId: "f2", market: "under_3_5_goals", outcome: "Under" }),
    likelyLeg("f3-u35", "Fixture 3: under 3.5 goals", 0.67, 86, 1.62, { fixtureId: "f3", market: "under_3_5_goals", outcome: "Under" }),
    likelyLeg("f4-u35", "Fixture 4: under 3.5 goals", 0.65, 85, 1.66, { fixtureId: "f4", market: "under_3_5_goals", outcome: "Under" })
  ];
  const recommendations = buildBetRecommendations([...baseLegs, ...extraLegs], buildRiskPolicy(policy, 100));
  const betslip = selectBetslip({ recommendations, stake: 10, risk: 100 });
  const categories = betslip.map((bet) => bet.category);
  const eightLeg = betslip.find((bet) => bet.category === "accumulator_8");

  assert.deepEqual(categories, ["single", "double", "trixie", "accumulator_3", "accumulator_4", "accumulator_5", "accumulator_6", "accumulator_8"]);
  assert.equal(eightLeg.legs.length, 8);
  assert.equal(new Set(eightLeg.legs.map((leg) => leg.id)).size, 8);
  assert.ok(new Set(eightLeg.legs.map((leg) => leg.fixtureId)).size < eightLeg.legs.length);
  assert.match(eightLeg.thesis, /Short-window fallback active/);
});

test("short date fallback caps extreme accumulator returns", () => {
  const legs = [
    likelyLeg("f1", "Fixture 1: under 2.5 goals", 0.57, 96, 4, { market: "under_2_5_goals", outcome: "Under" }),
    likelyLeg("f1-btts-no", "Fixture 1: BTTS No", 0.49, 94, 3.8, { fixtureId: "f1", market: "both_teams_to_score", outcome: "No" }),
    likelyLeg("f1-home", "Fixture 1: home value win", 0.5, 92, 2.8, { fixtureId: "f1", market: "match_winner", outcome: "Home" }),
    likelyLeg("f2", "Fixture 2: favourite to win", 0.55, 93, 3.2),
    likelyLeg("f2-u35", "Fixture 2: under 3.5 goals", 0.54, 92, 2.9, { fixtureId: "f2", market: "under_3_5_goals", outcome: "Under" }),
    likelyLeg("f2-dc", "Fixture 2: double chance", 0.61, 90, 2.2, { fixtureId: "f2", market: "double_chance", outcome: "Home or Draw" }),
    likelyLeg("f3", "Fixture 3: home value win", 0.51, 92, 3.4),
    likelyLeg("f3-u45", "Fixture 3: under 4.5 goals", 0.62, 89, 2.1, { fixtureId: "f3", market: "under_4_5_goals", outcome: "Under" }),
    likelyLeg("f1-draw", "Fixture 1: draw to win", 0.26, 99, 17, {
      fixtureId: "f1",
      market: "match_winner",
      outcome: "Draw",
      rawModelProbability: 0.28,
      independentEdge: 0.12,
      edge: 0.12
    })
  ];
  const recommendations = buildBetRecommendations(legs, buildRiskPolicy(policy, 75));
  const betslip = selectBetslip({ recommendations, stake: 10, risk: 75 });
  const eightLeg = betslip.find((bet) => bet.category === "accumulator_8");

  assert.ok(eightLeg);
  assert.ok(eightLeg.shortWindowFallback);
  assert.equal(new Set(eightLeg.legs.map((leg) => leg.id)).size, 8);
  assert.ok(Number(eightLeg.uncappedCombinedDecimalOdds) > Number(eightLeg.combinedDecimalOdds));
  assert.ok(eightLeg.combinedDecimalOdds < 600, `combined odds were ${eightLeg.combinedDecimalOdds}`);
  assert.ok(eightLeg.potentialReturn < 6000, `return was ${eightLeg.potentialReturn}`);
  assert.ok(!eightLeg.legs.some((leg) => Number(leg.decimalOdds) >= 10));
  assert.match(eightLeg.thesis, /Displayed fallback odds are capped/);
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

  assert.deepEqual(picks.map((pick) => pick.category), ["single", "double", "trixie", "accumulator_3", "accumulator_4", "accumulator_5", "accumulator_6", "accumulator_8"]);
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

test("most likely long accumulators avoid overloading opening-game goal legs", () => {
  const openingGoalLegs = Array.from({ length: 6 }, (_, index) => ({
    ...likelyLeg(
      `opening-goal-${index + 1}`,
      `opening game ${index + 1}: Over 2.5 goals`,
      0.72 - index * 0.01,
      86 - index,
      1.58 + index * 0.03,
      { fixtureDate: `2026-06-${String(12 + index).padStart(2, "0")}T19:00:00.000Z` }
    ),
    market: "over_2_5_goals",
    outcome: "Over",
    components: {
      intelligenceConfidence: 0.78,
      oddsFreshness: 1,
      nonMarketSignalCount: 6,
      expectedGoals: 3.05,
      homeExpectedGoals: 1.56,
      awayExpectedGoals: 1.49,
      bothOpeningGroupGame: true,
      openingGameCaution: 1
    }
  }));
  const resultLegs = Array.from({ length: 8 }, (_, index) => likelyLeg(
    `result-option-${index + 1}`,
    `result option ${index + 1}: team to win`,
    0.66 - index * 0.004,
    76 - index,
    1.56 + index * 0.025,
    { fixtureDate: `2026-06-${String(12 + index).padStart(2, "0")}T21:00:00.000Z` }
  ));
  const picks = buildMostLikelyPicks([...openingGoalLegs, ...resultLegs], {
    riskProfile: {
      minLegEdge: 0,
      minLegConfidence: 0.5
    }
  });
  const eightLeg = picks.find((pick) => pick.category === "accumulator_8");

  assert.ok(eightLeg);
  const openingGoalCount = eightLeg.legs.filter((leg) => leg.components?.bothOpeningGroupGame && leg.market === "over_2_5_goals").length;
  assert.ok(openingGoalCount <= 3, `opening goal exposure was ${openingGoalCount}`);
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

test("most likely long accumulators blend a survival result and one filtered anytime scorer", () => {
  const goalLegs = Array.from({ length: 8 }, (_, index) => likelyLeg(
    `goal-${index + 1}`,
    `Goal option ${index + 1}: over 2.5`,
    0.68 - index * 0.006,
    82 - index,
    1.62 + index * 0.025,
    {
      market: "over_2_5_goals",
      outcome: "Over",
      fixtureDate: `2026-06-${String(14 + index).padStart(2, "0")}T19:00:00.000Z`,
      components: {
        expectedGoals: 2.95,
        homeExpectedGoals: 1.55,
        awayExpectedGoals: 1.4,
        homeOver25Rate: 0.54,
        awayOver25Rate: 0.52
      }
    }
  ));
  const survivalResult = likelyLeg("survival-result", "Germany vs Curaçao: Germany to win", 0.62, 78, 1.36, {
    market: "match_winner",
    outcome: "Germany",
    rawModelProbability: 0.62,
    marketImpliedProbability: 0.735,
    impliedProbability: 1 / 1.36,
    edge: -0.115,
    independentEdge: -0.115,
    confidence: 0.78,
    components: {
      highCertaintySurvivalFavorite: true,
      nonMarketSignalCount: 5
    }
  });
  const anytimeScorer = likelyLeg("anytime-scorer", "Germany vs Curaçao: Florian Wirtz anytime scorer", 0.31, 57, 4.2, {
    market: "anytime_scorer",
    outcome: "Florian Wirtz",
    playerName: "Florian Wirtz",
    rawModelProbability: 0.34,
    marketImpliedProbability: 1 / 4.2,
    independentEdge: 0.1,
    components: {
      starterLikelihood: 0.68,
      projectedMinutes: 72,
      scorerGoalsPerTwentyTeamMatches: 5,
      scorerConfidence: 0.72,
      expectedGoals: 3.05
    }
  });
  const picks = buildMostLikelyPicks([...goalLegs, survivalResult, anytimeScorer], {
    riskProfile: {
      minLegEdge: 0,
      minLegConfidence: 0.5
    }
  });
  const eightLeg = picks.find((pick) => pick.category === "accumulator_8");

  assert.ok(eightLeg);
  assert.ok(eightLeg.legs.some((leg) => leg.id === survivalResult.id), "survival result leg was not blended in");
  assert.ok(eightLeg.legs.some((leg) => leg.id === anytimeScorer.id), "anytime scorer leg was not blended in");
});

test("most likely picks downgrade stale drifting legs close to kickoff", () => {
  const staleDrifter = likelyLeg(
    "late-stale-drifter",
    "Opening match: stale drifting goal angle",
    0.72,
    92,
    1.68,
    {
      fixtureDate: "2026-06-11T19:00:00.000Z",
      createdAt: "2026-06-11T17:20:00.000Z",
      components: {
        oddsAgeHours: 4.1,
        oddsFreshness: 0.42,
        oddsDrifting: true,
        bothOpeningGroupGame: true,
        expectedGoals: 2.74,
        nonMarketSignalCount: 4
      }
    }
  );
  const freshStable = likelyLeg(
    "late-fresh-stable",
    "Opening match: fresh stable result angle",
    0.695,
    78,
    1.62,
    {
      fixtureDate: "2026-06-11T19:00:00.000Z",
      createdAt: "2026-06-11T17:20:00.000Z",
      components: {
        oddsAgeHours: 0.6,
        oddsFreshness: 0.96,
        oddsShortening: true,
        nonMarketSignalCount: 4
      }
    }
  );
  const picks = buildMostLikelyPicks([staleDrifter, freshStable], {
    riskProfile: {
      minLegEdge: 0,
      minLegConfidence: 0.5
    }
  });

  assert.equal(picks.find((pick) => pick.category === "single").legs[0].fixtureId, "late-fresh-stable");
  assert.ok(picks.find((pick) => pick.category === "double").thesis.includes("Late-kickoff guard"));
});

test("most likely picks do not repeat exact legs in short fixture windows", () => {
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

  assert.deepEqual(picks.map((pick) => pick.category), ["single", "double"]);
  assert.ok(picks.every((pick) => new Set(pick.legs.map((leg) => leg.id)).size === pick.legs.length));
  assert.ok(picks.every((pick) => !pick.legs.some((leg) => leg.reusedSignal)));
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
  const resolvedFixtureId = overrides.fixtureId || fixtureId;

  return {
    id: overrides.id || `leg-${fixtureId}`,
    fixtureId: resolvedFixtureId,
    fixtureDate: overrides.fixtureDate || "2026-06-13T19:00:00.000Z",
    createdAt: overrides.createdAt || "2026-06-13T10:00:00.000Z",
    homeTeam: overrides.homeTeam || `Home ${resolvedFixtureId}`,
    awayTeam: overrides.awayTeam || `Away ${resolvedFixtureId}`,
    market: overrides.market || "match_winner",
    outcome: overrides.outcome,
    playerName: overrides.playerName,
    selectionLabel: label,
    bookmaker: "Public Test Book",
    decimalOdds,
    modelProbability,
    rawModelProbability: overrides.rawModelProbability ?? modelProbability,
    impliedProbability: overrides.impliedProbability ?? 1 / decimalOdds,
    marketImpliedProbability: overrides.marketImpliedProbability ?? overrides.impliedProbability ?? 1 / decimalOdds,
    edge: overrides.edge ?? Math.max(0.01, modelProbability - (1 / decimalOdds)),
    independentEdge: overrides.independentEdge ?? Math.max(0.01, (overrides.rawModelProbability ?? modelProbability) - (overrides.marketImpliedProbability ?? overrides.impliedProbability ?? 1 / decimalOdds)),
    confidence: overrides.confidence ?? 0.76,
    score,
    riskTag: score > 90 ? "longshot_value" : "steady_edge",
    hardBlocks: [],
    components: {
      intelligenceConfidence: 0.72,
      oddsFreshness: 1,
      nonMarketSignalCount: 4,
      ...(overrides.components || {})
    },
    thesis: `${label} thesis`
  };
}
