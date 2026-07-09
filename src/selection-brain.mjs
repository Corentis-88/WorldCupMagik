import { clamp, mean, round } from "./utils.mjs";

export function selectionIntentForRisk(risk = 50) {
  const appetite = clamp(Number(risk || 0), 0, 100) / 100;

  if (appetite <= 0.2) {
    return "cash_survival";
  }

  if (appetite <= 0.64) {
    return "balanced_survival";
  }

  if (appetite <= 0.86) {
    return "free_bet_value";
  }

  return "logical_longshot";
}

export function selectionBrainFit(combo = {}, { risk = 50, category = {} } = {}) {
  return selectionBrainMetadata(combo, { risk, category }).selectionBrainScore;
}

export function selectionBrainMetadata(combo = {}, { risk = 50, category = {} } = {}) {
  const appetite = clamp(Number(risk || 0), 0, 100) / 100;
  const intent = selectionIntentForRisk(risk);
  const probabilityRange = probabilityRangeForCombo(combo, { risk, category });
  const survivalCombined = Number(combo.survivalCombinedProbability || combo.combinedProbability || 0);
  const averageSurvival = Number(combo.averageSurvivalProbability || combo.combinedProbability || 0);
  const confidence = Number(combo.averageConfidence || combo.legs?.[0]?.confidence || 0);
  const displayRating = Number(combo.displayRating || 0);
  const independentEdge = Number(combo.averageIndependentEdge ?? combo.averageEdge ?? combo.legs?.[0]?.independentEdge ?? combo.legs?.[0]?.edge ?? 0);
  const expectedValue = Number(combo.expectedValue || 0);
  const odds = Number(combo.combinedDecimalOdds || 1);
  const legCount = Number(combo.legCount || combo.legs?.length || category.legCount || 1);
  const uncertainty = Number(probabilityRange.width || 0);
  const warnings = portfolioWarnings(combo, { probabilityRange });
  const performanceSignals = comboPerformanceSignals(combo);
  const correlationPenalty = Number(combo.correlationPenalty || 0);
  const fragileLegCount = Number(combo.fragileLegCount || 0);
  const scorerLegCount = Number(combo.scorerLegCount || 0) + Number(combo.firstScorerLegCount || 0);
  const signalFit = clamp(Number(combo.averageNonMarketSignalCount || 0) / 6, 0, 1);
  const survivalGate = survivabilityGate({ averageSurvival, survivalCombined, legCount, appetite });
  const freeBetConversion = round(survivalCombined * Math.max(0, odds - 1), 4);
  const oddsBand = oddsBandFit(odds, freeBetOddsRange(category, legCount, appetite));
  const longOddsCashPenalty = Math.max(0, Math.log(Math.max(1.01, odds)) - (0.42 + legCount * 0.34 + appetite * 0.46)) * (9 - appetite * 4);

  const cashScore = clamp(
    survivalCombined * (108 - appetite * 22)
      + averageSurvival * (42 - appetite * 10)
      + confidence * 26
      + displayRating * 18
      + signalFit * 12
      + clamp(independentEdge, -0.03, 0.18) * 50
      - uncertainty * 86
      - performanceSignals.penalty * 0.75
      - correlationPenalty * 0.72
      - fragileLegCount * 4.5
      - scorerLegCount * (2.5 - appetite)
      - longOddsCashPenalty,
    0,
    100
  );

  const freeBetScore = clamp(
    survivalGate * (
      clamp(freeBetConversion / 1.55, 0, 1.35) * 34
        + averageSurvival * 24
        + confidence * 18
        + clamp(independentEdge, -0.02, 0.28) * 78
        + oddsBand * 22
        + clamp(expectedValue, -0.2, 1.6) * 9
        + signalFit * 10
    )
      - uncertainty * 58
      - performanceSignals.penalty * 0.5
      - correlationPenalty * 0.58
      - fragileLegCount * 3.8
      - Number(combo.repeatedTeamCount || 0) * 4.5,
    0,
    100
  );

  const longshotScore = clamp(
    survivalGate * (
      clamp(freeBetConversion / 2.15, 0, 1.35) * 30
        + averageSurvival * 19
        + confidence * 15
        + clamp(independentEdge, 0, 0.35) * 92
        + oddsBand * 18
        + clamp(expectedValue, 0, 2.4) * 12
        + signalFit * 8
    )
      - uncertainty * 54
      - performanceSignals.penalty * 0.38
      - correlationPenalty * 0.52
      - fragileLegCount * 3.3,
    0,
    100
  );

  const survivalWeight = clamp(1 - appetite * 0.7, 0.24, 1);
  const freeBetWeight = clamp((appetite - 0.42) / 0.44, 0, 1);
  const longshotWeight = clamp((appetite - 0.82) / 0.18, 0, 1);
  const selectionBrainScore = round(clamp(
    cashScore * survivalWeight
      + freeBetScore * freeBetWeight * (1 - longshotWeight * 0.35)
      + longshotScore * longshotWeight
      + cashScore * (1 - freeBetWeight) * appetite * 0.25,
    0,
    100
  ), 3);

  const selectionQuality = qualityLabel({
    score: selectionBrainScore,
    probabilityRange,
    confidence,
    averageSurvival,
    survivalCombined,
    warnings
  });

  return {
    selectionIntent: intent,
    recommendedUse: recommendedUse({ intent, cashScore, freeBetScore, longshotScore, selectionQuality }),
    selectionQuality,
    selectionBrainScore,
    cashScore: round(cashScore, 2),
    freeBetScore: round(freeBetScore, 2),
    longshotScore: round(longshotScore, 2),
    freeBetConversion,
    probabilityRange,
    portfolioWarnings: warnings
  };
}

export function probabilityRangeForCombo(combo = {}, { risk = 50, category = {} } = {}) {
  const appetite = clamp(Number(risk || 0), 0, 100) / 100;
  const mid = clamp(Number(combo.survivalCombinedProbability || combo.combinedProbability || 0), 0.01, 0.98);
  const legCount = Number(combo.legCount || combo.legs?.length || category.legCount || 1);
  const confidence = Number(combo.averageConfidence || mean((combo.legs || []).map((leg) => leg.confidence)) || 0.55);
  const signalCount = Number(combo.averageNonMarketSignalCount || mean((combo.legs || []).map((leg) => leg.components?.nonMarketSignalCount)) || 0);
  const correlationPenalty = Number(combo.correlationPenalty || 0);
  const scorerLegCount = Number(combo.scorerLegCount || 0) + Number(combo.firstScorerLegCount || 0);
  const fragileLegCount = Number(combo.fragileLegCount || 0);
  const performanceSignals = comboPerformanceSignals(combo);
  const fallbackPenalty = combo.shortWindowFallback ? 0.026 : 0;
  const signalPenalty = clamp((4 - signalCount) * 0.014, 0, 0.07);
  const confidencePenalty = clamp((0.82 - confidence) * 0.16, 0, 0.12);
  const legPenalty = Math.max(0, legCount - 1) * 0.006;
  const playerPenalty = scorerLegCount * 0.012;
  const fragilePenalty = fragileLegCount * 0.014;
  const correlationWidth = clamp(correlationPenalty / 520, 0, 0.12);
  const appetiteWidth = appetite > 0.8 ? (appetite - 0.8) * 0.035 : 0;
  const halfWidth = clamp(
    0.035
      + confidencePenalty
      + signalPenalty
      + legPenalty
      + playerPenalty
      + fragilePenalty
      + performanceSignals.widthPenalty
      + correlationWidth
      + fallbackPenalty
      + appetiteWidth,
    0.025,
    0.34
  );
  const low = round(clamp(mid - halfWidth, 0.005, 0.98), 4);
  const high = round(clamp(mid + halfWidth, 0.01, 0.995), 4);
  const width = round(high - low, 4);
  const label = width >= 0.3 ? "wide" : width >= 0.18 ? "normal" : "tight";
  const reasons = [];

  if (confidence < 0.68) {
    reasons.push("lower confidence inputs");
  }

  if (signalCount < 4) {
    reasons.push("thin non-market signal count");
  }

  if (correlationPenalty >= 12) {
    reasons.push("portfolio correlation pressure");
  }

  if (scorerLegCount > 0) {
    reasons.push("player-prop variance");
  }

  if (combo.shortWindowFallback) {
    reasons.push("short-window fallback");
  }

  if (performanceSignals.priceGoneCount > 0) {
    reasons.push("price-gone risk");
  }

  if (performanceSignals.weakMarketCount > 0) {
    reasons.push("weak settled market performance");
  }

  return { low, mid: round(mid, 4), high, width, label, reasons };
}

function survivabilityGate({ averageSurvival, survivalCombined, legCount, appetite }) {
  const floor = legCount <= 1
    ? 0.46 - appetite * 0.08
    : legCount <= 3
      ? 0.54 - appetite * 0.08
      : 0.58 - appetite * 0.08;
  const combinedFloor = legCount <= 1
    ? 0.38 - appetite * 0.06
    : legCount <= 3
      ? 0.18 - appetite * 0.035
      : 0.025 - appetite * 0.008;
  const averageGate = clamp((averageSurvival - floor) / 0.18, 0, 1);
  const combinedGate = clamp((survivalCombined - combinedFloor) / Math.max(0.02, combinedFloor * 0.9), 0, 1);

  return round((averageGate * 0.7) + (combinedGate * 0.3), 4);
}

function freeBetOddsRange(category = {}, legCount = 1, appetite = 0.5) {
  if (category.type === "single" || legCount <= 1) {
    return { min: 1.9 + appetite * 1.1, max: 6 + appetite * 5 };
  }

  if (legCount <= 3) {
    return { min: 4 + appetite * 4, max: 18 + appetite * 18 };
  }

  if (legCount <= 5) {
    return { min: 8 + appetite * 6, max: 38 + appetite * 32 };
  }

  return { min: 12 + appetite * 9, max: 75 + appetite * 75 };
}

function oddsBandFit(odds, range) {
  const value = Math.max(1.01, Number(odds || 1));
  const min = Math.max(1.01, Number(range.min || 1.01));
  const max = Math.max(min + 0.01, Number(range.max || min + 0.01));

  if (value >= min && value <= max) {
    return 1;
  }

  const target = value < min ? min : max;
  return clamp(1 - Math.abs(Math.log(value / target)) / 0.85, 0, 1);
}

function portfolioWarnings(combo = {}, { probabilityRange } = {}) {
  const warnings = [];
  const range = probabilityRange || probabilityRangeForCombo(combo);
  const performanceSignals = comboPerformanceSignals(combo);
  const averageConfidence = Number(combo.averageConfidence || 0);
  const averageSignals = Number(combo.averageNonMarketSignalCount || 0);
  const correlationPenalty = Number(combo.correlationPenalty || 0);
  const repeatedTeamCount = Number(combo.repeatedTeamCount || 0);
  const fragileLegCount = Number(combo.fragileLegCount || 0);
  const scorerLegCount = Number(combo.scorerLegCount || 0) + Number(combo.firstScorerLegCount || 0);
  const sameDateCluster = Number(combo.sameDateCluster || 0);
  const marketFamilies = Object.values(combo.marketFamilyMix || {});
  const biggestFamily = marketFamilies.length ? Math.max(...marketFamilies) : 0;
  const legCount = Number(combo.legCount || combo.legs?.length || 1);

  if (range.label === "wide") {
    warnings.push("wide_probability_range");
  }

  if (averageConfidence > 0 && averageConfidence < 0.64) {
    warnings.push("low_model_confidence");
  }

  if (averageSignals > 0 && averageSignals < 3) {
    warnings.push("thin_non_market_data");
  }

  if (correlationPenalty >= 16) {
    warnings.push("correlated_slip");
  }

  if (repeatedTeamCount > 0) {
    warnings.push("repeated_team_exposure");
  }

  if (sameDateCluster >= Math.max(3, Math.ceil(legCount * 0.7))) {
    warnings.push("same_date_cluster");
  }

  if (biggestFamily >= Math.max(3, Math.ceil(legCount * 0.72))) {
    warnings.push("one_market_family_heavy");
  }

  if (fragileLegCount > 0) {
    warnings.push("fragile_value_legs");
  }

  if (scorerLegCount >= 2) {
    warnings.push("player_prop_variance");
  }

  if (combo.shortWindowFallback) {
    warnings.push("short_window_fallback");
  }

  if (combo.fallbackCombinedOddsCap) {
    warnings.push("display_odds_capped");
  }

  if (performanceSignals.priceGoneCount > 0) {
    warnings.push("price_gone");
  }

  if (performanceSignals.suppressedMarketCount > 0) {
    warnings.push("market_suppressed_by_performance");
  } else if (performanceSignals.weakMarketCount > 0) {
    warnings.push("market_downgraded_by_performance");
  }

  return [...new Set(warnings)];
}

function comboPerformanceSignals(combo = {}) {
  const legs = combo.legs || [];
  const priceGoneCount = legs.filter((leg) => leg.components?.priceGone).length;
  const suppressedMarketCount = legs.filter((leg) => leg.components?.bettingPerformanceMarketAction === "suppress_for_cash").length;
  const downgradedMarketCount = legs.filter((leg) => leg.components?.bettingPerformanceMarketAction === "downgrade").length;
  const penalty = mean(legs.map((leg) => Number(leg.components?.bettingPerformanceScorePenalty || 0)));
  const confidence = mean(legs.map((leg) => Number(leg.components?.bettingPerformanceConfidence || 0)));
  const widthPenalty = clamp(
    priceGoneCount * 0.035
      + suppressedMarketCount * 0.028
      + downgradedMarketCount * 0.018
      + penalty / 420
      + confidence * (suppressedMarketCount || downgradedMarketCount ? 0.018 : 0),
    0,
    0.16
  );

  return {
    priceGoneCount,
    suppressedMarketCount,
    downgradedMarketCount,
    weakMarketCount: suppressedMarketCount + downgradedMarketCount,
    penalty,
    confidence,
    widthPenalty
  };
}

function qualityLabel({ score, probabilityRange, confidence, averageSurvival, survivalCombined, warnings }) {
  if (warnings.includes("price_gone") || warnings.includes("market_suppressed_by_performance")) {
    return score >= 58 && averageSurvival >= 0.56 ? "caution" : "weak_best_available";
  }

  if (score >= 76 && probabilityRange.label === "tight" && confidence >= 0.72 && averageSurvival >= 0.62) {
    return "strong";
  }

  if (score >= 62 && probabilityRange.label !== "wide" && confidence >= 0.64 && averageSurvival >= 0.55) {
    return "sound";
  }

  if (score < 38 || probabilityRange.label === "wide" || confidence < 0.55 || averageSurvival < 0.46 || survivalCombined < 0.012) {
    return "weak_best_available";
  }

  if (warnings.includes("correlated_slip") || warnings.includes("thin_non_market_data") || warnings.includes("market_downgraded_by_performance")) {
    return "caution";
  }

  return "caution";
}

function recommendedUse({ intent, cashScore, freeBetScore, longshotScore, selectionQuality }) {
  if (selectionQuality === "weak_best_available") {
    return "weak_best_available";
  }

  if (intent === "cash_survival") {
    return "cash";
  }

  if (intent === "logical_longshot" && longshotScore >= Math.max(cashScore, freeBetScore) - 4) {
    return "fun_longshot";
  }

  if ((intent === "free_bet_value" || intent === "logical_longshot") && freeBetScore >= cashScore - 2) {
    return "free_bet";
  }

  return "balanced";
}
