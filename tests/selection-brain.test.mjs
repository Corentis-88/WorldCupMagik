import assert from "node:assert/strict";
import test from "node:test";

import { probabilityRangeForCombo, selectionBrainMetadata } from "../src/selection-brain.mjs";

test("selection brain widens probability ranges for correlated player-prop slips", () => {
  const steady = combo({
    combinedProbability: 0.42,
    survivalCombinedProbability: 0.43,
    averageSurvivalProbability: 0.69,
    averageConfidence: 0.82,
    averageNonMarketSignalCount: 6,
    correlationPenalty: 0,
    scorerLegCount: 0,
    fragileLegCount: 0
  });
  const fragile = combo({
    combinedProbability: 0.42,
    survivalCombinedProbability: 0.43,
    averageSurvivalProbability: 0.69,
    averageConfidence: 0.58,
    averageNonMarketSignalCount: 2,
    correlationPenalty: 24,
    scorerLegCount: 2,
    fragileLegCount: 2,
    repeatedTeamCount: 1,
    marketFamilyMix: { player: 3 },
    legs: [
      leg("a", "anytime_scorer"),
      leg("b", "anytime_assist"),
      leg("c", "anytime_scorer")
    ]
  });

  const steadyRange = probabilityRangeForCombo(steady, { risk: 30 });
  const fragileRange = probabilityRangeForCombo(fragile, { risk: 90 });
  const metadata = selectionBrainMetadata(fragile, { risk: 90 });

  assert.ok(fragileRange.width > steadyRange.width);
  assert.equal(fragileRange.label, "wide");
  assert.ok(metadata.portfolioWarnings.includes("correlated_slip"));
  assert.ok(metadata.portfolioWarnings.includes("player_prop_variance"));
});

test("high risk identifies logical free-bet value without hiding weak picks", () => {
  const logicalValue = combo({
    combinedDecimalOdds: 24,
    combinedProbability: 0.08,
    survivalCombinedProbability: 0.085,
    averageSurvivalProbability: 0.66,
    averageConfidence: 0.76,
    averageIndependentEdge: 0.13,
    averageNonMarketSignalCount: 5,
    expectedValue: 0.92,
    legCount: 4,
    legs: [leg("a"), leg("b"), leg("c"), leg("d")]
  });
  const weakBestAvailable = combo({
    combinedDecimalOdds: 42,
    combinedProbability: 0.012,
    survivalCombinedProbability: 0.011,
    averageSurvivalProbability: 0.39,
    averageConfidence: 0.48,
    averageIndependentEdge: 0.16,
    averageNonMarketSignalCount: 1,
    expectedValue: 0.22,
    correlationPenalty: 18,
    legCount: 6,
    legs: [leg("a"), leg("b"), leg("c"), leg("d"), leg("e"), leg("f")]
  });

  const logicalMetadata = selectionBrainMetadata(logicalValue, { risk: 85, category: { type: "accumulator", legCount: 4 } });
  const weakMetadata = selectionBrainMetadata(weakBestAvailable, { risk: 85, category: { type: "accumulator", legCount: 6 } });

  assert.equal(logicalMetadata.selectionIntent, "free_bet_value");
  assert.equal(logicalMetadata.recommendedUse, "free_bet");
  assert.ok(logicalMetadata.freeBetConversion > 1);
  assert.equal(weakMetadata.selectionQuality, "weak_best_available");
  assert.equal(weakMetadata.recommendedUse, "weak_best_available");
});

test("selection brain downgrades price-gone slips instead of labelling them strong", () => {
  const priceGone = combo({
    combinedDecimalOdds: 2.2,
    combinedProbability: 0.64,
    survivalCombinedProbability: 0.62,
    averageSurvivalProbability: 0.72,
    averageConfidence: 0.78,
    averageIndependentEdge: 0.08,
    averageNonMarketSignalCount: 5,
    legs: [leg("price-gone", "over_2_5_goals", {
      priceGone: true,
      bettingPerformanceScorePenalty: 14,
      bettingPerformanceMarketAction: "suppress_for_cash"
    })]
  });
  const metadata = selectionBrainMetadata(priceGone, { risk: 0, category: { type: "single", legCount: 1 } });

  assert.ok(metadata.portfolioWarnings.includes("price_gone"));
  assert.ok(metadata.portfolioWarnings.includes("market_suppressed_by_performance"));
  assert.notEqual(metadata.selectionQuality, "strong");
});

function combo(overrides = {}) {
  const legs = overrides.legs || [leg("a"), leg("b")];

  return {
    type: "accumulator",
    legCount: legs.length,
    legs,
    combinedDecimalOdds: 5.2,
    combinedProbability: 0.22,
    survivalCombinedProbability: 0.24,
    averageSurvivalProbability: 0.64,
    expectedValue: 0.12,
    averageIndependentEdge: 0.06,
    averageConfidence: 0.72,
    averageNonMarketSignalCount: 4,
    displayRating: 0.78,
    correlationPenalty: 0,
    scorerLegCount: 0,
    firstScorerLegCount: 0,
    fragileLegCount: 0,
    marketFamilyMix: { result: 2 },
    ...overrides
  };
}

function leg(id, market = "match_winner", components = {}) {
  return {
    id,
    fixtureId: `fixture-${id}`,
    market,
    decimalOdds: 1.8,
    modelProbability: 0.62,
    confidence: 0.74,
    independentEdge: 0.06,
    edge: 0.07,
    components: {
      nonMarketSignalCount: 5,
      intelligenceConfidence: 0.76,
      ...components
    }
  };
}
