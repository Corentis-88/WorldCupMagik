import { clamp, combinations, mean, product, round } from "./utils.mjs";

const MOST_LIKELY_TARGETS = [
  { category: "trixie", label: "Trixie", type: "trixie", legCount: 3 },
  { category: "accumulator_4", label: "4-leg accumulator", type: "accumulator", legCount: 4 },
  { category: "accumulator_8", label: "8-leg accumulator", type: "accumulator", legCount: 8 }
];

export function buildBetRecommendations(legs, policy) {
  const riskProfile = policy.riskProfile || {};
  const eligibleLegs = legs
    .filter((leg) => !leg.hardBlocks?.length)
    .filter((leg) => Number(leg.edge) >= Number(riskProfile.minLegEdge || 0))
    .filter((leg) => Number(leg.confidence) >= Number(riskProfile.minLegConfidence || 0))
    .sort((left, right) => right.score - left.score);
  const accumulatorsByLegCount = buildAccumulatorRecommendationsByLegCount(eligibleLegs, policy);

  return {
    createdAt: new Date().toISOString(),
    eligibleLegCount: eligibleLegs.length,
    singles: rankCombos(eligibleLegs.map((leg) => [leg]), "single", policy).slice(0, 12),
    doubles: rankCombos(combinations(eligibleLegs, 2), "double", policy).slice(0, 8),
    trixies: rankCombos(combinations(eligibleLegs, 3), "trixie", policy).slice(0, 8),
    accumulatorsByLegCount,
    accumulators: Object.values(accumulatorsByLegCount).flat().sort((left, right) => right.score - left.score).slice(0, 16)
  };
}

export function buildMostLikelyPicks(legs, policy) {
  const riskProfile = policy.riskProfile || {};
  const eligibleLegs = legs
    .filter((leg) => !leg.hardBlocks?.length)
    .filter((leg) => Number(leg.edge) >= Number(riskProfile.minLegEdge ?? 0))
    .filter((leg) => Number(leg.confidence) >= Number(riskProfile.minLegConfidence ?? 0))
    .filter((leg) => Number(leg.modelProbability) > 0)
    .sort((left, right) => likelyLegScore(right) - likelyLegScore(left));
  const bestPerFixture = bestLikelyLegPerFixture(eligibleLegs);

  return MOST_LIKELY_TARGETS
    .map((target, index) => {
      const selectedLegs = bestPerFixture.slice(0, target.legCount);

      if (selectedLegs.length < target.legCount) {
        return null;
      }

      return scoreMostLikelyCombo(selectedLegs, target, index + 1);
    })
    .filter(Boolean);
}

function buildAccumulatorRecommendationsByLegCount(eligibleLegs, policy) {
  const maxLegs = Math.min(Number(policy.riskProfile?.maxLegs || 8), 8);
  const requestedLegCounts = [3, 4, 5, 6, 8].filter((legCount) => legCount <= maxLegs);
  const byLegCount = {};

  for (const size of requestedLegCounts) {
    const candidatePool = eligibleLegs.slice(0, accumulatorPoolSize(size));
    byLegCount[size] = rankCombos(combinations(candidatePool, size, accumulatorCombinationLimit(size)), "accumulator", policy).slice(0, 8);
  }

  return byLegCount;
}

function bestLikelyLegPerFixture(legs) {
  const byFixture = new Map();

  for (const leg of legs) {
    const existing = byFixture.get(leg.fixtureId);

    if (!existing || likelyLegScore(leg) > likelyLegScore(existing)) {
      byFixture.set(leg.fixtureId, leg);
    }
  }

  return [...byFixture.values()].sort((left, right) => likelyLegScore(right) - likelyLegScore(left));
}

function likelyLegScore(leg) {
  const probability = likelyWinProbability(leg);
  const confidence = Number(leg.confidence || 0);
  const edge = Number(leg.edge || 0);
  const intelligence = Number(leg.components?.intelligenceConfidence || 0.45);
  const freshness = Number(leg.components?.oddsFreshness || 0.75);

  return probability * 64
    + confidence * 22
    + intelligence * 7
    + freshness * 4
    + clamp(edge, 0, 0.12) * 35;
}

function likelyWinProbability(leg) {
  const model = Number(leg.modelProbability || 0);
  const market = Number(leg.marketImpliedProbability || leg.impliedProbability || 0);
  const confidence = Number(leg.confidence || 0);
  const edge = Number(leg.edge || 0);

  if (!market) {
    return clamp(model, 0.03, 0.92);
  }

  const modelLiftCap = 0.16 + confidence * 0.05 + clamp(edge, 0, 0.12) * 0.5;
  const marketSaneModel = Math.min(model, market + modelLiftCap);

  return clamp((marketSaneModel * 0.82) + (model * 0.12) + (confidence * 0.06), 0.03, 0.92);
}

function scoreMostLikelyCombo(legs, target, rank) {
  const combinedDecimalOdds = product(legs.map((leg) => leg.decimalOdds));
  const combinedProbability = product(legs.map(likelyWinProbability));
  const expectedValue = combinedProbability * combinedDecimalOdds - 1;
  const averageEdge = mean(legs.map((leg) => leg.edge));
  const averageConfidence = mean(legs.map((leg) => leg.confidence));
  const intelligenceConfidence = mean(legs.map((leg) => leg.components?.intelligenceConfidence || 0.45));
  const score = clamp(
    combinedProbability * 100
    + averageConfidence * 18
    + intelligenceConfidence * 8
    + clamp(averageEdge, 0, 0.12) * 55,
    0,
    100
  );

  return {
    id: `most_likely_${target.category}_${legs.map((leg) => leg.id).join("_").slice(0, 48)}`,
    rank,
    category: target.category,
    label: target.label,
    type: target.type,
    legCount: target.legCount,
    legs: legs.map((leg) => ({
      id: leg.id,
      fixtureId: leg.fixtureId,
      market: leg.market,
      playerName: leg.playerName,
      selectionLabel: leg.selectionLabel,
      bookmaker: leg.bookmaker,
      decimalOdds: leg.decimalOdds,
      likelyProbability: round(likelyWinProbability(leg), 4),
      modelProbability: leg.modelProbability,
      impliedProbability: leg.impliedProbability,
      edge: leg.edge,
      confidence: leg.confidence,
      riskTag: leg.riskTag,
      marketImpliedProbability: leg.marketImpliedProbability,
      components: {
        intelligenceConfidence: leg.components?.intelligenceConfidence,
        oddsMovement: leg.components?.oddsMovement,
        oddsShortening: leg.components?.oddsShortening,
        oddsDrifting: leg.components?.oddsDrifting,
        marketAverageOdds: leg.components?.marketAverageOdds,
        oddsFreshness: leg.components?.oddsFreshness
      },
      thesis: leg.thesis
    })),
    combinedDecimalOdds: round(combinedDecimalOdds, 2),
    combinedProbability: round(combinedProbability, 4),
    expectedValue: round(expectedValue, 4),
    averageEdge: round(averageEdge, 4),
    averageConfidence: round(averageConfidence, 4),
    riskLegCount: legs.filter((leg) => ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag)).length,
    intelligenceConfidence: round(intelligenceConfidence, 4),
    score: round(score, 2),
    hardBlocks: [],
    thesis: buildMostLikelyThesis({ target, legs, combinedDecimalOdds, combinedProbability, averageConfidence })
  };
}

function buildMostLikelyThesis({ target, legs, combinedDecimalOdds, combinedProbability, averageConfidence }) {
  const selections = legs.map((leg) => leg.selectionLabel).join(" | ");

  return `${target.label} chosen by the most-likely engine, ignoring the risk slider and ranking by model win probability, confidence, fresh odds, and positive edge. Combined odds ${round(combinedDecimalOdds, 2)}, model hit chance ${round(combinedProbability * 100, 2)}%, average confidence ${round(averageConfidence * 100, 1)}%. Legs: ${selections}.`;
}

function accumulatorPoolSize(size) {
  if (size >= 8) {
    return 26;
  }

  if (size >= 6) {
    return 28;
  }

  return 32;
}

function accumulatorCombinationLimit(size) {
  if (size >= 8) {
    return 30000;
  }

  if (size >= 6) {
    return 25000;
  }

  return 20000;
}

function rankCombos(combos, type, policy) {
  return combos
    .map((legs) => scoreCombo(legs, type, policy))
    .filter((combo) => combo && !combo.hardBlocks.length)
    .sort((left, right) => right.score - left.score);
}

export function scoreCombo(legs, type, policy) {
  const hardBlocks = [];
  const fixtureIds = new Set(legs.map((leg) => leg.fixtureId));
  const combinedDecimalOdds = product(legs.map((leg) => leg.decimalOdds));
  const combinedProbability = product(legs.map((leg) => leg.modelProbability));
  const expectedValue = combinedProbability * combinedDecimalOdds - 1;
  const averageEdge = mean(legs.map((leg) => leg.edge));
  const averageConfidence = mean(legs.map((leg) => leg.confidence));
  const riskLegs = legs.filter((leg) => ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag));
  const intelligenceConfidence = mean(legs.map((leg) => leg.components?.intelligenceConfidence || 0.45));
  const marketConfirmedLegs = legs.filter((leg) => leg.riskTag === "market_confirmed_edge");
  const contrarianLegs = legs.filter((leg) => leg.riskTag === "contrarian_value");
  const favouriteLegs = legs.filter((leg) => Number(leg.impliedProbability) >= Number(policy.riskProfile?.maxFavoriteImpliedProbability || 0.72));
  const preferred = preferredOddsRange(type, legs.length, policy);

  if (fixtureIds.size !== legs.length) {
    hardBlocks.push("same_fixture_correlation");
  }

  if (combinedDecimalOdds < preferred.min || combinedDecimalOdds > preferred.max) {
    hardBlocks.push("combined_odds_outside_policy_range");
  }

  if (combinedDecimalOdds > Number(policy.riskProfile?.maxCombinedOdds || 50)) {
    hardBlocks.push("combined_odds_above_absolute_cap");
  }

  if (type === "trixie" && riskLegs.length < Number(policy.riskProfile?.minRiskLegsForTrixie || 1)) {
    hardBlocks.push("trixie_missing_calculated_risk_leg");
  }

  if ((type === "trixie" || type === "accumulator") && favouriteLegs.length === legs.length) {
    hardBlocks.push("all_legs_are_high_implied_probability_favourites");
  }

  const oddsFit = oddsFitScore(combinedDecimalOdds, preferred.min, preferred.max);
  const diversityBonus = riskLegs.length > 0 ? Math.min(8, riskLegs.length * 3.5) : -5;
  const intelligenceBonus = clamp((intelligenceConfidence - 0.5) * 11 + marketConfirmedLegs.length * 1.5 + contrarianLegs.length * 2, -5, 10);
  const favouritePenalty = favouriteLegs.length * 4;
  const sizePenalty = type === "accumulator" ? Math.max(0, legs.length - 3) * 3 : 0;
  const score = clamp(34
    + averageEdge * 95
    + averageConfidence * 22
    + Math.max(-8, Math.min(8, expectedValue * 8))
    + oddsFit * 0.8
    + diversityBonus
    + intelligenceBonus
    - favouritePenalty
    - sizePenalty, 0, 100);

  return {
    id: `${type}_${legs.map((leg) => leg.id).join("_").slice(0, 48)}`,
    type,
    legCount: legs.length,
    legs: legs.map((leg) => ({
      id: leg.id,
      fixtureId: leg.fixtureId,
      market: leg.market,
      playerName: leg.playerName,
      selectionLabel: leg.selectionLabel,
      bookmaker: leg.bookmaker,
      decimalOdds: leg.decimalOdds,
      modelProbability: leg.modelProbability,
      impliedProbability: leg.impliedProbability,
      edge: leg.edge,
      confidence: leg.confidence,
      riskTag: leg.riskTag,
      marketImpliedProbability: leg.marketImpliedProbability,
      components: {
        intelligenceConfidence: leg.components?.intelligenceConfidence,
        oddsMovement: leg.components?.oddsMovement,
        oddsShortening: leg.components?.oddsShortening,
        oddsDrifting: leg.components?.oddsDrifting,
        marketAverageOdds: leg.components?.marketAverageOdds
      },
      thesis: leg.thesis
    })),
    combinedDecimalOdds: round(combinedDecimalOdds, 2),
    combinedProbability: round(combinedProbability, 4),
    expectedValue: round(expectedValue, 4),
    averageEdge: round(averageEdge, 4),
    averageConfidence: round(averageConfidence, 4),
    riskLegCount: riskLegs.length,
    intelligenceConfidence: round(intelligenceConfidence, 4),
    marketConfirmedLegCount: marketConfirmedLegs.length,
    contrarianLegCount: contrarianLegs.length,
    favouriteLegCount: favouriteLegs.length,
    score: round(score, 2),
    hardBlocks,
    thesis: buildComboThesis({ type, legs, combinedDecimalOdds, expectedValue, riskLegs, favouriteLegs })
  };
}

function preferredOddsRange(type, legCount, policy) {
  const riskProfile = policy.riskProfile || {};

  if (type === "accumulator") {
    return riskProfile.preferredCombinedOdds?.accumulatorByLegCount?.[legCount]
      || riskProfile.preferredCombinedOdds?.accumulator
      || { min: 1, max: riskProfile.maxCombinedOdds || 50 };
  }

  return riskProfile.preferredCombinedOdds?.[type] || { min: 1, max: riskProfile.maxCombinedOdds || 50 };
}

function oddsFitScore(value, min, max) {
  if (value < min || value > max) {
    return -12;
  }

  const midpoint = (min + max) / 2;
  const spread = Math.max(1, (max - min) / 2);
  return 10 * (1 - Math.min(1, Math.abs(value - midpoint) / spread));
}

function buildComboThesis({ type, legs, combinedDecimalOdds, expectedValue, riskLegs, favouriteLegs }) {
  const selections = legs.map((leg) => leg.selectionLabel).join(" | ");
  const riskText = riskLegs.length
    ? `${riskLegs.length} calculated-risk/value leg(s) stop this from being a favourite-only ${type}.`
    : `No calculated-risk leg; this should only survive if the edge is exceptional.`;
  const favouriteText = favouriteLegs.length ? `${favouriteLegs.length} high-implied-probability favourite leg(s).` : "No high-implied-probability favourite crowding.";

  return `${type} at combined odds ${round(combinedDecimalOdds, 2)} with expected value ${round(expectedValue * 100, 2)}%. ${riskText} ${favouriteText} Legs: ${selections}.`;
}
