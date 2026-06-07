import { clamp, daysBetween, decimalToImpliedProbability, hoursBetween, latestBy, logistic, makeId, mean, normalizeName, round } from "./utils.mjs";
import { buildOddsMovementSummaries, outcomeLearningAdjustment } from "./intelligence-memory.mjs";
import { buildHeatImpact } from "./heat-model.mjs";

export function buildLegCandidates({ fixtures, oddsSnapshots, newsArticles, teamStats, policy, now = new Date(), outcomeLearning = null, heatSnapshots = [], squadDepthRecords = [], playerStats = [] }) {
  const statsByTeam = new Map(teamStats.map((team) => [normalizeName(team.team), team]));
  const latestOdds = bestLatestOddsByOutcome(oddsSnapshots);
  const latestOddsRecords = [...latestOdds.values()];
  const oddsMovement = buildOddsMovementSummaries(oddsSnapshots);
  const newsByTeam = buildNewsByTeam(newsArticles, policy, now);
  const heatByFixture = latestHeatByFixture(heatSnapshots);
  const squadDepthByTeam = latestSquadDepthByTeam(squadDepthRecords);
  const playerStatsByKey = latestPlayerStatsByKey(playerStats);
  const candidates = [];

  for (const fixture of fixtures) {
    const homeStats = statsByTeam.get(normalizeName(fixture.homeTeam));
    const awayStats = statsByTeam.get(normalizeName(fixture.awayTeam));

    if (!homeStats || !awayStats) {
      continue;
    }

    const model = fixtureModel({
      fixture,
      homeStats,
      awayStats,
      newsByTeam,
      marketSnapshot: fixtureMarketSnapshot({ fixture, latestOdds }),
      heatRecord: heatByFixture.get(fixture.id),
      homeSquadDepth: squadDepthByTeam.get(normalizeName(fixture.homeTeam)),
      awaySquadDepth: squadDepthByTeam.get(normalizeName(fixture.awayTeam))
    });

    for (const market of policy.markets || []) {
      const probabilities = model.marketProbabilities[market];

      if (!probabilities) {
        continue;
      }

      const rawProbabilities = model.rawMarketProbabilities?.[market] || probabilities;

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
          rawModelProbability: rawProbabilities[outcome],
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

    if ((policy.markets || []).includes("anytime_scorer")) {
      for (const odds of latestOddsRecords.filter((record) => record.fixtureId === fixture.id && record.market === "anytime_scorer")) {
        const scorerProbability = estimateAnytimeScorerProbability({ fixture, odds, homeStats, awayStats, model, playerStatsByKey });
        const movement = oddsMovement.get(outcomeKey(fixture.id, "anytime_scorer", odds.outcome));

        candidates.push(scoreLeg({
          fixture,
          market: "anytime_scorer",
          outcome: odds.outcome,
          modelProbability: scorerProbability.modelProbability,
          rawModelProbability: scorerProbability.rawModelProbability,
          odds,
          movement,
          model,
          policy,
          now,
          outcomeLearning
        }));
      }
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function estimateAnytimeScorerProbability({ fixture, odds, homeStats, awayStats, model, playerStatsByKey }) {
  const implied = decimalToImpliedProbability(odds.decimalOdds);
  const playerTeam = inferPlayerTeam(odds, fixture);
  const playerName = odds.playerName || odds.outcome;
  const playerRecord = playerStatsByKey.get(playerStatKey(playerTeam, playerName));
  const expectedGoals = Number(model.components.expectedGoals || 2.5);
  const homeAttack = (Number(homeStats.xgFor || 1.3) + Number(awayStats.xgAgainst || 1.2)) / 2;
  const awayAttack = (Number(awayStats.xgFor || 1.3) + Number(homeStats.xgAgainst || 1.2)) / 2;
  const teamAttack = playerTeam === fixture.homeTeam ? homeAttack : playerTeam === fixture.awayTeam ? awayAttack : mean([homeAttack, awayAttack]);
  const teamGoalLikelihood = clamp(0.32 + teamAttack * 0.18 + expectedGoals * 0.045, 0.28, 0.84);
  const roleLikelihood = clamp(0.2 + implied * 0.78, 0.16, 0.62);
  const scorerSampleRate = playerRecord
    ? Number(playerRecord.goals || 0) / Math.max(1, Number(playerRecord.matchesSampled || 0))
    : 0;
  const scorerLift = playerRecord
    ? clamp(scorerSampleRate * Number(playerRecord.scorerConfidence || 0.35) * 0.16, 0, 0.075)
    : 0;
  const rawRoleLikelihood = playerRecord
    ? clamp(0.11 + scorerSampleRate * 0.85 + teamAttack * 0.035 + expectedGoals * 0.012, 0.07, 0.46)
    : clamp(0.08 + teamAttack * 0.032 + expectedGoals * 0.01, 0.06, 0.2);
  const newsLift = playerTeam === fixture.homeTeam
    ? Number(model.components.homeNewsImpact || 0) * 0.035
    : playerTeam === fixture.awayTeam
      ? Number(model.components.awayNewsImpact || 0) * 0.035
      : 0;
  const rawModelProbability = clamp(teamGoalLikelihood * rawRoleLikelihood + scorerLift + newsLift, 0.035, 0.48);
  const marketAdjustedProbability = blendProbability(rawModelProbability, implied, playerRecord ? 0.28 : 0.42);

  return {
    rawModelProbability: round(rawModelProbability, 4),
    modelProbability: round(clamp((marketAdjustedProbability * 0.74) + (teamGoalLikelihood * roleLikelihood * 0.26), 0.04, 0.58), 4)
  };
}

function inferPlayerTeam(odds, fixture) {
  const explicit = odds.playerTeam || "";

  if (teamTextMatches(explicit, fixture.homeTeam)) {
    return fixture.homeTeam;
  }

  if (teamTextMatches(explicit, fixture.awayTeam)) {
    return fixture.awayTeam;
  }

  return "";
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

function latestHeatByFixture(heatSnapshots) {
  return latestBy(
    heatSnapshots.filter((record) => record?.fixtureId),
    (record) => record.fixtureId,
    "capturedAt"
  );
}

function latestSquadDepthByTeam(squadDepthRecords) {
  return latestBy(
    squadDepthRecords.filter((record) => record?.team),
    (record) => normalizeName(record.team),
    "capturedAt"
  );
}

function latestPlayerStatsByKey(playerStats) {
  return latestBy(
    playerStats.filter((record) => record?.team && record?.playerName),
    (record) => playerStatKey(record.team, record.playerName),
    "updatedAt"
  );
}

function fixtureMarketSnapshot({ fixture, latestOdds }) {
  const matchWinner = normalizeMatchWinnerMarket({
    home: latestOdds.get(outcomeKey(fixture.id, "match_winner", fixture.homeTeam)),
    draw: latestOdds.get(outcomeKey(fixture.id, "match_winner", "Draw")),
    away: latestOdds.get(outcomeKey(fixture.id, "match_winner", fixture.awayTeam))
  });
  const btts = normalizeTwoOutcomeMarket({
    yes: latestOdds.get(outcomeKey(fixture.id, "both_teams_to_score", "Yes")),
    no: latestOdds.get(outcomeKey(fixture.id, "both_teams_to_score", "No")),
    yesKey: "yes",
    noKey: "no"
  });
  const over25 = normalizeTwoOutcomeMarket({
    yes: latestOdds.get(outcomeKey(fixture.id, "over_2_5_goals", "Over")),
    no: latestOdds.get(outcomeKey(fixture.id, "under_2_5_goals", "Under")),
    yesKey: "over",
    noKey: "under"
  });

  return {
    matchWinner,
    btts,
    over25
  };
}

function normalizeMatchWinnerMarket({ home, draw, away }) {
  if (!home || !draw || !away) {
    return null;
  }

  const rawHome = decimalToImpliedProbability(home.decimalOdds);
  const rawDraw = decimalToImpliedProbability(draw.decimalOdds);
  const rawAway = decimalToImpliedProbability(away.decimalOdds);
  const total = rawHome + rawDraw + rawAway || 1;

  return {
    homeWin: round(rawHome / total, 4),
    draw: round(rawDraw / total, 4),
    awayWin: round(rawAway / total, 4),
    confidence: round(clamp(mean([home.sourceReliability, draw.sourceReliability, away.sourceReliability].map((value) => value ?? 0.72)), 0.4, 0.82), 4),
    bookmakerCount: new Set([home.bookmaker, draw.bookmaker, away.bookmaker].filter(Boolean)).size
  };
}

function normalizeTwoOutcomeMarket({ yes, no, yesKey, noKey }) {
  if (!yes || !no) {
    return null;
  }

  const rawYes = decimalToImpliedProbability(yes.decimalOdds);
  const rawNo = decimalToImpliedProbability(no.decimalOdds);
  const total = rawYes + rawNo || 1;

  return {
    [yesKey]: round(rawYes / total, 4),
    [noKey]: round(rawNo / total, 4),
    confidence: round(clamp(mean([yes.sourceReliability ?? 0.72, no.sourceReliability ?? 0.72]), 0.4, 0.82), 4),
    bookmakerCount: new Set([yes.bookmaker, no.bookmaker].filter(Boolean)).size
  };
}

export function fixtureModel({ fixture, homeStats, awayStats, newsByTeam, marketSnapshot = null, heatRecord = null, homeSquadDepth = null, awaySquadDepth = null }) {
  const homeNews = newsByTeam.get(fixture.homeTeam) || neutralNews();
  const awayNews = newsByTeam.get(fixture.awayTeam) || neutralNews();
  const heat = buildHeatImpact({ fixture, heatRecord, homeSquadDepth, awaySquadDepth });
  const ratingEdge = clamp(Number(homeStats.rating || 1700) - Number(awayStats.rating || 1700), -180, 180);
  const formEdge = clamp((Number(homeStats.recentPointsPerGame || 1.4) - Number(awayStats.recentPointsPerGame || 1.4)) * 42, -75, 75);
  const xgEdge = clamp(((Number(homeStats.xgFor || 1.3) - Number(awayStats.xgAgainst || 1.2)) - (Number(awayStats.xgFor || 1.3) - Number(homeStats.xgAgainst || 1.2))) * 48, -90, 90);
  const styleEdge = clamp(styleMatchupEdge(homeStats, awayStats), -65, 65);
  const newsEdge = clamp((homeNews.netImpact - awayNews.netImpact) * 95, -55, 55);
  const memoryEdge = clamp((Number(homeStats.learnedEdge || 0) - Number(awayStats.learnedEdge || 0)) * 88, -45, 45);
  const marketMemoryEdge = clamp((Number(homeStats.memoryOddsPressure || 0) - Number(awayStats.memoryOddsPressure || 0)) * 28, -22, 22);
  const marketResultEdge = marketSnapshot?.matchWinner
    ? clamp((Number(marketSnapshot.matchWinner.homeWin || 0.37) - Number(marketSnapshot.matchWinner.awayWin || 0.37)) * 74 * Number(marketSnapshot.matchWinner.confidence || 0.5), -50, 50)
    : 0;
  const heatEdge = Number(heat.resultEdgeAdjustment || 0);
  const independentResultEdge = clamp(ratingEdge + formEdge + xgEdge + styleEdge + newsEdge + memoryEdge + heatEdge, -220, 220);
  const totalEdge = clamp(independentResultEdge + marketMemoryEdge + marketResultEdge, -240, 240);
  const rawDrawProbability = clamp(0.265 - Math.abs(independentResultEdge) / 2500 + defensiveDrawLift(homeStats, awayStats) + Number(heat.drawLift || 0), 0.17, 0.33);
  const drawProbability = marketSnapshot?.matchWinner
    ? blendProbability(rawDrawProbability, marketSnapshot.matchWinner.draw, 0.14 * Number(marketSnapshot.matchWinner.confidence || 0.5))
    : rawDrawProbability;
  const rawHomeShare = logistic(independentResultEdge / 210);
  const homeShare = logistic(totalEdge / 210);
  const rawHomeWin = clamp((1 - rawDrawProbability) * rawHomeShare, 0.05, 0.82);
  const rawAwayWin = clamp((1 - rawDrawProbability) * (1 - rawHomeShare), 0.05, 0.82);
  const homeWin = clamp((1 - drawProbability) * homeShare, 0.05, 0.82);
  const awayWin = clamp((1 - drawProbability) * (1 - homeShare), 0.05, 0.82);
  const rawNormalizedTotal = rawHomeWin + rawAwayWin + rawDrawProbability;
  const normalizedTotal = homeWin + awayWin + drawProbability;
  const goalShape = goalShapeForFixture(homeStats, awayStats, homeNews, awayNews, heat);
  const expectedGoals = goalShape.expectedGoals;
  const rawOver25 = poissonOver25(expectedGoals);
  const rawBttsYes = poissonBothTeamsToScore(goalShape.homeExpectedGoals, goalShape.awayExpectedGoals, heat);
  const over25 = marketSnapshot?.over25
    ? blendProbability(rawOver25, marketSnapshot.over25.over, 0.14 * Number(marketSnapshot.over25.confidence || 0.5))
    : rawOver25;
  const bttsYes = marketSnapshot?.btts
    ? blendProbability(rawBttsYes, marketSnapshot.btts.yes, 0.15 * Number(marketSnapshot.btts.confidence || 0.5))
    : rawBttsYes;

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
      independentResultEdge: round(independentResultEdge, 2),
      marketMemoryEdge: round(marketMemoryEdge, 2),
      marketResultEdge: round(marketResultEdge, 2),
      marketConfidence: round(Number(marketSnapshot?.matchWinner?.confidence || 0), 4),
      marketHomeWinProbability: nullableComponent(marketSnapshot?.matchWinner?.homeWin),
      marketDrawProbability: nullableComponent(marketSnapshot?.matchWinner?.draw),
      marketAwayWinProbability: nullableComponent(marketSnapshot?.matchWinner?.awayWin),
      marketBttsYesProbability: nullableComponent(marketSnapshot?.btts?.yes),
      marketOver25Probability: nullableComponent(marketSnapshot?.over25?.over),
      heatEdge: round(heatEdge, 2),
      expectedGoals: round(expectedGoals, 2),
      homeExpectedGoals: round(goalShape.homeExpectedGoals, 2),
      awayExpectedGoals: round(goalShape.awayExpectedGoals, 2),
      bttsShapeProbability: round(bttsYes, 4),
      over25ShapeProbability: round(over25, 4),
      rawHomeWinProbability: round(rawHomeWin / rawNormalizedTotal, 4),
      rawDrawProbability: round(rawDrawProbability / rawNormalizedTotal, 4),
      rawAwayWinProbability: round(rawAwayWin / rawNormalizedTotal, 4),
      rawBttsShapeProbability: round(rawBttsYes, 4),
      rawOver25ShapeProbability: round(rawOver25, 4),
      homeLongMatchCount: Number(homeStats.longForm?.matchCount || homeStats.sourceMatchCount || 0),
      awayLongMatchCount: Number(awayStats.longForm?.matchCount || awayStats.sourceMatchCount || 0),
      homeBttsRate: nullableComponent(homeStats.marketAngles?.bttsRate || homeStats.longForm?.bttsRate),
      awayBttsRate: nullableComponent(awayStats.marketAngles?.bttsRate || awayStats.longForm?.bttsRate),
      homeOver25Rate: nullableComponent(homeStats.marketAngles?.over25Rate || homeStats.longForm?.over25Rate),
      awayOver25Rate: nullableComponent(awayStats.marketAngles?.over25Rate || awayStats.longForm?.over25Rate),
      homeCleanSheetRate: nullableComponent(homeStats.marketAngles?.cleanSheetRate || homeStats.longForm?.cleanSheetRate),
      awayCleanSheetRate: nullableComponent(awayStats.marketAngles?.cleanSheetRate || awayStats.longForm?.cleanSheetRate),
      homeNewsImpact: round(homeNews.netImpact, 3),
      awayNewsImpact: round(awayNews.netImpact, 3),
      heatStress: round(Number(heat.heatStress || 0), 4),
      heatConfidence: round(Number(heat.confidence || 0), 4),
      heatClimateBand: heat.climateBand || "",
      heatExpectedGoalsAdjustment: round(Number(heat.expectedGoalsAdjustment || 0), 3),
      heatBttsAdjustment: round(Number(heat.bttsAdjustment || 0), 4),
      heatLocation: heat.location || "",
      heatNotes: heat.notes || "",
      homeClimateAdaptation: nullableComponent(heat.homeClimateAdaptation),
      awayClimateAdaptation: nullableComponent(heat.awayClimateAdaptation),
      homeHistoricalHeatMemory: round(Number(heat.homeHistoricalHeatMemory || 0), 4),
      awayHistoricalHeatMemory: round(Number(heat.awayHistoricalHeatMemory || 0), 4),
      homeSquadDepth: nullableComponent(heat.homeSquadDepth),
      awaySquadDepth: nullableComponent(heat.awaySquadDepth),
      squadDepthConfidence: round(Number(heat.squadDepthConfidence || 0), 4),
      heatHistoryDifferential: round(Number(heat.historyDifferential || 0), 4),
      heatSquadDepthDifferential: round(Number(heat.squadDepthDifferential || 0), 4),
      combinedHeatDifferential: round(Number(heat.combinedHeatDifferential || 0), 4),
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
    rawMarketProbabilities: {
      match_winner: {
        [fixture.homeTeam]: round(rawHomeWin / rawNormalizedTotal, 4),
        Draw: round(rawDrawProbability / rawNormalizedTotal, 4),
        [fixture.awayTeam]: round(rawAwayWin / rawNormalizedTotal, 4)
      },
      draw_no_bet: {
        [fixture.homeTeam]: round(rawHomeWin / (rawHomeWin + rawAwayWin), 4),
        [fixture.awayTeam]: round(rawAwayWin / (rawHomeWin + rawAwayWin), 4)
      },
      both_teams_to_score: {
        Yes: round(rawBttsYes, 4),
        No: round(1 - rawBttsYes, 4)
      },
      over_2_5_goals: {
        Over: round(rawOver25, 4)
      },
      under_2_5_goals: {
        Under: round(1 - rawOver25, 4)
      }
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

function scoreLeg({ fixture, market, outcome, modelProbability, rawModelProbability, odds, movement, model, policy, now, outcomeLearning }) {
  const adjustedModelProbability = clamp(Number(modelProbability || 0), 0.03, 0.92);
  const independentModelProbability = clamp(Number(rawModelProbability ?? modelProbability ?? 0), 0.03, 0.92);
  const impliedProbability = decimalToImpliedProbability(odds.decimalOdds);
  const marketImpliedProbability = movement?.marketImpliedProbability || impliedProbability;
  const priceEdge = adjustedModelProbability - impliedProbability;
  const marketEdge = adjustedModelProbability - marketImpliedProbability;
  const independentEdge = independentModelProbability - marketImpliedProbability;
  const edge = independentEdge * 0.58 + priceEdge * 0.28 + marketEdge * 0.14;
  const marketBlendLift = adjustedModelProbability - independentModelProbability;
  const oddsAgeHours = hoursBetween(odds.capturedAt, now);
  const oddsFreshness = clamp(1 - oddsAgeHours / (policy.sourceRequirements?.maxOddsAgeHours || 30), 0, 1);
  const dataCompleteness = model.components.dataCompleteness;
  const intelligenceConfidence = model.components.intelligenceConfidence;
  const bookmakerCoverage = movement?.bookmakerCount || 1;
  const marketConfirmation = movement?.shortening && edge > 0 ? 1 : 0;
  const contrarianValue = movement?.drifting && edge > 0 && Number(odds.decimalOdds) >= policy.riskProfile.minDecimalOddsForRiskLeg ? 1 : 0;
  const oddsDisagreement = Math.max(0, Number(movement?.bestOverAverage || 0));
  const independentEvidence = evaluateIndependentEvidence({
    fixture,
    market,
    outcome,
    model,
    modelProbability: adjustedModelProbability,
    rawModelProbability: independentModelProbability,
    marketImpliedProbability,
    independentEdge
  });
  const preliminaryRiskTag = classifyRiskTag({
    decimalOdds: odds.decimalOdds,
    impliedProbability,
    edge,
    independentEdge,
    rawModelProbability: independentModelProbability,
    modelProbability: adjustedModelProbability,
    movement,
    contrarianValue
  });
  const learning = outcomeLearningAdjustment({ market, riskTag: preliminaryRiskTag, outcomeLearning });
  const marketFocus = evaluateMarketFocus({ market, outcome, model, modelProbability: adjustedModelProbability, edge, odds, policy });
  const learnedModelProbability = clamp(adjustedModelProbability + learning.adjustment * learning.confidence, 0.03, 0.92);
  const learnedIndependentProbability = clamp(independentModelProbability + learning.adjustment * learning.confidence * 0.55, 0.03, 0.92);
  const learnedEdge = learnedModelProbability - impliedProbability;
  const learnedIndependentEdge = learnedIndependentProbability - marketImpliedProbability;
  const evidenceConfidence = clamp(Number(independentEvidence.count || 0) / 4, 0, 1);
  const confidence = clamp(
    (independentModelProbability * 0.32)
    + (dataCompleteness * 0.22)
    + (intelligenceConfidence * 0.16)
    + (oddsFreshness * 0.12)
    + (evidenceConfidence * 0.12)
    + Math.min(0.04, bookmakerCoverage * 0.01)
    + marketConfirmation * Number(policy.riskProfile.marketConfirmationWeight || 0.2),
    0,
    1
  );
  const favoriteCrowdingPenalty = impliedProbability > policy.riskProfile.maxFavoriteImpliedProbability ? (impliedProbability - policy.riskProfile.maxFavoriteImpliedProbability) * 42 : 0;
  const valueOddsBonus = Number(odds.decimalOdds) >= policy.riskProfile.minDecimalOddsForRiskLeg ? 3.5 : 0;
  const oddsMovementBonus = clamp(
    marketConfirmation * 3
    + contrarianValue * Number(policy.riskProfile.contrarianWeight || 0.1) * 12
    + oddsDisagreement * Number(policy.riskProfile.valueHuntingWeight || 0.2) * 28,
    -4,
    8
  );
  const intelligenceBonus = clamp((intelligenceConfidence - 0.5) * 12 + (dataCompleteness - 0.55) * 7, -8, 9);
  const marketFocusBonus = marketFocus.score;
  const evidenceBonus = clamp(Number(independentEvidence.count || 0) * 2.1 + Number(independentEvidence.strength || 0) * 2.5, 0, 11);
  const marketBlendPenalty = clamp(Math.max(0, marketBlendLift - 0.04) * 55, 0, 9);
  const edgeScore = clamp(edge * 0.64 + learnedEdge * 0.18 + learnedIndependentEdge * 0.18, -0.05, 0.2) * 100;
  const independentEdgeScore = clamp(learnedIndependentEdge, -0.05, 0.16) * 92;
  const probabilityScore = learnedModelProbability * 23;
  const confidenceScore = confidence * 18;
  const rawScore = 28 + edgeScore + independentEdgeScore + probabilityScore + confidenceScore + evidenceBonus + valueOddsBonus + oddsMovementBonus + intelligenceBonus + marketFocusBonus - favoriteCrowdingPenalty - marketBlendPenalty;
  const score = clamp(compressTopScore(rawScore), 0, 100);
  const hardBlocks = [];

  if (edge < policy.riskProfile.minLegEdge) {
    hardBlocks.push("edge_below_policy_minimum");
  }

  if (independentEdge < Number(policy.riskProfile.minIndependentEdge ?? 0)) {
    hardBlocks.push("independent_edge_below_policy_minimum");
  }

  if (Number(independentEvidence.count || 0) < Number(policy.riskProfile.minNonMarketSignals || 2)) {
    hardBlocks.push("insufficient_non_market_evidence");
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

  if (market === "match_winner" && outcome === "Draw") {
    if (independentModelProbability < Number(policy.riskProfile.minDrawModelProbability || 0.22)) {
      hardBlocks.push("draw_probability_below_model_floor");
    }

    if (Math.abs(Number(model.components.independentResultEdge || 0)) > Number(policy.riskProfile.maxDrawIndependentResultEdge || 58)) {
      hardBlocks.push("draw_without_enough_balance");
    }
  }

  if (Number(odds.decimalOdds) >= 4 || preliminaryRiskTag === "longshot_value") {
    if (independentModelProbability < Number(policy.riskProfile.minLongshotModelProbability || 0.18)) {
      hardBlocks.push("longshot_probability_below_model_floor");
    }

    if (Number(independentEvidence.count || 0) < Number(policy.riskProfile.minLongshotSignals || 3)) {
      hardBlocks.push("longshot_without_enough_independent_signals");
    }

    if (
      market === "match_winner"
      && marketImpliedProbability < 0.18
      && independentEdge > 0.2
      && Math.abs(Number(model.components.independentResultEdge || 0)) < Number(policy.riskProfile.minLongshotResultEdgeForce || 48)
    ) {
      hardBlocks.push("longshot_market_disagreement_too_large");
    }
  }

  if (
    market === "match_winner"
    && outcome !== "Draw"
    && Number(odds.decimalOdds) > Number(policy.riskProfile.maxResultLongshotDecimalOdds || 16)
  ) {
    hardBlocks.push("result_longshot_above_risk_price_cap");
  }

  if (market === "both_teams_to_score" && outcome === "Yes") {
    const lowerTeamExpectedGoals = Math.min(Number(model.components.homeExpectedGoals || 0), Number(model.components.awayExpectedGoals || 0));

    if (independentModelProbability < Number(policy.riskProfile.minBttsYesRawProbability || 0.46)) {
      hardBlocks.push("btts_yes_raw_probability_below_floor");
    }

    if (lowerTeamExpectedGoals < Number(policy.riskProfile.minBttsLowerTeamExpectedGoals || 0.78)) {
      hardBlocks.push("btts_yes_one_team_goal_threat_too_low");
    }
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
    playerName: odds.playerName,
    playerTeam: odds.playerTeam,
    selectionLabel: selectionLabel({ fixture, market, outcome }),
    bookmaker: odds.bookmaker,
    decimalOdds: Number(odds.decimalOdds),
    modelProbability: round(adjustedModelProbability, 4),
    rawModelProbability: round(independentModelProbability, 4),
    impliedProbability: round(impliedProbability, 4),
    marketImpliedProbability: round(marketImpliedProbability, 4),
    independentEdge: round(independentEdge, 4),
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
      independentEdge: round(independentEdge, 4),
      marketBlendLift: round(marketBlendLift, 4),
      nonMarketSignalCount: independentEvidence.count,
      nonMarketSignals: independentEvidence.signals,
      independentEvidenceStrength: round(independentEvidence.strength, 4),
      intelligenceConfidence: round(intelligenceConfidence, 4),
      oddsMovementBonus: round(oddsMovementBonus, 2),
      intelligenceBonus: round(intelligenceBonus, 2),
      marketFocusBonus: round(marketFocusBonus, 2),
      evidenceBonus: round(evidenceBonus, 2),
      marketBlendPenalty: round(marketBlendPenalty, 2),
      marketFocusReasons: marketFocus.reasons,
      outcomeLearningAdjustment: learning.adjustment,
      outcomeLearningConfidence: learning.confidence,
      outcomeLearningReasons: learning.reasons,
      favoriteCrowdingPenalty: round(favoriteCrowdingPenalty, 2),
      valueOddsBonus
    },
    thesis: buildLegThesis({
      fixture,
      market,
      outcome,
      edge,
      independentEdge,
      rawModelProbability: independentModelProbability,
      modelProbability: adjustedModelProbability,
      marketImpliedProbability,
      odds,
      movement,
      model,
      confidence,
      independentEvidence,
      marketFocus,
      learning
    })
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

function goalShapeForFixture(homeStats, awayStats, homeNews, awayNews, heat) {
  const homeAttack = (Number(homeStats.xgFor || 1.35) + Number(awayStats.xgAgainst || 1.2)) / 2;
  const awayAttack = (Number(awayStats.xgFor || 1.35) + Number(homeStats.xgAgainst || 1.2)) / 2;
  const homeNewsLift = Number(homeNews.netImpact || 0) * 0.08;
  const awayNewsLift = Number(awayNews.netImpact || 0) * 0.08;
  const homeInjuryDrag = Number(homeStats.injuryBurden || 0) * 0.08;
  const awayInjuryDrag = Number(awayStats.injuryBurden || 0) * 0.08;
  const heatGoalDrag = Number(heat.expectedGoalsAdjustment || 0) / 2;
  const heatShareShift = Number(heat.goalShareAdjustment || 0);
  const homeExpectedGoals = clamp(homeAttack + homeNewsLift - homeInjuryDrag + heatGoalDrag + heatShareShift, 0.28, 2.95);
  const awayExpectedGoals = clamp(awayAttack + awayNewsLift - awayInjuryDrag + heatGoalDrag - heatShareShift, 0.28, 2.95);

  return {
    homeExpectedGoals,
    awayExpectedGoals,
    expectedGoals: clamp(homeExpectedGoals + awayExpectedGoals, 1.25, 4.1)
  };
}

function poissonOver25(expectedGoals) {
  const lambda = clamp(Number(expectedGoals || 2.4), 0.8, 4.2);
  const underOrEqualTwo = Math.exp(-lambda) * (1 + lambda + (lambda ** 2) / 2);
  return round(clamp(1 - underOrEqualTwo, 0.18, 0.82), 4);
}

function poissonBothTeamsToScore(homeExpectedGoals, awayExpectedGoals, heat) {
  const homeScores = 1 - Math.exp(-clamp(Number(homeExpectedGoals || 1.1), 0.05, 3.2));
  const awayScores = 1 - Math.exp(-clamp(Number(awayExpectedGoals || 1.1), 0.05, 3.2));
  const balancePenalty = clamp((Math.abs(homeExpectedGoals - awayExpectedGoals) - 0.75) * 0.035, 0, 0.045);
  const heatAdjustment = Number(heat.bttsAdjustment || 0);

  return round(clamp(homeScores * awayScores - balancePenalty + heatAdjustment, 0.16, 0.68), 4);
}

function compressTopScore(score) {
  const value = Number(score || 0);

  if (value <= 86) {
    return value;
  }

  return 86 + Math.sqrt(Math.max(0, value - 86)) * 2.5;
}

function evaluateIndependentEvidence({ fixture, market, outcome, model, rawModelProbability, marketImpliedProbability, independentEdge }) {
  const components = model.components || {};
  const signals = [];
  const strengths = [];
  const expectedGoals = Number(components.expectedGoals || 2.5);
  const homeExpectedGoals = Number(components.homeExpectedGoals || expectedGoals / 2);
  const awayExpectedGoals = Number(components.awayExpectedGoals || expectedGoals / 2);
  const lowerTeamExpectedGoals = Math.min(homeExpectedGoals, awayExpectedGoals);
  const independentResultEdge = Number(components.independentResultEdge || 0);
  const direction = outcome === fixture.homeTeam ? 1 : outcome === fixture.awayTeam ? -1 : 0;
  const directional = (value) => Number(value || 0) * direction;
  const add = (condition, label, strength = 0.55) => {
    if (!condition || signals.includes(label)) {
      return;
    }

    signals.push(label);
    strengths.push(clamp(strength, 0.1, 1));
  };

  add(independentEdge >= 0.012, "raw AI probability beats market", clamp(independentEdge / 0.08, 0.25, 1));
  add(Number(components.homeLongMatchCount || 0) >= 10 && Number(components.awayLongMatchCount || 0) >= 10, "20-match team sample", 0.62);

  if (market === "match_winner" || market === "draw_no_bet") {
    if (outcome === "Draw") {
      const cleanSheetProfile = mean([
        Number(components.homeCleanSheetRate || 0.28),
        Number(components.awayCleanSheetRate || 0.28)
      ]);

      add(Math.abs(independentResultEdge) <= 34, "balanced team-strength profile", 0.72);
      add(Math.abs(Number(components.formEdge || 0)) <= 20 && Math.abs(Number(components.xgEdge || 0)) <= 22, "form and xG are close", 0.58);
      add(expectedGoals <= 2.42, "tight expected-goals profile", 0.55);
      add(cleanSheetProfile >= 0.33, "clean-sheet history supports draw shape", 0.48);
    } else if (direction) {
      add(directional(components.ratingEdge) >= 32, "team rating edge", clamp(Math.abs(Number(components.ratingEdge || 0)) / 130, 0.3, 1));
      add(directional(components.formEdge) >= 12, "recent form edge", clamp(Math.abs(Number(components.formEdge || 0)) / 58, 0.25, 1));
      add(directional(components.xgEdge) >= 10, "xG attack-defense edge", clamp(Math.abs(Number(components.xgEdge || 0)) / 55, 0.25, 1));
      add(directional(components.styleEdge) >= 10, "style matchup edge", clamp(Math.abs(Number(components.styleEdge || 0)) / 45, 0.25, 1));
      add(directional(components.newsEdge) >= 8, "team news edge", clamp(Math.abs(Number(components.newsEdge || 0)) / 55, 0.22, 1));
      add(directional(components.memoryEdge) >= 7, "local intelligence memory edge", clamp(Math.abs(Number(components.memoryEdge || 0)) / 40, 0.22, 1));
      add(directional(components.heatEdge) >= 3, "heat and squad-depth edge", clamp(Math.abs(Number(components.heatEdge || 0)) / 20, 0.2, 0.8));
    }
  }

  if (market === "both_teams_to_score") {
    const bttsHistory = mean([
      Number(components.homeBttsRate || 0.48),
      Number(components.awayBttsRate || 0.48)
    ]);

    if (outcome === "Yes") {
      add(rawModelProbability >= 0.52, "raw BTTS model is positive", clamp((rawModelProbability - 0.45) / 0.18, 0.25, 1));
      add(homeExpectedGoals >= 0.85 && awayExpectedGoals >= 0.85, "both teams carry scoring threat", 0.72);
      add(expectedGoals >= 2.45, "goals environment supports BTTS", 0.58);
      add(bttsHistory >= 0.52, "20-match BTTS history", clamp((bttsHistory - 0.45) / 0.2, 0.2, 1));
      add(Number(components.heatStress || 0) < 0.72 || Number(components.heatConfidence || 0) < 0.35, "heat does not strongly suppress tempo", 0.35);
    } else {
      const cleanSheetHistory = mean([
        Number(components.homeCleanSheetRate || 0.28),
        Number(components.awayCleanSheetRate || 0.28)
      ]);

      add(rawModelProbability >= 0.52, "raw BTTS-no model is positive", clamp((rawModelProbability - 0.45) / 0.18, 0.25, 1));
      add(lowerTeamExpectedGoals <= 0.78, "one team goal threat is low", 0.7);
      add(cleanSheetHistory >= 0.34, "clean-sheet history supports BTTS-no", 0.55);
      add(expectedGoals <= 2.35, "tight goals environment", 0.5);
    }
  }

  if (market === "over_2_5_goals") {
    const overHistory = mean([
      Number(components.homeOver25Rate || 0.48),
      Number(components.awayOver25Rate || 0.48)
    ]);

    add(rawModelProbability >= 0.53, "raw over-2.5 model is positive", clamp((rawModelProbability - 0.45) / 0.2, 0.25, 1));
    add(expectedGoals >= 2.58, "expected-goals model is high", clamp((expectedGoals - 2.25) / 0.85, 0.25, 1));
    add(overHistory >= 0.52, "20-match over history", clamp((overHistory - 0.44) / 0.22, 0.2, 1));
    add(lowerTeamExpectedGoals >= 0.75, "second team adds goal pressure", 0.45);
  }

  if (market === "under_2_5_goals") {
    const overHistory = mean([
      Number(components.homeOver25Rate || 0.48),
      Number(components.awayOver25Rate || 0.48)
    ]);

    add(rawModelProbability >= 0.53, "raw under-2.5 model is positive", clamp((rawModelProbability - 0.45) / 0.2, 0.25, 1));
    add(expectedGoals <= 2.34, "expected-goals model is tight", clamp((2.58 - expectedGoals) / 0.78, 0.25, 1));
    add(overHistory <= 0.42, "20-match over history is modest", clamp((0.5 - overHistory) / 0.22, 0.2, 1));
    add(Number(components.heatExpectedGoalsAdjustment || 0) < -0.02, "heat layer trims goal tempo", 0.42);
  }

  if (market === "anytime_scorer") {
    add(independentEdge >= 0.01, "raw scorer probability beats market", clamp(independentEdge / 0.06, 0.25, 1));
    add(expectedGoals >= 2.55, "team goals environment is live", 0.5);
    add(rawModelProbability >= 0.18, "scorer raw probability clears floor", clamp((rawModelProbability - 0.12) / 0.22, 0.25, 1));
  }

  return {
    count: signals.length,
    signals,
    strength: signals.length ? mean(strengths) : 0
  };
}

function classifyRiskTag({ decimalOdds, impliedProbability, edge, independentEdge, rawModelProbability, modelProbability, movement, contrarianValue }) {
  if (contrarianValue) {
    return "contrarian_value";
  }

  if (decimalOdds >= 4 && edge > 0.04 && independentEdge > 0.018 && rawModelProbability >= 0.18) {
    return "longshot_value";
  }

  if (decimalOdds >= 2.05 && edge > 0.022 && independentEdge > 0) {
    return "calculated_risk";
  }

  if (decimalOdds >= 1.85 && edge > 0.032 && independentEdge > 0.02) {
    return "calculated_risk";
  }

  if (impliedProbability > 0.68 && edge > 0.025 && modelProbability > 0.72) {
    return "value_favourite";
  }

  if (movement?.shortening && edge > 0.02 && independentEdge > -0.005) {
    return "market_confirmed_edge";
  }

  return "steady_edge";
}

function buildLegThesis({ fixture, market, outcome, edge, independentEdge, rawModelProbability, modelProbability, marketImpliedProbability, odds, movement, model, confidence, independentEvidence, marketFocus, learning }) {
  const movementText = movement?.previousAverageDecimalOdds
    ? `Market average moved from ${movement.previousAverageDecimalOdds} to ${movement.averageDecimalOdds}; best price is ${round(Number(movement.bestOverAverage || 0) * 100, 2)}% over average.`
    : `No prior market movement yet; this scan becomes part of the local memory.`;
  const heatText = Number(model.components.heatConfidence || 0) > 0.18
    ? `Heat layer: ${model.components.heatLocation || "venue"} ${model.components.heatClimateBand || "weather"} stress ${round(Number(model.components.heatStress || 0) * 100, 1)}%, xG adjustment ${model.components.heatExpectedGoalsAdjustment}, result edge ${model.components.heatEdge}; climate/history/depth differential ${model.components.combinedHeatDifferential}.`
    : "";
  const notes = [
    `${selectionLabel({ fixture, market, outcome })} is priced at ${odds.decimalOdds}; raw AI probability ${round(rawModelProbability * 100, 1)}%, market-adjusted probability ${round(modelProbability * 100, 1)}%, market view ${round(marketImpliedProbability * 100, 1)}%.`,
    `Independent edge ${round(independentEdge * 100, 2)}%, final value edge ${round(edge * 100, 2)}%, backed by ${independentEvidence.count} non-market signal(s): ${independentEvidence.signals.join(", ") || "none yet"}.`,
    `Fixture model: expected goals ${model.components.expectedGoals} (${model.components.homeExpectedGoals}-${model.components.awayExpectedGoals}), rating edge ${model.components.ratingEdge}, style edge ${model.components.styleEdge}, memory edge ${model.components.memoryEdge}.`,
    `Odds intelligence is capped: market result edge ${model.components.marketResultEdge}, consensus probability ${model.components.marketHomeWinProbability ?? model.components.marketAwayWinProbability ?? "n/a"} where available.`,
    `News impact is ${model.components.homeNewsImpact} for ${fixture.homeTeam} and ${model.components.awayNewsImpact} for ${fixture.awayTeam}.`,
    heatText,
    `Market focus: ${marketFocus.reasons.join("; ") || "general value check"}.`,
    learning.reasons.length ? `Outcome learning: ${learning.reasons.join("; ")}.` : "Outcome learning: waiting for enough settled bets before adjusting.",
    movementText,
    `Confidence ${round(confidence * 100, 1)}% after odds freshness and data completeness checks.`
  ].filter(Boolean);

  return notes.join(" ");
}

function selectionLabel({ fixture, market, outcome }) {
  const marketLabels = {
    match_winner: `${outcome} to win`,
    draw_no_bet: `${outcome} draw no bet`,
    anytime_scorer: `${outcome} anytime scorer`,
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
  const homeExpectedGoals = Number(model.components.homeExpectedGoals || expectedGoals / 2);
  const awayExpectedGoals = Number(model.components.awayExpectedGoals || expectedGoals / 2);
  const lowerTeamExpectedGoals = Math.min(homeExpectedGoals, awayExpectedGoals);
  const styleEdge = Math.abs(Number(model.components.styleEdge || 0));
  const memoryEdge = Math.abs(Number(model.components.memoryEdge || 0));
  const dataCompleteness = Number(model.components.dataCompleteness || 0);
  const heatStress = Number(model.components.heatStress || 0);
  const heatConfidence = Number(model.components.heatConfidence || 0);
  const appetite = riskAppetite(policy);
  const reasons = [];
  let score = 0;

  if (market === "over_2_5_goals") {
    if (expectedGoals >= 2.68) {
      score += 5;
      reasons.push(`goal model likes the game at ${expectedGoals} expected goals`);
    } else if (expectedGoals < 2.28) {
      score -= 8;
      reasons.push(`goal model is low at ${expectedGoals} expected goals`);
    }
  }

  if (market === "both_teams_to_score" && outcome === "Yes") {
    const bttsHistory = mean([Number(model.components.homeBttsRate || 0.48), Number(model.components.awayBttsRate || 0.48)]);

    if (expectedGoals >= 2.55 && lowerTeamExpectedGoals >= 0.9) {
      score += 6;
      reasons.push(`BTTS shape is balanced at ${homeExpectedGoals.toFixed(2)}-${awayExpectedGoals.toFixed(2)} expected goals`);
    } else if (lowerTeamExpectedGoals < 0.72) {
      score -= 9;
      reasons.push(`BTTS shape is one-sided at ${homeExpectedGoals.toFixed(2)}-${awayExpectedGoals.toFixed(2)} expected goals`);
    } else if (expectedGoals < 2.25) {
      score -= 7;
      reasons.push(`BTTS total-goals base is low at ${expectedGoals} expected goals`);
    }

    if (bttsHistory >= 0.56) {
      score += 3;
      reasons.push(`20-match BTTS history is lively at ${round(bttsHistory * 100, 1)}%`);
    } else if (bttsHistory <= 0.36) {
      score -= 4;
      reasons.push(`20-match BTTS history is low at ${round(bttsHistory * 100, 1)}%`);
    }
  }

  if (market === "under_2_5_goals" || (market === "both_teams_to_score" && outcome === "No")) {
    const overHistory = mean([Number(model.components.homeOver25Rate || 0.48), Number(model.components.awayOver25Rate || 0.48)]);
    const cleanSheetHistory = mean([Number(model.components.homeCleanSheetRate || 0.28), Number(model.components.awayCleanSheetRate || 0.28)]);

    if (expectedGoals <= 2.34) {
      score += 5;
      reasons.push(`goal model expects a tighter game at ${expectedGoals} expected goals`);
    } else if (expectedGoals > 2.75) {
      score -= 8;
      reasons.push(`goal model is too open for this angle at ${expectedGoals} expected goals`);
    }

    if (market === "under_2_5_goals" && overHistory <= 0.42) {
      score += 3;
      reasons.push(`20-match over-2.5 history is modest at ${round(overHistory * 100, 1)}%`);
    }

    if (market === "both_teams_to_score" && outcome === "No" && cleanSheetHistory >= 0.36) {
      score += 3;
      reasons.push(`20-match clean-sheet signal is useful at ${round(cleanSheetHistory * 100, 1)}%`);
    }
  }

  if (market === "match_winner") {
    if (styleEdge >= 18 || memoryEdge >= 10) {
      score += 4;
      reasons.push("team/result market backed by style or memory edge");
    }

    if (heatStress >= 0.45 && heatConfidence >= 0.35 && Math.abs(Number(model.components.heatEdge || 0)) >= 4) {
      score += 2;
      reasons.push("heat layer gives a small adaptation edge");
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

  if (market === "anytime_scorer") {
    if (expectedGoals >= 2.65) {
      score += 4;
      reasons.push(`goals environment is live at ${expectedGoals} expected goals`);
    } else if (expectedGoals <= 2.15) {
      score -= 5;
      reasons.push(`goals environment is thin at ${expectedGoals} expected goals`);
    }

    if (Number(odds.decimalOdds) < 1.75 && appetite > 0.45) {
      score -= 5;
      reasons.push("anytime scorer price is too short for this risk setting");
    }

    if (Number(odds.decimalOdds) >= 3 && appetite >= 0.45 && modelProbability >= 0.2) {
      score += 3;
      reasons.push("scorer price gives the betslip a higher-upside angle");
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

function nullableComponent(value) {
  if (value == null || value === "") {
    return null;
  }

  return Number.isFinite(Number(value)) ? round(Number(value), 4) : null;
}

function teamTextMatches(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function playerStatKey(team, playerName) {
  return `${normalizeName(team)}|${normalizeName(playerName)}`;
}

function blendProbability(modelProbability, marketProbability, weight) {
  if (!Number.isFinite(Number(marketProbability))) {
    return modelProbability;
  }

  return round(clamp(Number(modelProbability || 0) * (1 - weight) + Number(marketProbability || 0) * weight, 0.03, 0.92), 4);
}
