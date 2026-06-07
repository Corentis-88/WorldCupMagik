import { clamp, daysBetween, decimalToImpliedProbability, hoursBetween, latestBy, logistic, makeId, mean, round } from "./utils.mjs";
import { buildOddsMovementSummaries, outcomeLearningAdjustment } from "./intelligence-memory.mjs";

export function buildLegCandidates({ fixtures, oddsSnapshots, newsArticles, teamStats, policy, now = new Date(), outcomeLearning = null }) {
  const statsByTeam = new Map(teamStats.map((team) => [team.team, team]));
  const latestOdds = bestLatestOddsByOutcome(oddsSnapshots);
  const oddsMovement = buildOddsMovementSummaries(oddsSnapshots);
  const newsByTeam = buildNewsByTeam(newsArticles, policy, now);
  const candidates = [];

  for (const fixture of fixtures) {
    const homeStats = statsByTeam.get(fixture.homeTeam);
    const awayStats = statsByTeam.get(fixture.awayTeam);

    if (!homeStats || !awayStats) {
      continue;
    }

    const model = fixtureModel({ fixture, homeStats, awayStats, newsByTeam });

    for (const market of policy.markets || []) {
      const probabilities = model.marketProbabilities[market];

      if (!probabilities) {
        continue;
      }

      for (const [outcome, modelProbability] of Object.entries(probabilities)) {
        const odds = latestOdds.get(outcomeKey(fixture.id, market, outcome));
        const movement = oddsMovement.get(outcomeKey(fixture.id, market, outcome));

        if (!odds) {
          continue;
        }

        const candidate = scoreLeg({
          fixture,
          market,
          outcome,
          modelProbability,
          odds,
          movement,
          model,
          policy,
          now,
          outcomeLearning
        });

        candidates.push(candidate);
      }
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

export function bestLatestOddsByOutcome(oddsSnapshots) {
  const latest = latestBy(oddsSnapshots, (record) => outcomeKey(record.fixtureId, record.market, record.outcome), "capturedAt");
  const best = new Map();

  for (const [key, latestRecord] of latest.entries()) {
    const sameMoment = oddsSnapshots.filter((record) => {
      return outcomeKey(record.fixtureId, record.market, record.outcome) === key
        && record.capturedAt === latestRecord.capturedAt;
    });
    const bestRecord = sameMoment.reduce((winner, record) => Number(record.decimalOdds) > Number(winner.decimalOdds) ? record : winner, latestRecord);
    best.set(key, bestRecord);
  }

  return best;
}

export function fixtureModel({ fixture, homeStats, awayStats, newsByTeam }) {
  const homeNews = newsByTeam.get(fixture.homeTeam) || neutralNews();
  const awayNews = newsByTeam.get(fixture.awayTeam) || neutralNews();
  const ratingEdge = Number(homeStats.rating || 1700) - Number(awayStats.rating || 1700);
  const formEdge = (Number(homeStats.recentPointsPerGame || 1.4) - Number(awayStats.recentPointsPerGame || 1.4)) * 42;
  const xgEdge = ((Number(homeStats.xgFor || 1.3) - Number(awayStats.xgAgainst || 1.2)) - (Number(awayStats.xgFor || 1.3) - Number(homeStats.xgAgainst || 1.2))) * 48;
  const styleEdge = styleMatchupEdge(homeStats, awayStats);
  const newsEdge = (homeNews.netImpact - awayNews.netImpact) * 95;
  const memoryEdge = (Number(homeStats.learnedEdge || 0) - Number(awayStats.learnedEdge || 0)) * 88;
  const marketMemoryEdge = (Number(homeStats.memoryOddsPressure || 0) - Number(awayStats.memoryOddsPressure || 0)) * 35;
  const totalEdge = ratingEdge + formEdge + xgEdge + styleEdge + newsEdge + memoryEdge + marketMemoryEdge;
  const drawProbability = clamp(0.265 - Math.abs(totalEdge) / 2500 + defensiveDrawLift(homeStats, awayStats), 0.17, 0.32);
  const homeShare = logistic(totalEdge / 210);
  const homeWin = clamp((1 - drawProbability) * homeShare, 0.05, 0.82);
  const awayWin = clamp((1 - drawProbability) * (1 - homeShare), 0.05, 0.82);
  const normalizedTotal = homeWin + awayWin + drawProbability;
  const expectedGoals = expectedGoalsForFixture(homeStats, awayStats, homeNews, awayNews);
  const over25 = clamp(logistic((expectedGoals - 2.55) * 1.2), 0.28, 0.72);
  const bttsYes = clamp(0.34 + expectedGoals * 0.12 + Math.min(Number(homeStats.xgFor || 1.4), Number(awayStats.xgFor || 1.4)) * 0.09 - defensiveQuality(homeStats, awayStats) * 0.07, 0.28, 0.72);

  return {
    fixtureId: fixture.id,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    components: {
      ratingEdge: round(ratingEdge, 2),
      formEdge: round(formEdge, 2),
      xgEdge: round(xgEdge, 2),
      styleEdge: round(styleEdge, 2),
      newsEdge: round(newsEdge, 2),
      memoryEdge: round(memoryEdge, 2),
      marketMemoryEdge: round(marketMemoryEdge, 2),
      expectedGoals: round(expectedGoals, 2),
      homeNewsImpact: round(homeNews.netImpact, 3),
      awayNewsImpact: round(awayNews.netImpact, 3),
      homeLearnedEdge: round(Number(homeStats.learnedEdge || 0), 4),
      awayLearnedEdge: round(Number(awayStats.learnedEdge || 0), 4),
      intelligenceConfidence: round(mean([
        homeStats.intelligenceConfidence || homeStats.statsCompleteness || 0.45,
        awayStats.intelligenceConfidence || awayStats.statsCompleteness || 0.45
      ]), 3),
      dataCompleteness: round(mean([
        homeStats.statsCompleteness,
        awayStats.statsCompleteness,
        homeNews.confidence,
        awayNews.confidence,
        homeStats.intelligenceConfidence,
        awayStats.intelligenceConfidence
      ]), 3)
    },
    marketProbabilities: {
      match_winner: {
        [fixture.homeTeam]: round(homeWin / normalizedTotal, 4),
        Draw: round(drawProbability / normalizedTotal, 4),
        [fixture.awayTeam]: round(awayWin / normalizedTotal, 4)
      },
      draw_no_bet: {
        [fixture.homeTeam]: round(homeWin / (homeWin + awayWin), 4),
        [fixture.awayTeam]: round(awayWin / (homeWin + awayWin), 4)
      },
      both_teams_to_score: {
        Yes: round(bttsYes, 4),
        No: round(1 - bttsYes, 4)
      },
      over_2_5_goals: {
        Over: round(over25, 4)
      },
      under_2_5_goals: {
        Under: round(1 - over25, 4)
      }
    }
  };
}

function scoreLeg({ fixture, market, outcome, modelProbability, odds, movement, model, policy, now, outcomeLearning }) {
  const impliedProbability = decimalToImpliedProbability(odds.decimalOdds);
  const marketImpliedProbability = movement?.marketImpliedProbability || impliedProbability;
  const priceEdge = modelProbability - impliedProbability;
  const marketEdge = modelProbability - marketImpliedProbability;
  const edge = priceEdge * 0.62 + marketEdge * 0.38;
  const oddsAgeHours = hoursBetween(odds.capturedAt, now);
  const oddsFreshness = clamp(1 - oddsAgeHours / (policy.sourceRequirements?.maxOddsAgeHours || 30), 0, 1);
  const dataCompleteness = model.components.dataCompleteness;
  const intelligenceConfidence = model.components.intelligenceConfidence;
  const bookmakerCoverage = movement?.bookmakerCount || 1;
  const marketConfirmation = movement?.shortening && edge > 0 ? 1 : 0;
  const contrarianValue = movement?.drifting && edge > 0 && Number(odds.decimalOdds) >= policy.riskProfile.minDecimalOddsForRiskLeg ? 1 : 0;
  const oddsDisagreement = Math.max(0, Number(movement?.bestOverAverage || 0));
  const preliminaryRiskTag = classifyRiskTag({ decimalOdds: odds.decimalOdds, impliedProbability, edge, modelProbability, movement, contrarianValue });
  const learning = outcomeLearningAdjustment({ market, riskTag: preliminaryRiskTag, outcomeLearning });
  const marketFocus = evaluateMarketFocus({ market, outcome, model, modelProbability, edge, odds, policy });
  const learnedModelProbability = clamp(modelProbability + learning.adjustment * learning.confidence, 0.03, 0.92);
  const learnedEdge = learnedModelProbability - impliedProbability;
  const confidence = clamp(
    (modelProbability * 0.45)
    + (dataCompleteness * 0.22)
    + (intelligenceConfidence * 0.12)
    + (oddsFreshness * 0.16)
    + Math.min(0.05, bookmakerCoverage * 0.012)
    + marketConfirmation * Number(policy.riskProfile.marketConfirmationWeight || 0.2),
    0,
    1
  );
  const favoriteCrowdingPenalty = impliedProbability > policy.riskProfile.maxFavoriteImpliedProbability ? (impliedProbability - policy.riskProfile.maxFavoriteImpliedProbability) * 42 : 0;
  const valueOddsBonus = Number(odds.decimalOdds) >= policy.riskProfile.minDecimalOddsForRiskLeg ? 6 : 0;
  const oddsMovementBonus = clamp(
    marketConfirmation * 5
    + contrarianValue * Number(policy.riskProfile.contrarianWeight || 0.1) * 18
    + oddsDisagreement * Number(policy.riskProfile.valueHuntingWeight || 0.2) * 40,
    -4,
    12
  );
  const intelligenceBonus = clamp((intelligenceConfidence - 0.5) * 14 + (dataCompleteness - 0.55) * 8, -8, 10);
  const marketFocusBonus = marketFocus.score;
  const edgeScore = (edge * 0.72 + learnedEdge * 0.28) * 185;
  const probabilityScore = learnedModelProbability * 36;
  const confidenceScore = confidence * 28;
  const score = clamp(43 + edgeScore + probabilityScore + confidenceScore + valueOddsBonus + oddsMovementBonus + intelligenceBonus + marketFocusBonus - favoriteCrowdingPenalty, 0, 100);
  const hardBlocks = [];

  if (edge < policy.riskProfile.minLegEdge) {
    hardBlocks.push("edge_below_policy_minimum");
  }

  if (confidence < policy.riskProfile.minLegConfidence) {
    hardBlocks.push("confidence_below_policy_minimum");
  }

  if (intelligenceConfidence < Number(policy.riskProfile.minIntelligenceConfidence || 0)) {
    hardBlocks.push("intelligence_memory_below_risk_profile_minimum");
  }

  if (bookmakerCoverage < Number(policy.riskProfile.minBookmakerCount || 1)) {
    hardBlocks.push("not_enough_bookie_coverage");
  }

  if (marketFocus.score < -6 && confidence < 0.76) {
    hardBlocks.push("market_does_not_match_evidence");
  }

  if (oddsAgeHours > (policy.sourceRequirements?.maxOddsAgeHours || 30)) {
    hardBlocks.push("odds_snapshot_stale");
  }

  return {
    id: makeId("leg", [fixture.id, market, outcome, odds.bookmaker, odds.capturedAt]),
    createdAt: now.toISOString(),
    fixtureId: fixture.id,
    fixtureDate: fixture.date,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    market,
    outcome,
    selectionLabel: selectionLabel({ fixture, market, outcome }),
    bookmaker: odds.bookmaker,
    decimalOdds: Number(odds.decimalOdds),
    modelProbability: round(modelProbability, 4),
    impliedProbability: round(impliedProbability, 4),
    marketImpliedProbability: round(marketImpliedProbability, 4),
    edge: round(edge, 4),
    priceEdge: round(priceEdge, 4),
    marketEdge: round(marketEdge, 4),
    confidence: round(confidence, 4),
    score: round(score, 2),
    riskTag: preliminaryRiskTag,
    hardBlocks,
    components: {
      ...model.components,
      oddsAgeHours: round(oddsAgeHours, 2),
      oddsFreshness: round(oddsFreshness, 3),
      bookmakerCoverage,
      marketAverageOdds: movement?.averageDecimalOdds || Number(odds.decimalOdds),
      oddsMovement: round(Number(movement?.movement || 0), 4),
      oddsShortening: movement?.shortening || false,
      oddsDrifting: movement?.drifting || false,
      bestOverAverage: round(oddsDisagreement, 4),
      intelligenceConfidence: round(intelligenceConfidence, 4),
      oddsMovementBonus: round(oddsMovementBonus, 2),
      intelligenceBonus: round(intelligenceBonus, 2),
      marketFocusBonus: round(marketFocusBonus, 2),
      marketFocusReasons: marketFocus.reasons,
      outcomeLearningAdjustment: learning.adjustment,
      outcomeLearningConfidence: learning.confidence,
      outcomeLearningReasons: learning.reasons,
      favoriteCrowdingPenalty: round(favoriteCrowdingPenalty, 2),
      valueOddsBonus
    },
    thesis: buildLegThesis({ fixture, market, outcome, edge, odds, movement, model, confidence, marketFocus, learning })
  };
}

function buildNewsByTeam(newsArticles, policy, now) {
  const maxAgeDays = policy.sourceRequirements?.maxNewsAgeDays || 10;
  const byTeam = new Map();

  for (const article of newsArticles) {
    if (daysBetween(article.publishedAt || article.createdAt, now) > maxAgeDays) {
      continue;
    }

    for (const team of article.teamTags || []) {
      const existing = byTeam.get(team) || [];
      existing.push(article);
      byTeam.set(team, existing);
    }
  }

  const aggregates = new Map();

  for (const [team, articles] of byTeam.entries()) {
    aggregates.set(team, aggregateNews(articles));
  }

  return aggregates;
}

function aggregateNews(articles) {
  const accepted = articles.filter((article) => article.acceptedSource !== false);
  const usable = accepted.length ? accepted : articles;
  const reliabilityWeighted = usable.reduce((total, article) => total + Number(article.sourceReliability || 0.5), 0) || 1;
  const weightedSentiment = usable.reduce((total, article) => total + Number(article.sentiment || 0) * Number(article.sourceReliability || 0.5), 0) / reliabilityWeighted;
  const injuryDrag = usable.reduce((total, article) => total + Number(article.signals?.injury || 0) * Number(article.sourceReliability || 0.5), 0) / reliabilityWeighted;
  const tacticalLift = usable.reduce((total, article) => total + Number(article.signals?.tacticalFit || 0.45) * Number(article.sourceReliability || 0.5), 0) / reliabilityWeighted;
  const lineupLift = usable.reduce((total, article) => total + Number(article.signals?.lineupClarity || 0.45) * Number(article.sourceReliability || 0.5), 0) / reliabilityWeighted;
  const rotationDrag = usable.reduce((total, article) => total + Number(article.signals?.rotationRisk || 0.2) * Number(article.sourceReliability || 0.5), 0) / reliabilityWeighted;
  const sourceDiversity = new Set(usable.map((article) => article.source || article.provider)).size;
  const confidence = clamp(0.38 + sourceDiversity * 0.11 + mean(usable.map((article) => article.sourceReliability || 0.5)) * 0.35, 0, 1);
  const netImpact = clamp(weightedSentiment * 0.5 + tacticalLift * 0.18 + lineupLift * 0.16 - injuryDrag * 0.3 - rotationDrag * 0.15, -0.6, 0.6);

  return {
    articleCount: usable.length,
    sourceDiversity,
    confidence,
    netImpact
  };
}

function neutralNews() {
  return {
    articleCount: 0,
    sourceDiversity: 0,
    confidence: 0.35,
    netImpact: 0
  };
}

function styleMatchupEdge(homeStats, awayStats) {
  const homePressVsAwayBuild = (Number(homeStats.highPressIndex || 55) - Number(awayStats.possession || 50)) * 0.6;
  const awayPressVsHomeBuild = (Number(awayStats.highPressIndex || 55) - Number(homeStats.possession || 50)) * 0.6;
  const setPieceEdge = (Number(homeStats.setPieceThreat || 55) - Number(awayStats.setPieceThreat || 55)) * 0.35;
  const transitionEdge = (Number(homeStats.transitionThreat || 55) - Number(awayStats.transitionThreat || 55)) * 0.32;
  const keeperEdge = (Number(homeStats.keeperForm || 55) - Number(awayStats.keeperForm || 55)) * 0.4;
  return homePressVsAwayBuild - awayPressVsHomeBuild + setPieceEdge + transitionEdge + keeperEdge;
}

function defensiveDrawLift(homeStats, awayStats) {
  const defensiveStrength = 2.3 - (Number(homeStats.xgAgainst || 1.2) + Number(awayStats.xgAgainst || 1.2));
  return clamp(defensiveStrength * 0.025, -0.025, 0.04);
}

function expectedGoalsForFixture(homeStats, awayStats, homeNews, awayNews) {
  const homeAttack = (Number(homeStats.xgFor || 1.35) + Number(awayStats.xgAgainst || 1.2)) / 2;
  const awayAttack = (Number(awayStats.xgFor || 1.35) + Number(homeStats.xgAgainst || 1.2)) / 2;
  const tacticalLift = (homeNews.netImpact + awayNews.netImpact) * 0.12;
  const injuryDrag = Number(homeStats.injuryBurden || 0) * 0.08 + Number(awayStats.injuryBurden || 0) * 0.08;
  return clamp(homeAttack + awayAttack + tacticalLift - injuryDrag, 1.45, 3.8);
}

function defensiveQuality(homeStats, awayStats) {
  return clamp((2.4 - (Number(homeStats.xgAgainst || 1.2) + Number(awayStats.xgAgainst || 1.2))) / 1.4, -0.5, 1);
}

function classifyRiskTag({ decimalOdds, impliedProbability, edge, modelProbability, movement, contrarianValue }) {
  if (contrarianValue) {
    return "contrarian_value";
  }

  if (decimalOdds >= 4 && edge > 0.045) {
    return "longshot_value";
  }

  if (decimalOdds >= 2.05 && edge > 0.025) {
    return "calculated_risk";
  }

  if (impliedProbability > 0.68 && edge > 0.025 && modelProbability > 0.72) {
    return "value_favourite";
  }

  if (movement?.shortening && edge > 0.02) {
    return "market_confirmed_edge";
  }

  return "steady_edge";
}

function buildLegThesis({ fixture, market, outcome, edge, odds, movement, model, confidence, marketFocus, learning }) {
  const movementText = movement?.previousAverageDecimalOdds
    ? `Market average moved from ${movement.previousAverageDecimalOdds} to ${movement.averageDecimalOdds}; best price is ${round(Number(movement.bestOverAverage || 0) * 100, 2)}% over average.`
    : `No prior market movement yet; this scan becomes part of the local memory.`;
  const notes = [
    `${selectionLabel({ fixture, market, outcome })} is priced at ${odds.decimalOdds} with model edge ${round(edge * 100, 2)}%.`,
    `Fixture model: expected goals ${model.components.expectedGoals}, rating edge ${model.components.ratingEdge}, style edge ${model.components.styleEdge}, memory edge ${model.components.memoryEdge}.`,
    `News impact is ${model.components.homeNewsImpact} for ${fixture.homeTeam} and ${model.components.awayNewsImpact} for ${fixture.awayTeam}.`,
    `Market focus: ${marketFocus.reasons.join("; ") || "general value check"}.`,
    learning.reasons.length ? `Outcome learning: ${learning.reasons.join("; ")}.` : "Outcome learning: waiting for enough settled bets before adjusting.",
    movementText,
    `Confidence ${round(confidence * 100, 1)}% after odds freshness and data completeness checks.`
  ];

  return notes.join(" ");
}

function selectionLabel({ fixture, market, outcome }) {
  const marketLabels = {
    match_winner: `${outcome} to win`,
    draw_no_bet: `${outcome} draw no bet`,
    both_teams_to_score: `Both teams to score: ${outcome}`,
    over_2_5_goals: `${outcome} 2.5 goals`,
    under_2_5_goals: `${outcome} 2.5 goals`
  };

  return `${fixture.homeTeam} vs ${fixture.awayTeam}: ${marketLabels[market] || `${market} ${outcome}`}`;
}

function outcomeKey(fixtureId, market, outcome) {
  return `${fixtureId}|${market}|${outcome}`;
}

function evaluateMarketFocus({ market, outcome, model, modelProbability, edge, odds, policy }) {
  const expectedGoals = Number(model.components.expectedGoals || 2.5);
  const styleEdge = Math.abs(Number(model.components.styleEdge || 0));
  const memoryEdge = Math.abs(Number(model.components.memoryEdge || 0));
  const dataCompleteness = Number(model.components.dataCompleteness || 0);
  const appetite = riskAppetite(policy);
  const reasons = [];
  let score = 0;

  if (market === "over_2_5_goals" || (market === "both_teams_to_score" && outcome === "Yes")) {
    if (expectedGoals >= 2.68) {
      score += 5;
      reasons.push(`goal model likes the game at ${expectedGoals} expected goals`);
    } else if (expectedGoals < 2.28) {
      score -= 8;
      reasons.push(`goal model is low at ${expectedGoals} expected goals`);
    }
  }

  if (market === "under_2_5_goals" || (market === "both_teams_to_score" && outcome === "No")) {
    if (expectedGoals <= 2.34) {
      score += 5;
      reasons.push(`goal model expects a tighter game at ${expectedGoals} expected goals`);
    } else if (expectedGoals > 2.75) {
      score -= 8;
      reasons.push(`goal model is too open for this angle at ${expectedGoals} expected goals`);
    }
  }

  if (market === "match_winner") {
    if (styleEdge >= 18 || memoryEdge >= 10) {
      score += 4;
      reasons.push("team/result market backed by style or memory edge");
    }

    if (Number(odds.decimalOdds) < 1.55 && appetite > 0.45) {
      score -= 7;
      reasons.push("short favourite price is not interesting for this risk profile");
    }
  }

  if (market === "draw_no_bet") {
    if (appetite < 0.45 && modelProbability >= 0.57) {
      score += 5;
      reasons.push("draw-no-bet suits lower risk and decent model probability");
    } else if (appetite > 0.7 && Number(odds.decimalOdds) < 1.45) {
      score -= 5;
      reasons.push("draw-no-bet is too conservative for bold mode at this price");
    }
  }

  if (edge > 0.055 && dataCompleteness >= 0.62) {
    score += 4;
    reasons.push("edge is strong enough to justify focus");
  }

  if (modelProbability < 0.38 && Number(odds.decimalOdds) < 2.2) {
    score -= 5;
    reasons.push("probability/price shape is not attractive");
  }

  return {
    score: clamp(score, -12, 12),
    reasons
  };
}

function riskAppetite(policy) {
  const maxCombinedOdds = Number(policy.riskProfile?.maxCombinedOdds || 45);
  return clamp((maxCombinedOdds - 22) / 58, 0, 1);
}
