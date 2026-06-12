import { clamp, combinations, mean, product, round } from "./utils.mjs";

const MOST_LIKELY_TARGETS = [
  { category: "single", label: "Single", type: "single", legCount: 1 },
  { category: "double", label: "Double", type: "double", legCount: 2 },
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
    singles: rankCombos(eligibleLegs.map((leg) => [leg]), "single", policy),
    doubles: rankCombos(combinations(eligibleLegs, 2), "double", policy).slice(0, 8),
    trixies: rankCombos(combinations(eligibleLegs, 3), "trixie", policy).slice(0, 8),
    accumulatorsByLegCount,
    accumulators: Object.values(accumulatorsByLegCount).flat().sort((left, right) => right.score - left.score).slice(0, 16)
  };
}

export function buildMostLikelyPicks(legs, policy, { fixtureCount = null } = {}) {
  const riskProfile = policy.riskProfile || {};
  const eligibleLegs = legs
    .filter((leg) => !leg.hardBlocks?.length)
    .filter((leg) => Number(leg.edge) >= Number(riskProfile.minLegEdge ?? 0))
    .filter((leg) => Number(leg.confidence) >= Number(riskProfile.minLegConfidence ?? 0))
    .filter((leg) => Number(leg.modelProbability) > 0)
    .sort((left, right) => likelyLegScore(right) - likelyLegScore(left));
  const fixtureSeparatedCount = bestLikelyLegPerFixture(eligibleLegs).length;
  const availableFixtureCount = Number.isFinite(Number(fixtureCount)) && Number(fixtureCount) > 0
    ? Number(fixtureCount)
    : fixtureSeparatedCount;

  return MOST_LIKELY_TARGETS
    .map((target, index) => {
      if (availableFixtureCount < target.legCount) {
        return null;
      }

      const bestPerFixture = bestLikelyLegPerFixture(eligibleLegs, target.legCount);
      const targetEligibleLegs = [...eligibleLegs].sort((left, right) => likelyLegScore(right, target.legCount) - likelyLegScore(left, target.legCount));
      const selectedLegs = selectMostLikelyLegsForTarget({
        fixtureSeparatedLegs: bestPerFixture,
        eligibleLegs: targetEligibleLegs,
        legCount: target.legCount
      });

      if (!selectedLegs.length) {
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

function bestLikelyLegPerFixture(legs, legCount = 1) {
  const byFixture = new Map();

  for (const leg of legs) {
    const fixtureKey = fixtureKeyForLeg(leg);
    const existing = byFixture.get(fixtureKey);

    if (!existing || likelyLegScore(leg, legCount) > likelyLegScore(existing, legCount)) {
      byFixture.set(fixtureKey, leg);
    }
  }

  return [...byFixture.values()].sort((left, right) => likelyLegScore(right, legCount) - likelyLegScore(left, legCount));
}

function selectMostLikelyLegsForTarget({ fixtureSeparatedLegs, eligibleLegs, legCount }) {
  const selected = [];
  const selectedIds = new Set();

  addMostLikelyLegs({ selected, selectedIds, pool: fixtureSeparatedLegs, legCount, mode: "strict" });
  addMostLikelyLegs({ selected, selectedIds, pool: fixtureSeparatedLegs, legCount, mode: "balanced" });
  addMostLikelyLegs({ selected, selectedIds, pool: eligibleLegs, legCount, mode: "fallback" });
  addLeastCorrelatedLegs({ selected, selectedIds, pool: fixtureSeparatedLegs, legCount });

  if (!selected.length) {
    return [];
  }

  const fillPool = [...selected];
  let repeatIndex = 1;

  while (selected.length < legCount) {
    const leg = fillPool[(repeatIndex - 1) % fillPool.length];
    selected.push({
      ...leg,
      id: `${leg.id}_short_window_repeat_${repeatIndex}`,
      shortWindowFallback: true,
      reusedSignal: true
    });
    repeatIndex += 1;
  }

  return selected;
}

function addMostLikelyLegs({ selected, selectedIds, pool, legCount, mode }) {
  for (const leg of pool) {
    if (selected.length >= legCount) {
      break;
    }

    if (selectedIds.has(leg.id)) {
      continue;
    }

    if (selected.some((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg))) {
      continue;
    }

    if (!mostLikelyLegPassesPortfolioShape(leg, selected, legCount, mode)) {
      continue;
    }

    selected.push(leg);
    selectedIds.add(leg.id);
  }
}

function addLeastCorrelatedLegs({ selected, selectedIds, pool, legCount }) {
  while (selected.length < legCount) {
    const candidates = pool
      .filter((leg) => !selectedIds.has(leg.id))
      .filter((leg) => !selected.some((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg)))
      .filter((leg) => likelyWinProbability(leg, { legCount }) >= minimumSurvivalProbability(legCount) - 0.04)
      .filter((leg) => !(legCount >= 6 && fragileBttsHistory(leg)))
      .map((leg) => {
        const correlation = portfolioCorrelationProfile([...selected, leg], { legCount, appetite: 0 });
        return {
          leg,
          fit: likelyLegScore(leg, legCount) - correlation.penalty * 4.8
        };
      })
      .sort((left, right) => right.fit - left.fit);

    if (!candidates.length) {
      break;
    }

    selected.push(candidates[0].leg);
    selectedIds.add(candidates[0].leg.id);
  }
}

function likelyLegScore(leg, legCount = 1) {
  const probability = likelyWinProbability(leg, { legCount });
  const confidence = Number(leg.confidence || 0);
  const edge = Number(leg.edge || 0);
  const independentEdge = Number(leg.independentEdge ?? edge);
  const signalScore = clamp(Number(leg.components?.nonMarketSignalCount || 0) / 4, 0, 1);
  const intelligence = Number(leg.components?.intelligenceConfidence || 0.45);
  const freshness = Number(leg.components?.oddsFreshness || 0.75);
  const survivalPressure = survivalPressureForLegCount(legCount);
  const valueWeight = 1 - survivalPressure * 0.78;
  const portfolioPenalty = mostLikelyPortfolioPenalty(leg, legCount) * 28;

  return probability * (70 + survivalPressure * 28)
    + confidence * (18 + survivalPressure * 8)
    + intelligence * 7
    + freshness * 4
    + signalScore * (7 - survivalPressure * 4)
    + clamp(edge, 0, 0.12) * 24 * valueWeight
    + clamp(independentEdge, -0.03, 0.12) * 36 * valueWeight
    - portfolioPenalty;
}

function likelyWinProbability(leg, { legCount = 1 } = {}) {
  const model = Number(leg.modelProbability || 0);
  const rawModel = Number(leg.rawModelProbability || model);
  const market = Number(leg.marketImpliedProbability || leg.impliedProbability || 0);
  const confidence = Number(leg.confidence || 0);
  const independentEdge = Number(leg.independentEdge ?? (rawModel - market));
  const signalScore = clamp(Number(leg.components?.nonMarketSignalCount || 0) / 4, 0, 1);
  const survivalPressure = survivalPressureForLegCount(legCount);

  if (!market) {
    const noMarketProbability = (model * (0.68 - survivalPressure * 0.1))
      + (rawModel * (0.24 - survivalPressure * 0.06))
      + (confidence * (0.08 + survivalPressure * 0.16));
    return clamp(noMarketProbability - mostLikelyPortfolioPenalty(leg, legCount), 0.03, 0.92);
  }

  const modelLiftCap = 0.1
    - survivalPressure * 0.032
    + confidence * (0.035 - survivalPressure * 0.012)
    + clamp(independentEdge, 0, 0.1) * (0.42 - survivalPressure * 0.27)
    + signalScore * (0.025 - survivalPressure * 0.011);
  const marketSaneModel = Math.min(model, market + modelLiftCap);
  const modelWeight = 0.55 - survivalPressure * 0.15;
  const rawWeight = 0.25 - survivalPressure * 0.09;
  const marketWeight = 0.1 + survivalPressure * 0.24;
  const confidenceWeight = 1 - modelWeight - rawWeight - marketWeight;
  const probability = (marketSaneModel * modelWeight)
    + (rawModel * rawWeight)
    + (market * marketWeight)
    + (confidence * confidenceWeight);

  return clamp(probability - mostLikelyPortfolioPenalty(leg, legCount), 0.03, 0.92);
}

function scoreMostLikelyCombo(legs, target, rank) {
  const combinedDecimalOdds = product(legs.map((leg) => leg.decimalOdds));
  const combinedProbability = product(legs.map((leg) => likelyWinProbability(leg, { legCount: target.legCount })));
  const expectedValue = combinedProbability * combinedDecimalOdds - 1;
  const averageEdge = mean(legs.map((leg) => leg.edge));
  const averageIndependentEdge = mean(legs.map((leg) => leg.independentEdge ?? leg.edge));
  const averageConfidence = mean(legs.map((leg) => leg.confidence));
  const intelligenceConfidence = mean(legs.map((leg) => leg.components?.intelligenceConfidence || 0.45));
  const averageNonMarketSignalCount = mean(legs.map((leg) => leg.components?.nonMarketSignalCount || 0));
  const averageSurvivalProbability = mean(legs.map((leg) => likelyWinProbability(leg, { legCount: target.legCount })));
  const bttsLegCount = legs.filter(isBttsYesLeg).length;
  const fragileLegCount = legs.filter((leg) => mostLikelyPortfolioPenalty(leg, target.legCount) >= 0.035).length;
  const uniqueFixtureCount = new Set(legs.map(fixtureKeyForLeg)).size;
  const reusedSignalCount = legs.filter((leg) => leg.reusedSignal).length;
  const shortWindowFallback = uniqueFixtureCount < legs.length || reusedSignalCount > 0;
  const survivalPressure = survivalPressureForLegCount(target.legCount);
  const correlation = portfolioCorrelationProfile(legs, { legCount: target.legCount, appetite: 0 });
  const score = clamp(
    combinedProbability * (120 + survivalPressure * 240)
    + averageSurvivalProbability * (42 + survivalPressure * 42)
    + averageConfidence * 18
    + intelligenceConfidence * 8
    + clamp(averageEdge, 0, 0.12) * (32 - survivalPressure * 20)
    + clamp(averageIndependentEdge, -0.03, 0.12) * (42 - survivalPressure * 30)
    + clamp(averageNonMarketSignalCount / 4, 0, 1) * (8 - survivalPressure * 4)
    - bttsClusterPenalty(bttsLegCount, target.legCount)
    - marketClusterPenalty(legs, target.legCount)
    - correlation.penalty
    - fragileLegCount * 4.5,
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
      fixtureDate: leg.fixtureDate,
      homeTeam: leg.homeTeam,
      awayTeam: leg.awayTeam,
      market: leg.market,
      playerName: leg.playerName,
      selectionLabel: leg.selectionLabel,
      bookmaker: leg.bookmaker,
      decimalOdds: leg.decimalOdds,
      likelyProbability: round(likelyWinProbability(leg, { legCount: target.legCount }), 4),
      modelProbability: leg.modelProbability,
      rawModelProbability: leg.rawModelProbability,
      impliedProbability: leg.impliedProbability,
      marketImpliedProbability: leg.marketImpliedProbability,
      independentEdge: leg.independentEdge,
      edge: leg.edge,
      confidence: leg.confidence,
      riskTag: leg.riskTag,
      components: {
        intelligenceConfidence: leg.components?.intelligenceConfidence,
        nonMarketSignalCount: leg.components?.nonMarketSignalCount,
        nonMarketSignals: leg.components?.nonMarketSignals,
        independentEvidenceStrength: leg.components?.independentEvidenceStrength,
        marketBlendLift: leg.components?.marketBlendLift,
        oddsMovement: leg.components?.oddsMovement,
        oddsShortening: leg.components?.oddsShortening,
        oddsDrifting: leg.components?.oddsDrifting,
        marketAverageOdds: leg.components?.marketAverageOdds,
        oddsFreshness: leg.components?.oddsFreshness,
        heatStress: leg.components?.heatStress,
        heatConfidence: leg.components?.heatConfidence,
        heatClimateBand: leg.components?.heatClimateBand,
        heatExpectedGoalsAdjustment: leg.components?.heatExpectedGoalsAdjustment,
        heatEdge: leg.components?.heatEdge,
        heatLocation: leg.components?.heatLocation,
        homeSquadDepth: leg.components?.homeSquadDepth,
        awaySquadDepth: leg.components?.awaySquadDepth,
        squadDepthConfidence: leg.components?.squadDepthConfidence,
        homeHistoricalHeatMemory: leg.components?.homeHistoricalHeatMemory,
        awayHistoricalHeatMemory: leg.components?.awayHistoricalHeatMemory,
        combinedHeatDifferential: leg.components?.combinedHeatDifferential,
        homeLongMatchCount: leg.components?.homeLongMatchCount,
        awayLongMatchCount: leg.components?.awayLongMatchCount,
        homeBttsRate: leg.components?.homeBttsRate,
        awayBttsRate: leg.components?.awayBttsRate,
        homeOver25Rate: leg.components?.homeOver25Rate,
        awayOver25Rate: leg.components?.awayOver25Rate,
        tournamentPhase: leg.components?.tournamentPhase,
        homeGroupGameNumber: leg.components?.homeGroupGameNumber,
        awayGroupGameNumber: leg.components?.awayGroupGameNumber,
        bothOpeningGroupGame: leg.components?.bothOpeningGroupGame,
        oneOpeningGroupGame: leg.components?.oneOpeningGroupGame,
        openingGameCaution: leg.components?.openingGameCaution,
        tournamentExpectedGoalsAdjustment: leg.components?.tournamentExpectedGoalsAdjustment,
        tournamentBttsAdjustment: leg.components?.tournamentBttsAdjustment,
        tournamentDrawLift: leg.components?.tournamentDrawLift,
        tournamentContextNote: leg.components?.tournamentContextNote,
        confidenceReasons: leg.components?.confidenceReasons,
        scorerMarketType: leg.components?.scorerMarketType,
        teamGoalLikelihood: leg.components?.teamGoalLikelihood,
        teamFirstGoalShare: leg.components?.teamFirstGoalShare,
        starterLikelihood: leg.components?.starterLikelihood,
        projectedMinutes: leg.components?.projectedMinutes,
        scorerGoalsPerTwentyTeamMatches: leg.components?.scorerGoalsPerTwentyTeamMatches,
        scorerConfidence: leg.components?.scorerConfidence,
        survivalPenalty: round(mostLikelyPortfolioPenalty(leg, target.legCount), 4),
        lateKickoffGuard: lateKickoffGuard(leg, target.legCount)
      },
      shortWindowFallback: Boolean(leg.shortWindowFallback),
      reusedSignal: Boolean(leg.reusedSignal),
      thesis: leg.thesis
    })),
    combinedDecimalOdds: round(combinedDecimalOdds, 2),
    combinedProbability: round(combinedProbability, 4),
    expectedValue: round(expectedValue, 4),
    averageEdge: round(averageEdge, 4),
    averageIndependentEdge: round(averageIndependentEdge, 4),
    averageConfidence: round(averageConfidence, 4),
    averageSurvivalProbability: round(averageSurvivalProbability, 4),
    riskLegCount: legs.filter((leg) => ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag)).length,
    bttsLegCount,
    fragileLegCount,
    intelligenceConfidence: round(intelligenceConfidence, 4),
    averageNonMarketSignalCount: round(averageNonMarketSignalCount, 2),
    score: round(score, 2),
    displayRating: displayConfidenceRating(legs, { likely: true }),
    shortWindowFallback,
    uniqueFixtureCount,
    reusedSignalCount,
    correlationPenalty: round(correlation.penalty, 2),
    correlationReasons: correlation.reasons,
    marketFamilyMix: correlation.familyCounts,
    repeatedTeamCount: correlation.repeatedTeamCount,
    sameDateCluster: correlation.sameDateCluster,
    hardBlocks: [],
    thesis: buildMostLikelyThesis({ target, legs, combinedDecimalOdds, combinedProbability, averageSurvivalProbability, averageConfidence, averageIndependentEdge, averageNonMarketSignalCount, bttsLegCount, fragileLegCount, marketClusterScore: marketClusterPenalty(legs, target.legCount), correlation, shortWindowFallback, uniqueFixtureCount, reusedSignalCount })
  };
}

function buildMostLikelyThesis({ target, legs, combinedDecimalOdds, combinedProbability, averageSurvivalProbability, averageConfidence, averageIndependentEdge, averageNonMarketSignalCount, bttsLegCount, fragileLegCount, marketClusterScore, correlation, shortWindowFallback, uniqueFixtureCount, reusedSignalCount }) {
  const selections = legs.map((leg) => leg.selectionLabel).join(" | ");
  const fallbackText = shortWindowFallback
    ? ` Short-window fallback used ${uniqueFixtureCount} fixture(s) and ${legs.length} signal(s) so Picks of the Day stay populated. ${reusedSignalCount ? `${reusedSignalCount} strongest signal(s) were repeated.` : "Some same-game signals were included."}`
    : "";
  const heatLegs = legs.filter((leg) => Number(leg.components?.heatConfidence || 0) > 0.18 && Number(leg.components?.heatStress || 0) > 0.2);
  const heatText = heatLegs.length ? ` Heat layer active on ${heatLegs.length} leg(s) as a capped weather, climate-history, and squad-depth nudge.` : "";
  const lateGuardedLegs = legs.filter((leg) => lateKickoffGuard(leg, target.legCount).penalty > 0.004);
  const lateText = lateGuardedLegs.length ? ` Late-kickoff guard active on ${lateGuardedLegs.length} leg(s), trimming stale/drifting prices and fragile pre-match angles.` : "";
  const portfolioText = target.legCount >= 4
    ? ` Long-slip survival controls active: average leg survival ${round(averageSurvivalProbability * 100, 1)}%, estimated slip chance ${round(combinedProbability * 100, 2)}%, ${bttsLegCount} BTTS leg(s), ${fragileLegCount} fragile-value leg(s), market-mix pressure ${round(marketClusterScore, 1)}, correlation pressure ${round(correlation?.penalty || 0, 1)}.`
    : ` Estimated win chance ${round(combinedProbability * 100, 1)}%.`;
  const correlationText = correlation?.reasons?.length ? ` Correlation layer trimmed: ${correlation.reasons.join("; ")}.` : "";

  return `${target.label} chosen by the Pick of the Day engine, ignoring the risk slider and prioritising estimated win chance, data confidence, fixture separation, and only then price edge. Combined odds ${round(combinedDecimalOdds, 2)}, average data confidence ${round(averageConfidence * 100, 1)}%, independent edge ${round(averageIndependentEdge * 100, 2)}%, non-market signals ${round(averageNonMarketSignalCount, 1)} per leg.${portfolioText}${correlationText}${heatText}${lateText}${fallbackText} Legs: ${selections}.`;
}

function mostLikelyLegPassesPortfolioShape(leg, selected, legCount, mode) {
  if (legCount < 4) {
    return true;
  }

  const probability = likelyWinProbability(leg, { legCount });
  const decimalOdds = Number(leg.decimalOdds || 1);
  const bttsCount = selected.filter(isBttsYesLeg).length + (isBttsYesLeg(leg) ? 1 : 0);
  const fragileCount = selected.filter((item) => mostLikelyPortfolioPenalty(item, legCount) >= 0.035).length
    + (mostLikelyPortfolioPenalty(leg, legCount) >= 0.035 ? 1 : 0);
  const sameMarketCount = selected.filter((item) => item.market === leg.market).length + 1;
  const totalGoalsCount = selected.filter(isTotalGoalsLeg).length + (isTotalGoalsLeg(leg) ? 1 : 0);
  const correlation = portfolioCorrelationProfile([...selected, leg], { legCount, appetite: 0 });

  if (mode === "fallback") {
    return probability >= minimumSurvivalProbability(legCount) - 0.04
      && !(legCount >= 6 && fragileBttsHistory(leg))
      && correlation.penalty <= maximumPortfolioCorrelationPenalty(legCount, "balanced");
  }

  if (mode === "strict") {
    if (probability < minimumSurvivalProbability(legCount)) {
      return false;
    }
    if (decimalOdds > maximumSurvivalOdds(legCount)) {
      return false;
    }
    if (bttsCount > maximumBttsLegs(legCount)) {
      return false;
    }
    if (fragileCount > maximumFragileLegs(legCount)) {
      return false;
    }
    if (legCount >= 6 && fragileBttsHistory(leg)) {
      return false;
    }
    if (sameMarketCount > maximumSameMarketLegs(legCount, leg.market)) {
      return false;
    }
    if (totalGoalsCount > maximumTotalGoalsLegs(legCount)) {
      return false;
    }
    if (correlation.penalty > maximumPortfolioCorrelationPenalty(legCount, "strict")) {
      return false;
    }
  }

  if (mode === "balanced") {
    if (probability < minimumSurvivalProbability(legCount) - 0.035) {
      return false;
    }
    if (bttsCount > maximumBttsLegs(legCount) + 1) {
      return false;
    }
    if (fragileCount > maximumFragileLegs(legCount) + 1) {
      return false;
    }
    if (sameMarketCount > maximumSameMarketLegs(legCount, leg.market) + 1) {
      return false;
    }
    if (totalGoalsCount > maximumTotalGoalsLegs(legCount) + 1) {
      return false;
    }
    if (correlation.penalty > maximumPortfolioCorrelationPenalty(legCount, "balanced")) {
      return false;
    }
  }

  return true;
}

function mostLikelyPortfolioPenalty(leg, legCount) {
  const pressure = survivalPressureForLegCount(legCount);
  const latePenalty = lateKickoffGuard(leg, legCount).penalty;

  if (!pressure) {
    return latePenalty;
  }

  const decimalOdds = Number(leg.decimalOdds || 1);
  const expectedGoals = Number(leg.components?.expectedGoals || 0);
  const homeExpectedGoals = Number(leg.components?.homeExpectedGoals || 0);
  const awayExpectedGoals = Number(leg.components?.awayExpectedGoals || 0);
  const lowerExpectedGoals = Math.min(homeExpectedGoals || 99, awayExpectedGoals || 99);
  let penalty = 0;

  if (decimalOdds > 2.05) {
    penalty += Math.min(0.055, (decimalOdds - 2.05) * 0.09);
  }

  if (isBttsYesLeg(leg)) {
    const bttsHistory = mean([
      Number(leg.components?.homeBttsRate || 0.48),
      Number(leg.components?.awayBttsRate || 0.48)
    ]);
    const minBttsHistory = Math.min(
      Number(leg.components?.homeBttsRate || 0.48),
      Number(leg.components?.awayBttsRate || 0.48)
    );
    const overHistory = mean([
      Number(leg.components?.homeOver25Rate || 0.48),
      Number(leg.components?.awayOver25Rate || 0.48)
    ]);

    if (bttsHistory < 0.44) {
      penalty += (0.44 - bttsHistory) * 0.11;
    }
    if (minBttsHistory < 0.32) {
      penalty += (0.32 - minBttsHistory) * 0.22;
    }
    if (overHistory < 0.4) {
      penalty += (0.4 - overHistory) * 0.08;
    }
    if (lowerExpectedGoals < 0.9) {
      penalty += (0.9 - lowerExpectedGoals) * 0.08;
    }
    if (expectedGoals < 2.45) {
      penalty += (2.45 - expectedGoals) * 0.035;
    }
  }

  if (leg.market === "match_winner" && decimalOdds >= 3.2) {
    penalty += Math.min(0.06, (decimalOdds - 3.2) * 0.025);
  }

  if (isScorerLeg(leg)) {
    penalty += 0.035;
  }

  if (isOpeningGroupGoalLeg(leg) && legCount >= 4) {
    penalty += 0.018 + pressure * 0.026;
  }

  return clamp((penalty * pressure) + latePenalty, 0, 0.14);
}

function lateKickoffGuard(leg, legCount = 1) {
  const hoursUntilKickoff = hoursUntilFixture(leg);

  if (!Number.isFinite(hoursUntilKickoff) || hoursUntilKickoff < -0.5 || hoursUntilKickoff > 6) {
    return {
      active: false,
      hoursUntilKickoff: null,
      penalty: 0,
      reasons: []
    };
  }

  const pressure = clamp((6 - Math.max(0, hoursUntilKickoff)) / 6, 0, 1);
  const survivalPressure = survivalPressureForLegCount(legCount);
  const reasons = [];
  let penalty = 0;
  const oddsAgeHours = Number(leg.components?.oddsAgeHours || 0);
  const freshness = Number(leg.components?.oddsFreshness ?? 0.75);
  const confidence = Number(leg.confidence || 0);
  const independentEdge = Number(leg.independentEdge ?? leg.edge ?? 0);
  const expectedGoals = Number(leg.components?.expectedGoals || 0);

  if (oddsAgeHours > 2) {
    penalty += clamp((oddsAgeHours - 2) / 8, 0, 1) * 0.045;
    reasons.push("odds snapshot is ageing close to kick-off");
  }

  if (freshness < 0.78) {
    penalty += clamp((0.78 - freshness) / 0.5, 0, 1) * 0.035;
    reasons.push("freshness below late-match comfort level");
  }

  if (leg.components?.oddsDrifting) {
    penalty += 0.024;
    reasons.push("selection is drifting in the market");
  }

  if (confidence < 0.68 && legCount >= 3) {
    penalty += (0.68 - confidence) * 0.065;
    reasons.push("confidence is thin for a near-kick-off slip");
  }

  if (isOpeningGroupGoalLeg(leg) && (expectedGoals < 3.05 || independentEdge < 0.075)) {
    penalty += 0.028;
    reasons.push("opening-game goal angle needs extra proof");
  }

  if (isScorerLeg(leg)) {
    const starterLikelihood = Number(leg.components?.starterLikelihood || 0);

    if (starterLikelihood < 0.64) {
      penalty += 0.03;
      reasons.push("scorer leg lacks strong starter/minutes confidence");
    }

    if (leg.market === "first_goalscorer") {
      penalty += 0.014;
      reasons.push("first goalscorer remains fragile before confirmed lineups");
    }
  }

  const scaledPenalty = clamp(penalty * pressure * (0.55 + survivalPressure * 0.55), 0, 0.09);

  return {
    active: scaledPenalty > 0,
    hoursUntilKickoff: round(hoursUntilKickoff, 2),
    pressure: round(pressure, 3),
    penalty: round(scaledPenalty, 4),
    reasons: reasons.slice(0, 4)
  };
}

function hoursUntilFixture(leg) {
  const fixtureDate = new Date(leg.fixtureDate || leg.date || "");
  const referenceDate = new Date(leg.createdAt || leg.components?.createdAt || "");

  if (!Number.isFinite(fixtureDate.getTime()) || !Number.isFinite(referenceDate.getTime())) {
    return null;
  }

  return (fixtureDate - referenceDate) / 36e5;
}

function survivalPressureForLegCount(legCount) {
  return clamp((Number(legCount || 1) - 2) / 6, 0, 1);
}

function minimumSurvivalProbability(legCount) {
  if (legCount >= 8) {
    return 0.55;
  }
  if (legCount >= 6) {
    return 0.56;
  }
  if (legCount >= 4) {
    return 0.57;
  }
  return 0.5;
}

function maximumSurvivalOdds(legCount) {
  if (legCount >= 8) {
    return 2.28;
  }
  if (legCount >= 6) {
    return 2.35;
  }
  if (legCount >= 4) {
    return 2.45;
  }
  return 1000;
}

function maximumBttsLegs(legCount) {
  if (legCount >= 8) {
    return 3;
  }
  if (legCount >= 6) {
    return 3;
  }
  if (legCount >= 4) {
    return 2;
  }
  return legCount;
}

function maximumFragileLegs(legCount) {
  if (legCount >= 8) {
    return 2;
  }
  if (legCount >= 6) {
    return 2;
  }
  if (legCount >= 4) {
    return 1;
  }
  return legCount;
}

function bttsClusterPenalty(bttsLegCount, legCount) {
  if (legCount < 4) {
    return 0;
  }

  const allowed = maximumBttsLegs(legCount);
  const excess = Math.max(0, Number(bttsLegCount || 0) - allowed);
  const heavyCluster = Math.max(0, Number(bttsLegCount || 0) - Math.ceil(legCount * 0.7));
  const basePenalty = legCount >= 8 ? 7.5 : legCount >= 6 ? 6 : 4.5;

  return excess * basePenalty + heavyCluster * 3;
}

function marketClusterPenalty(legs, legCount) {
  if (legCount < 4) {
    return 0;
  }

  const marketCounts = new Map();
  let totalGoalsCount = 0;

  for (const leg of legs) {
    marketCounts.set(leg.market, (marketCounts.get(leg.market) || 0) + 1);
    if (isTotalGoalsLeg(leg)) {
      totalGoalsCount += 1;
    }
  }

  let penalty = 0;
  for (const [market, count] of marketCounts.entries()) {
    const excess = Math.max(0, count - maximumSameMarketLegs(legCount, market));
    penalty += excess * (legCount >= 8 ? 5.5 : 3.8);
  }

  penalty += Math.max(0, totalGoalsCount - maximumTotalGoalsLegs(legCount)) * (legCount >= 8 ? 4.5 : 3.2);
  return penalty;
}

function portfolioCorrelationProfile(legs, { legCount = legs.length, appetite = 0 } = {}) {
  if (legCount < 3) {
    return emptyCorrelationProfile();
  }

  const familyCounts = countBy(legs, marketFamilyForLeg);
  const teamCounts = countBy(legs.flatMap(teamsForLeg), (team) => team);
  const dateCounts = countBy(legs.map((leg) => fixtureDateKey(leg)).filter(Boolean), (date) => date);
  const heatLegCount = legs.filter((leg) => Number(leg.components?.heatStress || 0) >= 0.55 && Number(leg.components?.heatConfidence || 0) >= 0.3).length;
  const scorerCount = legs.filter(isScorerLeg).length;
  const openingGoalCount = legs.filter(isOpeningGroupGoalLeg).length;
  const reasons = [];
  let penalty = 0;

  for (const [family, count] of Object.entries(familyCounts)) {
    const allowed = maximumMarketFamilyLegs(legCount, family, appetite);
    const excess = Math.max(0, count - allowed);

    if (excess) {
      penalty += excess * (family === "goals" ? 4.7 : family === "scorer" ? 5.4 : 3.8);
      reasons.push(`${count} ${family} legs`);
    }
  }

  const repeatedTeamCount = Object.values(teamCounts).reduce((total, count) => total + Math.max(0, count - 1), 0);
  const teamRepeatAllowance = legCount >= 8 ? 1 + Math.floor(appetite * 3) : legCount >= 6 ? 1 + Math.floor(appetite * 2) : Math.floor(appetite * 1.5);
  const repeatedTeamExcess = Math.max(0, repeatedTeamCount - teamRepeatAllowance);

  if (repeatedTeamExcess) {
    penalty += repeatedTeamExcess * (legCount >= 8 ? 2.8 : 3.4);
    reasons.push(`${repeatedTeamCount} repeated team exposures`);
  }

  const sameDateCluster = Math.max(0, ...Object.values(dateCounts));
  const dateAllowance = legCount >= 8 ? 5 : legCount >= 6 ? 4 : 3;
  const dateExcess = Math.max(0, sameDateCluster - dateAllowance);

  if (dateExcess) {
    penalty += dateExcess * 1.9;
    reasons.push(`${sameDateCluster} legs on one matchday`);
  }

  const heatAllowance = legCount >= 8 ? 3 : legCount >= 6 ? 2 : 1;
  const heatExcess = Math.max(0, heatLegCount - heatAllowance);

  if (heatExcess) {
    penalty += heatExcess * 1.8;
    reasons.push(`${heatLegCount} heat-sensitive legs`);
  }

  const scorerAllowance = legCount >= 8 ? 2 : legCount >= 5 ? 1 : legCount;
  const scorerExcess = Math.max(0, scorerCount - scorerAllowance);

  if (scorerExcess) {
    penalty += scorerExcess * 4.2;
    reasons.push(`${scorerCount} scorer legs`);
  }

  const openingGoalAllowance = legCount >= 8 ? 2 + Math.floor(appetite * 1.5) : legCount >= 6 ? 2 : legCount >= 4 ? 1 : legCount;
  const openingGoalExcess = Math.max(0, openingGoalCount - openingGoalAllowance);

  if (openingGoalExcess) {
    penalty += openingGoalExcess * (legCount >= 8 ? 3.6 : 3.1);
    reasons.push(`${openingGoalCount} opening-game goal legs`);
  }

  const pressure = survivalPressureForLegCount(legCount);
  const appetiteRelief = 1 - clamp(appetite, 0, 1) * 0.3;
  const finalPenalty = penalty * (0.45 + pressure * 0.75) * appetiteRelief;

  return {
    penalty: round(finalPenalty, 3),
    reasons,
    familyCounts,
    repeatedTeamCount,
    sameDateCluster,
    heatLegCount,
    scorerCount,
    openingGoalCount
  };
}

function emptyCorrelationProfile() {
  return {
    penalty: 0,
    reasons: [],
    familyCounts: {},
    repeatedTeamCount: 0,
    sameDateCluster: 0,
    heatLegCount: 0,
    scorerCount: 0,
    openingGoalCount: 0
  };
}

function maximumPortfolioCorrelationPenalty(legCount, mode) {
  const strictBase = legCount >= 8 ? 7.2 : legCount >= 6 ? 6.4 : 5.2;
  return mode === "balanced" ? strictBase + 2.5 : strictBase;
}

function maximumMarketFamilyLegs(legCount, family, appetite = 0) {
  const relief = Math.floor(clamp(appetite, 0, 1) * 1.5);

  if (family === "goals") {
    if (legCount >= 8) {
      return 5 + relief;
    }
    if (legCount >= 6) {
      return 4 + relief;
    }
    return 3;
  }

  if (family === "scorer") {
    if (legCount >= 8) {
      return 2 + Math.floor(clamp(appetite, 0, 1));
    }
    if (legCount >= 5) {
      return 1 + Math.floor(clamp(appetite, 0, 1));
    }
    return legCount;
  }

  if (legCount >= 8) {
    return 5 + relief;
  }
  if (legCount >= 6) {
    return 4 + relief;
  }
  return 3;
}

function marketFamilyForLeg(leg) {
  if (isTotalGoalsLeg(leg) || leg.market === "both_teams_to_score") {
    return "goals";
  }

  if (isScorerLeg(leg)) {
    return "scorer";
  }

  if (leg.market === "match_winner" || leg.market === "draw_no_bet" || leg.market === "double_chance") {
    return "result";
  }

  return leg.market || "other";
}

function teamsForLeg(leg) {
  return [leg.homeTeam, leg.awayTeam]
    .map(normalizeFixtureName)
    .filter(Boolean);
}

function fixtureDateKey(leg) {
  const value = leg.fixtureDate || leg.date;

  if (!value) {
    return "";
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function countBy(items, keyFn) {
  const counts = {};

  for (const item of items) {
    const key = keyFn(item);

    if (!key) {
      continue;
    }

    counts[key] = (counts[key] || 0) + 1;
  }

  return counts;
}

function isBttsYesLeg(leg) {
  return leg.market === "both_teams_to_score" && String(leg.outcome || leg.selectionLabel || "").toLowerCase().includes("yes");
}

function isTotalGoalsLeg(leg) {
  return ["over_1_5_goals", "over_2_5_goals", "under_2_5_goals", "under_3_5_goals", "under_4_5_goals"].includes(leg.market);
}

function isScorerLeg(leg) {
  return leg.market === "anytime_scorer" || leg.market === "first_goalscorer";
}

function isOpeningGroupGoalLeg(leg) {
  return Boolean(leg.components?.bothOpeningGroupGame)
    && (leg.market === "over_2_5_goals" || isBttsYesLeg(leg));
}

function maximumSameMarketLegs(legCount, market) {
  if (legCount >= 8) {
    if (market === "both_teams_to_score") {
      return 3;
    }
    if (isTotalGoalsMarket(market)) {
      return 4;
    }
    return 5;
  }
  if (legCount >= 6) {
    return isTotalGoalsMarket(market) ? 3 : 4;
  }
  if (legCount >= 4) {
    return isTotalGoalsMarket(market) ? 2 : 3;
  }
  return legCount;
}

function maximumTotalGoalsLegs(legCount) {
  if (legCount >= 8) {
    return 4;
  }
  if (legCount >= 6) {
    return 3;
  }
  if (legCount >= 4) {
    return 2;
  }
  return legCount;
}

function isTotalGoalsMarket(market) {
  return ["over_1_5_goals", "over_2_5_goals", "under_2_5_goals", "under_3_5_goals", "under_4_5_goals"].includes(market);
}

function fragileBttsHistory(leg) {
  if (!isBttsYesLeg(leg)) {
    return false;
  }

  const minBttsHistory = Math.min(
    Number(leg.components?.homeBttsRate || 0.48),
    Number(leg.components?.awayBttsRate || 0.48)
  );
  const overHistory = mean([
    Number(leg.components?.homeOver25Rate || 0.48),
    Number(leg.components?.awayOver25Rate || 0.48)
  ]);

  return minBttsHistory < 0.3 || overHistory < 0.34;
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

function fixtureKeyForLeg(leg) {
  const home = normalizeFixtureName(leg.homeTeam);
  const away = normalizeFixtureName(leg.awayTeam);

  if (home && away) {
    return `${home}_vs_${away}`;
  }

  const labelFixture = String(leg.selectionLabel || "").split(":")[0].trim();
  if (labelFixture.toLowerCase().includes(" vs ")) {
    return normalizeFixtureName(labelFixture);
  }

  return leg.fixtureId || leg.id;
}

function normalizeFixtureName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, "_");
}

function rankCombos(combos, type, policy) {
  return combos
    .map((legs) => scoreCombo(legs, type, policy))
    .filter((combo) => combo && !combo.hardBlocks.length)
    .sort((left, right) => right.score - left.score);
}

export function scoreCombo(legs, type, policy) {
  const hardBlocks = [];
  const riskProfile = policy.riskProfile || {};
  const appetite = riskAppetiteFromPolicy(policy);
  const fixtureIds = new Set(legs.map(fixtureKeyForLeg));
  const combinedDecimalOdds = product(legs.map((leg) => leg.decimalOdds));
  const combinedProbability = product(legs.map((leg) => leg.modelProbability));
  const survivalProbabilities = legs.map((leg) => likelyWinProbability(leg, { legCount: legs.length }));
  const survivalCombinedProbability = product(survivalProbabilities);
  const averageSurvivalProbability = mean(survivalProbabilities);
  const expectedValue = combinedProbability * combinedDecimalOdds - 1;
  const averageEdge = mean(legs.map((leg) => leg.edge));
  const averageIndependentEdge = mean(legs.map((leg) => leg.independentEdge ?? leg.edge));
  const averageConfidence = mean(legs.map((leg) => leg.confidence));
  const riskLegs = legs.filter((leg) => ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag));
  const intelligenceConfidence = mean(legs.map((leg) => leg.components?.intelligenceConfidence || 0.45));
  const averageNonMarketSignalCount = mean(legs.map((leg) => leg.components?.nonMarketSignalCount || 0));
  const marketConfirmedLegs = legs.filter((leg) => leg.riskTag === "market_confirmed_edge");
  const contrarianLegs = legs.filter((leg) => leg.riskTag === "contrarian_value");
  const favouriteLegs = legs.filter((leg) => Number(leg.impliedProbability) >= Number(riskProfile.maxFavoriteImpliedProbability || 0.72));
  const bttsLegCount = legs.filter(isBttsYesLeg).length;
  const fragileLegCount = legs.filter((leg) => riskPortfolioLegPenalty(leg, legs.length, appetite) >= 0.025).length;
  const preferred = preferredOddsRange(type, legs.length, policy);
  const correlation = portfolioCorrelationProfile(legs, { legCount: legs.length, appetite });

  if (fixtureIds.size !== legs.length) {
    hardBlocks.push("same_fixture_correlation");
  }

  if (combinedDecimalOdds < preferred.min || combinedDecimalOdds > preferred.max) {
    hardBlocks.push("combined_odds_outside_policy_range");
  }

  if (combinedDecimalOdds > Number(riskProfile.maxCombinedOdds || 50)) {
    hardBlocks.push("combined_odds_above_absolute_cap");
  }

  if (type === "trixie" && riskLegs.length < Number(riskProfile.minRiskLegsForTrixie ?? 1)) {
    hardBlocks.push("trixie_missing_calculated_risk_leg");
  }

  if ((type === "trixie" || type === "accumulator") && favouriteLegs.length === legs.length) {
    hardBlocks.push("all_legs_are_high_implied_probability_favourites");
  }

  const oddsFit = oddsFitScore(combinedDecimalOdds, preferred.min, preferred.max);
  const diversityBonus = riskLegs.length > 0 ? Math.min(8, riskLegs.length * 3.5) : -5;
  const evidenceBonus = clamp((averageNonMarketSignalCount - 2) * 3.2, -4, 8);
  const intelligenceBonus = clamp((intelligenceConfidence - 0.5) * 10 + marketConfirmedLegs.length + contrarianLegs.length * 1.5, -5, 9);
  const survivalCombinedMultiplier = type === "single"
    ? 44
    : type === "double"
      ? 78
      : type === "trixie"
        ? 108
        : 150 + legs.length * 13;
  const survivalScore = survivalCombinedProbability * survivalCombinedMultiplier
    + averageSurvivalProbability * (22 + Math.min(legs.length, 8) * 2.5);
  const valueScore = averageEdge * 46
    + averageIndependentEdge * 58
    + Math.max(-8, Math.min(10, expectedValue * (5 + appetite * 6)))
    + oddsFit * 0.65;
  const survivalWeight = 1.08 - appetite * 0.42;
  const valueWeight = 0.72 + appetite * 0.54;
  const portfolioPenalty = riskPortfolioPenalty({ legs, type, appetite, bttsLegCount, fragileLegCount }) + correlation.penalty;
  const favouritePenalty = favouriteLegs.length * 4;
  const sizePenalty = type === "accumulator" ? Math.max(0, legs.length - 3) * 3 : 0;
  const score = clamp(22
    + survivalScore * survivalWeight
    + valueScore * valueWeight
    + averageConfidence * 16
    + diversityBonus
    + evidenceBonus
    + intelligenceBonus
    - favouritePenalty
    - sizePenalty
    - portfolioPenalty, 0, 100);

  return {
    id: `${type}_${legs.map((leg) => leg.id).join("_").slice(0, 48)}`,
    type,
    legCount: legs.length,
    legs: legs.map((leg) => ({
      id: leg.id,
      fixtureId: leg.fixtureId,
      fixtureDate: leg.fixtureDate,
      homeTeam: leg.homeTeam,
      awayTeam: leg.awayTeam,
      market: leg.market,
      playerName: leg.playerName,
      selectionLabel: leg.selectionLabel,
      bookmaker: leg.bookmaker,
      decimalOdds: leg.decimalOdds,
      modelProbability: leg.modelProbability,
      rawModelProbability: leg.rawModelProbability,
      impliedProbability: leg.impliedProbability,
      marketImpliedProbability: leg.marketImpliedProbability,
      independentEdge: leg.independentEdge,
      edge: leg.edge,
      confidence: leg.confidence,
      riskTag: leg.riskTag,
      components: {
        intelligenceConfidence: leg.components?.intelligenceConfidence,
        nonMarketSignalCount: leg.components?.nonMarketSignalCount,
        nonMarketSignals: leg.components?.nonMarketSignals,
        independentEvidenceStrength: leg.components?.independentEvidenceStrength,
        marketBlendLift: leg.components?.marketBlendLift,
        oddsMovement: leg.components?.oddsMovement,
        oddsShortening: leg.components?.oddsShortening,
        oddsDrifting: leg.components?.oddsDrifting,
        marketAverageOdds: leg.components?.marketAverageOdds,
        heatStress: leg.components?.heatStress,
        heatConfidence: leg.components?.heatConfidence,
        heatClimateBand: leg.components?.heatClimateBand,
        heatExpectedGoalsAdjustment: leg.components?.heatExpectedGoalsAdjustment,
        heatEdge: leg.components?.heatEdge,
        heatLocation: leg.components?.heatLocation,
        homeSquadDepth: leg.components?.homeSquadDepth,
        awaySquadDepth: leg.components?.awaySquadDepth,
        squadDepthConfidence: leg.components?.squadDepthConfidence,
        homeHistoricalHeatMemory: leg.components?.homeHistoricalHeatMemory,
        awayHistoricalHeatMemory: leg.components?.awayHistoricalHeatMemory,
        combinedHeatDifferential: leg.components?.combinedHeatDifferential,
        expectedGoals: leg.components?.expectedGoals,
        homeExpectedGoals: leg.components?.homeExpectedGoals,
        awayExpectedGoals: leg.components?.awayExpectedGoals,
        homeLongMatchCount: leg.components?.homeLongMatchCount,
        awayLongMatchCount: leg.components?.awayLongMatchCount,
        homeBttsRate: leg.components?.homeBttsRate,
        awayBttsRate: leg.components?.awayBttsRate,
        homeOver25Rate: leg.components?.homeOver25Rate,
        awayOver25Rate: leg.components?.awayOver25Rate,
        tournamentPhase: leg.components?.tournamentPhase,
        homeGroupGameNumber: leg.components?.homeGroupGameNumber,
        awayGroupGameNumber: leg.components?.awayGroupGameNumber,
        bothOpeningGroupGame: leg.components?.bothOpeningGroupGame,
        oneOpeningGroupGame: leg.components?.oneOpeningGroupGame,
        openingGameCaution: leg.components?.openingGameCaution,
        tournamentExpectedGoalsAdjustment: leg.components?.tournamentExpectedGoalsAdjustment,
        tournamentBttsAdjustment: leg.components?.tournamentBttsAdjustment,
        tournamentDrawLift: leg.components?.tournamentDrawLift,
        tournamentContextNote: leg.components?.tournamentContextNote,
        confidenceReasons: leg.components?.confidenceReasons,
        scorerMarketType: leg.components?.scorerMarketType,
        teamGoalLikelihood: leg.components?.teamGoalLikelihood,
        teamFirstGoalShare: leg.components?.teamFirstGoalShare,
        starterLikelihood: leg.components?.starterLikelihood,
        projectedMinutes: leg.components?.projectedMinutes,
        scorerGoalsPerTwentyTeamMatches: leg.components?.scorerGoalsPerTwentyTeamMatches,
        scorerConfidence: leg.components?.scorerConfidence,
        survivalPenalty: round(riskPortfolioLegPenalty(leg, legs.length, appetite), 4)
      },
      thesis: leg.thesis
    })),
    combinedDecimalOdds: round(combinedDecimalOdds, 2),
    combinedProbability: round(combinedProbability, 4),
    expectedValue: round(expectedValue, 4),
    averageEdge: round(averageEdge, 4),
    averageIndependentEdge: round(averageIndependentEdge, 4),
    averageConfidence: round(averageConfidence, 4),
    survivalCombinedProbability: round(survivalCombinedProbability, 4),
    averageSurvivalProbability: round(averageSurvivalProbability, 4),
    displayRating: displayConfidenceRating(legs),
    riskLegCount: riskLegs.length,
    bttsLegCount,
    fragileLegCount,
    intelligenceConfidence: round(intelligenceConfidence, 4),
    averageNonMarketSignalCount: round(averageNonMarketSignalCount, 2),
    marketConfirmedLegCount: marketConfirmedLegs.length,
    contrarianLegCount: contrarianLegs.length,
    favouriteLegCount: favouriteLegs.length,
    correlationPenalty: round(correlation.penalty, 2),
    correlationReasons: correlation.reasons,
    marketFamilyMix: correlation.familyCounts,
    repeatedTeamCount: correlation.repeatedTeamCount,
    sameDateCluster: correlation.sameDateCluster,
    score: round(score, 2),
    hardBlocks,
    thesis: buildComboThesis({ type, legs, combinedDecimalOdds, expectedValue, averageIndependentEdge, averageNonMarketSignalCount, riskLegs, favouriteLegs, survivalCombinedProbability, averageSurvivalProbability, bttsLegCount, fragileLegCount, correlation })
  };
}

function displayConfidenceRating(legs, { likely = false } = {}) {
  const legRatings = legs.map((leg) => displayLegRating(leg, { likely })).filter((value) => Number.isFinite(value));
  const averageLegRating = mean(legRatings);
  const confidence = mean(legs.map((leg) => leg.confidence));
  const edgeLift = clamp(mean(legs.map((leg) => leg.edge)), 0, 0.18) / 0.18;
  const rating = (averageLegRating * 0.74) + (confidence * 0.16) + (edgeLift * 0.1) + (likely ? 0.035 : 0);

  return round(clamp(rating, 0.58, likely ? 0.97 : 0.95), 4);
}

function displayLegRating(leg, { likely = false } = {}) {
  const probability = Number(likely ? (leg.likelyProbability || likelyWinProbability(leg)) : (leg.modelProbability || leg.likelyProbability || 0));
  const confidence = Number(leg.confidence || 0);
  const intelligence = Number(leg.components?.intelligenceConfidence || 0.5);
  const freshness = Number(leg.components?.oddsFreshness || 0.75);
  const edgeLift = clamp(Number(leg.edge || 0), 0, 0.18) / 0.18;
  const independentLift = clamp(Number(leg.independentEdge ?? leg.edge ?? 0), -0.03, 0.16) / 0.16;
  const evidenceLift = clamp(Number(leg.components?.nonMarketSignalCount || 0) / 4, 0, 1);
  const rawRating = (probability * 0.38) + (confidence * 0.23) + (intelligence * 0.13) + (freshness * 0.07) + (edgeLift * 0.08) + (independentLift * 0.06) + (evidenceLift * 0.05);
  const rating = 0.48 + (rawRating * 0.5) + (likely ? 0.025 : 0);

  return clamp(rating, 0.55, likely ? 0.97 : 0.95);
}

function riskAppetiteFromPolicy(policy) {
  const riskProfile = policy.riskProfile || {};
  const valueWeight = Number(riskProfile.valueHuntingWeight);
  const contrarianWeight = Number(riskProfile.contrarianWeight);

  if (Number.isFinite(valueWeight) && Number.isFinite(contrarianWeight)) {
    return clamp(((valueWeight - 0.14) / 0.34) * 0.55 + ((contrarianWeight - 0.02) / 0.38) * 0.45, 0, 1);
  }

  return clamp((Number(riskProfile.maxCombinedOdds || 38) - 38) / 560, 0, 1);
}

function riskPortfolioLegPenalty(leg, legCount, appetite) {
  const pressure = survivalPressureForLegCount(legCount);
  const decimalOdds = Number(leg.decimalOdds || 1);
  let penalty = mostLikelyPortfolioPenalty(leg, legCount) * (0.75 + pressure * 0.3);

  if (isScorerLeg(leg) && legCount >= 3) {
    penalty += (0.018 + pressure * 0.028) * (1 - appetite * 0.25);
  }

  if (isBttsYesLeg(leg) && fragileBttsHistory(leg)) {
    penalty += (0.018 + pressure * 0.032) * (1 - appetite * 0.35);
  }

  const longPriceLine = 2.5 + appetite * 1.2;
  if (legCount >= 4 && decimalOdds > longPriceLine) {
    penalty += Math.min(0.045, (decimalOdds - longPriceLine) * 0.03) * (1 - appetite * 0.3);
  }

  return clamp(penalty * (1 - appetite * 0.35), 0, 0.16);
}

function riskPortfolioPenalty({ legs, appetite, bttsLegCount, fragileLegCount }) {
  const legCount = legs.length;

  if (legCount < 3) {
    return 0;
  }

  const bttsAllowance = legCount >= 8
    ? 3 + Math.floor(appetite * 2)
    : legCount >= 6
      ? 3 + Math.floor(appetite * 2)
      : legCount >= 4
        ? 2 + Math.floor(appetite * 1.5)
        : legCount;
  const fragileAllowance = legCount >= 8
    ? 2 + Math.floor(appetite * 2)
    : legCount >= 4
      ? 1 + Math.floor(appetite * 2)
      : legCount;
  const bttsPenalty = Math.max(0, Number(bttsLegCount || 0) - bttsAllowance) * (legCount >= 8 ? 6 : 4) * (1 - appetite * 0.28);
  const fragilePenalty = Math.max(0, Number(fragileLegCount || 0) - fragileAllowance) * 5 * (1 - appetite * 0.3);
  const scorerCount = legs.filter(isScorerLeg).length;
  const scorerPenalty = legCount >= 4
    ? Math.max(0, scorerCount - (appetite > 0.7 ? 2 : 1)) * 5 * (1 - appetite * 0.2)
    : 0;
  const legPenalty = legs.reduce((total, leg) => total + riskPortfolioLegPenalty(leg, legCount, appetite), 0) * 38;
  const marketPenalty = riskMarketClusterPenalty(legs, appetite);

  return bttsPenalty + fragilePenalty + scorerPenalty + legPenalty + marketPenalty;
}

function riskMarketClusterPenalty(legs, appetite) {
  const legCount = legs.length;

  if (legCount < 4) {
    return 0;
  }

  const marketCounts = new Map();
  let totalGoalsCount = 0;

  for (const leg of legs) {
    marketCounts.set(leg.market, (marketCounts.get(leg.market) || 0) + 1);
    if (isTotalGoalsLeg(leg)) {
      totalGoalsCount += 1;
    }
  }

  const sameMarketAllowance = legCount >= 8
    ? 4 + Math.floor(appetite * 2)
    : legCount >= 6
      ? 3 + Math.floor(appetite * 2)
      : 2 + Math.floor(appetite * 1.5);
  const totalGoalsAllowance = legCount >= 8
    ? 4 + Math.floor(appetite * 2)
    : legCount >= 6
      ? 3 + Math.floor(appetite * 1.5)
      : 2 + Math.floor(appetite);
  let penalty = Math.max(0, totalGoalsCount - totalGoalsAllowance) * (4.5 - appetite * 1.6);

  for (const count of marketCounts.values()) {
    penalty += Math.max(0, count - sameMarketAllowance) * (4 - appetite * 1.4);
  }

  return penalty;
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

function buildComboThesis({ type, legs, combinedDecimalOdds, expectedValue, averageIndependentEdge, averageNonMarketSignalCount, riskLegs, favouriteLegs, survivalCombinedProbability, averageSurvivalProbability, bttsLegCount, fragileLegCount, correlation }) {
  const selections = legs.map((leg) => leg.selectionLabel).join(" | ");
  const riskText = riskLegs.length
    ? `${riskLegs.length} calculated-risk/value leg(s) stop this from being a favourite-only ${type}.`
    : `No calculated-risk leg; this should only survive if the edge is exceptional.`;
  const favouriteText = favouriteLegs.length ? `${favouriteLegs.length} high-implied-probability favourite leg(s).` : "No high-implied-probability favourite crowding.";
  const survivalText = `${type} at combined odds ${round(combinedDecimalOdds, 2)} with estimated slip chance ${round(survivalCombinedProbability * 100, 2)}% and average leg survival ${round(averageSurvivalProbability * 100, 1)}%.`;
  const clusterText = legs.length >= 4
    ? `Long-slip controls: ${bttsLegCount} BTTS leg(s), ${fragileLegCount} fragile-value leg(s), so edge cannot outrank survivability.`
    : "Short-slip controls keep model chance ahead of price hunting.";
  const correlationText = legs.length >= 3
    ? `Correlation control: ${correlation?.reasons?.length ? correlation.reasons.join("; ") : "market families and team repeats look acceptable"}.`
    : "";
  const heatLegs = legs.filter((leg) => Number(leg.components?.heatConfidence || 0) > 0.18 && Number(leg.components?.heatStress || 0) > 0.2);
  const heatText = heatLegs.length
    ? `Heat layer active on ${heatLegs.length} leg(s), capped as a small xG/result adjustment using weather, climate memory, and squad depth.`
    : "Heat layer neutral or low impact on this slip.";

  return `${survivalText} Expected value is ${round(expectedValue * 100, 2)}%, independent edge averages ${round(averageIndependentEdge * 100, 2)}%, and the model has ${round(averageNonMarketSignalCount, 1)} non-market signals per leg. ${clusterText} ${correlationText} ${riskText} ${favouriteText} ${heatText} Legs: ${selections}.`;
}
