import { appendJsonRecords, readJson, upsertJsonRecords, writeJson } from "./db.mjs";
import { buildPredictionReflectionLearning, predictionReflectionAdjustment } from "./prediction-reflection.mjs";
import { loadPostMatchStats, mergePostMatchStats } from "./post-match-stats.mjs";
import { clamp, decimalToImpliedProbability, makeId, mean, normalizeName, round } from "./utils.mjs";

const TEAM_NAME_ALIASES = {
  usa: ["united states", "united states men s"],
  "united states": ["usa", "united states men s"],
  "united states men s": ["usa", "united states"],
  czechia: ["czech republic"],
  "czech republic": ["czechia"],
  turkiye: ["turkey"],
  turkey: ["turkiye"],
  "dr congo": ["congo dr", "democratic republic of the congo"],
  "congo dr": ["dr congo", "democratic republic of the congo"],
  "ivory coast": ["cote d ivoire"],
  "cote d ivoire": ["ivory coast"],
  "south korea": ["korea republic", "republic of korea"],
  "korea republic": ["south korea"],
  "bosnia and herzegovina": ["bosnia"]
};

export async function loadIntelligenceState() {
  const [matchHistory, postMatchStats, teamIntelligence, observations] = await Promise.all([
    readJson(["data", "team-match-history.json"], []),
    loadPostMatchStats(),
    readJson(["data", "team-intelligence-latest.json"], []),
    readJson(["data", "intelligence-observations.json"], [])
  ]);

  return {
    matchHistory: mergePostMatchStats(matchHistory, postMatchStats),
    teamIntelligence,
    observations
  };
}

export async function loadOutcomeLearning() {
  const [outcomes, reflections] = await Promise.all([
    readJson(["data", "bet-outcomes.json"], []),
    readJson(["data", "prediction-reflections.json"], [])
  ]);
  return buildOutcomeLearning(outcomes, { reflections });
}

export function buildOutcomeLearning(outcomes = [], { reflections = [] } = {}) {
  const settled = outcomes.filter((outcome) => outcome.status === "won" || outcome.status === "lost");
  const byMarket = new Map();
  const byRiskTag = new Map();
  const byProbabilityBand = new Map();
  const calibrationByMarket = new Map();
  const calibrationByRiskTag = new Map();

  for (const outcome of settled) {
    const probability = outcomeProbability(outcome);
    incrementLearning(byMarket, outcome.market || outcome.type || "unknown", outcome.status);
    incrementCalibration(byProbabilityBand, probabilityBand(probability), outcome);
    incrementCalibration(calibrationByMarket, outcome.market || outcome.type || "unknown", outcome);

    for (const tag of outcome.riskTags || [outcome.riskTag].filter(Boolean)) {
      incrementLearning(byRiskTag, tag, outcome.status);
      incrementCalibration(calibrationByRiskTag, tag, outcome);
    }
  }

  return {
    outcomeCount: settled.length,
    market: Object.fromEntries([...byMarket.entries()].map(([key, value]) => [key, finalizeLearning(value)])),
    riskTag: Object.fromEntries([...byRiskTag.entries()].map(([key, value]) => [key, finalizeLearning(value)])),
    calibration: {
      overall: finalizeCalibration(buildCalibrationBucket(settled)),
      probabilityBand: Object.fromEntries([...byProbabilityBand.entries()].map(([key, value]) => [key, finalizeCalibration(value)])),
      market: Object.fromEntries([...calibrationByMarket.entries()].map(([key, value]) => [key, finalizeCalibration(value)])),
      riskTag: Object.fromEntries([...calibrationByRiskTag.entries()].map(([key, value]) => [key, finalizeCalibration(value)]))
    },
    reflection: buildPredictionReflectionLearning(reflections)
  };
}

export function outcomeLearningAdjustment({ market, riskTag, outcomeLearning, model = null }) {
  if (!outcomeLearning || outcomeLearning.outcomeCount < 8) {
    return {
      adjustment: 0,
      confidence: 0,
      reasons: [],
      outcomeAdjustment: 0,
      reflectionAdjustment: 0,
      reflectionConfidence: 0,
      reflectionReasons: []
    };
  }

  const marketLearning = outcomeLearning.market?.[market];
  const tagLearning = outcomeLearning.riskTag?.[riskTag];
  const marketCalibration = outcomeLearning.calibration?.market?.[market];
  const tagCalibration = outcomeLearning.calibration?.riskTag?.[riskTag];
  const marketAdjustment = marketLearning ? learningToAdjustment(marketLearning) : 0;
  const tagAdjustment = tagLearning ? learningToAdjustment(tagLearning) : 0;
  const calibrationAdjustment = calibrationToAdjustment(marketCalibration) * 0.62 + calibrationToAdjustment(tagCalibration) * 0.38;
  const baseAdjustment = clamp(marketAdjustment * 0.5 + tagAdjustment * 0.26 + calibrationAdjustment * 0.24, -0.08, 0.08);
  const baseConfidence = clamp(mean([
    marketLearning ? Math.min(1, marketLearning.count / 20) : 0,
    tagLearning ? Math.min(1, tagLearning.count / 20) : 0,
    marketCalibration ? Math.min(1, marketCalibration.count / 24) : 0,
    tagCalibration ? Math.min(1, tagCalibration.count / 24) : 0
  ]), 0, 1);
  const reflection = predictionReflectionAdjustment({ market, riskTag, model, outcomeLearning });
  const adjustment = clamp(baseAdjustment * 0.74 + Number(reflection.adjustment || 0) * 0.62, -0.09, 0.09);
  const confidence = clamp(Math.max(baseConfidence, Number(reflection.confidence || 0) * 0.86), 0, 1);
  const reasons = [];

  if (marketLearning) {
    reasons.push(`${market} historical strike ${round(marketLearning.winRate * 100, 1)}% over ${marketLearning.count}`);
  }

  if (tagLearning) {
    reasons.push(`${riskTag} historical strike ${round(tagLearning.winRate * 100, 1)}% over ${tagLearning.count}`);
  }

  if (marketCalibration && marketCalibration.count >= 6) {
    reasons.push(`${market} calibration ${round(marketCalibration.winRate * 100, 1)}% actual vs ${round(marketCalibration.averageModelProbability * 100, 1)}% projected`);
  }

  if (tagCalibration && tagCalibration.count >= 6) {
    reasons.push(`${riskTag} calibration ${round(tagCalibration.winRate * 100, 1)}% actual vs ${round(tagCalibration.averageModelProbability * 100, 1)}% projected`);
  }

  return {
    adjustment: round(adjustment, 4),
    confidence: round(confidence, 4),
    reasons,
    outcomeAdjustment: round(baseAdjustment, 4),
    reflectionAdjustment: round(Number(reflection.adjustment || 0), 4),
    reflectionConfidence: round(Number(reflection.confidence || 0), 4),
    reflectionReasons: reflection.reasons || []
  };
}

export function buildTeamStatsWithIntelligence({ baseStats, matchHistory = [], teamIntelligence = [], now = new Date() }) {
  const memoryByTeam = new Map(teamIntelligence.map((item) => [item.team, item]));

  return baseStats.map((team) => {
    const form = deriveTeamForm(matchHistory, team.team, now);
    const memory = memoryByTeam.get(team.team) || {};
    const formXgFor = form.matchCount ? form.xgFor : Number(team.xgFor || 1.35);
    const formXgAgainst = form.matchCount ? form.xgAgainst : Number(team.xgAgainst || 1.2);
    const formPossession = form.matchCount ? form.possession : Number(team.possession || 50);
    const formShotsFor = form.matchCount ? form.shotsFor : Number(team.shotsFor || 10);
    const formShotsAgainst = form.matchCount ? form.shotsAgainst : Number(team.shotsAgainst || 10);
    const formPassesAttempted = form.matchCount ? form.passesAttempted : Number(team.passesAttempted || 420);
    const formCompletedPasses = form.matchCount ? form.completedPasses : Number(team.completedPasses || 342);
    const formPassCompletion = form.matchCount ? form.passCompletion : Number(team.passCompletion || 0.815);
    const basePassesAttempted = team.passesAttempted || team.passing?.attempted || (form.matchCount ? formPassesAttempted : 420);
    const baseCompletedPasses = team.completedPasses || team.passing?.completed || (form.matchCount ? formCompletedPasses : 342);
    const basePassCompletion = team.passCompletion || team.passing?.completion || (form.matchCount ? formPassCompletion : 0.815);
    const memoryScore = Number(memory.learnedEdge || 0);
    const memoryConfidence = Number(memory.dataConfidence || 0);
    const longForm = form.longForm || form;
    const topScorers = form.topScorers?.length ? form.topScorers : team.topScorers || team.scorerSummary || [];
    const tacticalProfile = team.tacticalProfile || inferMemoryTacticalProfile({
      possession: formPossession,
      shotsFor: formShotsFor,
      shotsAgainst: formShotsAgainst,
      xgFor: formXgFor,
      xgAgainst: formXgAgainst,
      passCompletion: formPassCompletion
    });

    return {
      ...team,
      recentPointsPerGame: round(blend(Number(team.recentPointsPerGame || 1.4), form.pointsPerGame, form.matchCount ? 0.46 : 0), 3),
      xgFor: round(blend(Number(team.xgFor || 1.35), formXgFor, form.matchCount ? 0.34 : 0), 3),
      xgAgainst: round(blend(Number(team.xgAgainst || 1.2), formXgAgainst, form.matchCount ? 0.34 : 0), 3),
      shotsFor: round(blend(Number(team.shotsFor || 10), formShotsFor, form.matchCount ? 0.28 : 0), 2),
      shotsAgainst: round(blend(Number(team.shotsAgainst || 10), formShotsAgainst, form.matchCount ? 0.28 : 0), 2),
      possession: round(blend(Number(team.possession || 50), formPossession, form.matchCount ? 0.2 : 0), 1),
      passesAttempted: round(blend(Number(basePassesAttempted), formPassesAttempted, form.matchCount ? 0.24 : 0), 1),
      completedPasses: round(blend(Number(baseCompletedPasses), formCompletedPasses, form.matchCount ? 0.24 : 0), 1),
      passCompletion: round(blend(Number(basePassCompletion), formPassCompletion, form.matchCount ? 0.2 : 0), 3),
      rating: round(Number(team.rating || 1700) + form.formMomentum * 22 + memoryScore * 24, 1),
      statsCompleteness: round(clamp(mean([
        team.statsCompleteness || 0.5,
        form.matchCount ? 0.62 + Math.min(0.28, form.matchCount * 0.014) : 0.4,
        memoryConfidence || 0.42
      ]), 0, 1), 3),
      formMemory: form,
      longForm,
      topScorers,
      scorerSummary: topScorers,
      manager: team.manager || memory.manager || "",
      captain: team.captain || "",
      tacticalProfile,
      passing: {
        attempted: round(blend(Number(basePassesAttempted), formPassesAttempted, form.matchCount ? 0.24 : 0), 1),
        completed: round(blend(Number(baseCompletedPasses), formCompletedPasses, form.matchCount ? 0.24 : 0), 1),
        completion: round(blend(Number(basePassCompletion), formPassCompletion, form.matchCount ? 0.2 : 0), 3),
        source: team.passing?.source || "score-and-possession-derived estimate"
      },
      intelligenceCoverage: {
        ...(team.intelligenceCoverage || {}),
        matchWindowAvailable: form.matchCount || team.sourceMatchCount || 0,
        topScorerCount: topScorers.length,
        equalSchemaForAllTeams: true
      },
      learnedEdge: round(memoryScore, 4),
      intelligenceConfidence: round(memoryConfidence, 4),
      memoryNewsImpact: round(Number(memory.news?.impact || 0), 4),
      memoryOddsPressure: round(Number(memory.market?.pressure || 0), 4),
      memoryConsensusOdds: memory.market?.consensusOdds || null,
      memoryReasons: memory.reasons || []
    };
  });
}

export function buildScanIntelligence({ fixtures, oddsRecords, allOddsSnapshots, newsArticles, teamStats, matchHistory, playerStats = [], previousTeamIntelligence = [], now = new Date() }) {
  const teams = [...new Set(fixtures.flatMap((fixture) => [fixture.homeTeam, fixture.awayTeam]))];
  const previousByTeam = new Map(previousTeamIntelligence.map((item) => [item.team, item]));
  const newsByTeam = aggregateNewsByTeam(newsArticles, teams, now);
  const movementByOutcome = buildOddsMovementSummaries(allOddsSnapshots.length ? allOddsSnapshots : oddsRecords);
  const statsByTeam = new Map(teamStats.map((team) => [team.team, team]));
  const scorerByTeam = aggregateScorerIntelligence(playerStats);
  const observations = [];
  const teamIntelligence = [];

  for (const team of teams) {
    const form = deriveTeamForm(matchHistory, team, now);
    const news = newsByTeam.get(team) || neutralNews();
    const market = marketPressureForTeam({ team, fixtures, movementByOutcome });
    const scorer = scorerByTeam.get(normalizeName(team)) || neutralScorerIntelligence();
    const previous = previousByTeam.get(team);
    const previousEdge = Number(previous?.learnedEdge || 0);
    const stats = statsByTeam.get(team) || {};
    const topScorers = stats.topScorers || stats.scorerSummary || scorer.topScorers || [];
    const tacticalProfile = stats.tacticalProfile || inferMemoryTacticalProfile(stats);
    const learnedEdge = clamp(
      previousEdge * 0.48
      + form.formMomentum * 0.18
      + news.impact * 0.28
      + market.pressure * 0.24
      + scorer.threat * 0.08
      + (Number(stats.learnedEdge || 0) * 0.12),
      -0.65,
      0.65
    );
    const dataConfidence = clamp(mean([
      form.confidence,
      news.confidence,
      market.confidence,
      scorer.confidence,
      Number(stats.statsCompleteness || 0.5),
      previous?.dataConfidence || 0.42
    ]), 0, 1);
    const reasons = buildReasons({ form, news, market, scorer, learnedEdge });
    const item = {
      team,
      updatedAt: now.toISOString(),
      learnedEdge: round(learnedEdge, 4),
      dataConfidence: round(dataConfidence, 4),
      form,
      news,
      market,
      scorer,
      manager: stats.manager || previous?.manager || "",
      tacticalProfile,
      topScorers,
      passing: stats.passing || {
        attempted: stats.passesAttempted || form.passesAttempted || 420,
        completed: stats.completedPasses || form.completedPasses || 342,
        completion: stats.passCompletion || form.passCompletion || 0.815,
        source: "score-and-possession-derived estimate"
      },
      intelligenceCoverage: stats.intelligenceCoverage || {
        matchWindowTarget: 20,
        matchWindowAvailable: form.matchCount,
        topScorerCount: topScorers.length,
        equalSchemaForAllTeams: true
      },
      reasons
    };

    teamIntelligence.push(item);
    observations.push({
      id: makeId("intel_obs", [now.toISOString(), team, JSON.stringify(item)]),
      createdAt: now.toISOString(),
      team,
      learnedEdge: item.learnedEdge,
      dataConfidence: item.dataConfidence,
      articleCount: news.articleCount,
      oddsPressure: market.pressure,
      formMomentum: form.formMomentum,
      scorerThreat: scorer.threat,
      reasons
    });
  }

  return {
    createdAt: now.toISOString(),
    teamIntelligence,
    observations,
    marketMovements: [...movementByOutcome.values()]
  };
}

export async function persistScanIntelligence(intelligence) {
  await writeJson(["data", "team-intelligence-latest.json"], intelligence.teamIntelligence);
  await upsertJsonRecords(["data", "intelligence-observations.json"], intelligence.observations, (item) => item.id, 5000);
  await appendJsonRecords(["data", "team-intelligence-history.json"], [{
    id: makeId("intel_run", [intelligence.createdAt, intelligence.teamIntelligence.length]),
    createdAt: intelligence.createdAt,
    teamCount: intelligence.teamIntelligence.length,
    teams: intelligence.teamIntelligence
  }], 1000);
  await appendJsonRecords(["data", "market-movement-observations.json"], intelligence.marketMovements, 10000);
}

export function deriveTeamForm(matchHistory, team, now = new Date(), limit = 20) {
  const teamKeys = teamIdentityKeys(team);
  const matches = matchHistory
    .filter((match) => new Date(match.date) < now)
    .filter((match) => teamNameMatchesAny(match.homeTeam, teamKeys) || teamNameMatchesAny(match.awayTeam, teamKeys))
    .sort((left, right) => new Date(right.date) - new Date(left.date))
    .slice(0, limit);

  if (!matches.length) {
    return {
      matchCount: 0,
      pointsPerGame: 1.4,
      goalsFor: 1.2,
      goalsAgainst: 1.1,
      xgFor: 1.35,
      xgAgainst: 1.2,
      shotsFor: 10,
      shotsAgainst: 10,
      shotsOnTargetFor: 3.5,
      shotsOnTargetAgainst: 3.5,
      possession: 50,
      passesAttempted: 420,
      completedPasses: 342,
      passCompletion: 0.815,
      topScorers: [],
      formMomentum: 0,
      confidence: 0.35,
      marketAngles: {
        cleanSheetRate: 0.28,
        failedToScoreRate: 0.24,
        bttsRate: 0.48,
        over25Rate: 0.48
      }
    };
  }

  const rows = matches.map((match) => {
    const isHome = teamNameMatchesAny(match.homeTeam, teamKeys);
    const goalsFor = Number(isHome ? match.homeGoals : match.awayGoals);
    const goalsAgainst = Number(isHome ? match.awayGoals : match.homeGoals);
    const points = goalsFor > goalsAgainst ? 3 : goalsFor === goalsAgainst ? 1 : 0;

    return {
      points,
      goalsFor,
      goalsAgainst,
      xgFor: Number(isHome ? match.homeXg : match.awayXg),
      xgAgainst: Number(isHome ? match.awayXg : match.homeXg),
      shotsFor: Number(isHome ? match.homeShots : match.awayShots),
      shotsAgainst: Number(isHome ? match.awayShots : match.homeShots),
      shotsOnTargetFor: Number(isHome ? match.homeShotsOnTarget : match.awayShotsOnTarget),
      shotsOnTargetAgainst: Number(isHome ? match.awayShotsOnTarget : match.homeShotsOnTarget),
      possession: Number(isHome ? match.homePossession : match.awayPossession),
      passesAttempted: Number(isHome ? match.homePassesAttempted : match.awayPassesAttempted) || 420,
      completedPasses: Number(isHome ? match.homeCompletedPasses : match.awayCompletedPasses) || 342,
      passCompletion: Number(isHome ? match.homePassCompletion : match.awayPassCompletion) || 0.815,
      scorers: isHome ? match.homeScorers || [] : match.awayScorers || []
    };
  });
  const latestSix = rows.slice(0, 6);
  const priorSample = rows.slice(6, 20);
  const latestPpg = mean(latestSix.map((row) => row.points));
  const priorPpg = priorSample.length ? mean(priorSample.map((row) => row.points)) : mean(rows.map((row) => row.points));
  const latestXgDelta = mean(latestSix.map((row) => row.xgFor - row.xgAgainst));
  const priorXgDelta = priorSample.length ? mean(priorSample.map((row) => row.xgFor - row.xgAgainst)) : 0;
  const formMomentum = clamp(((latestPpg - priorPpg) / 3) + (latestXgDelta - priorXgDelta) * 0.1, -0.55, 0.55);
  const longForm = summarizeFormRows(rows);
  const shortForm = summarizeFormRows(latestSix);
  const topScorers = summarizeFormScorers(rows);

  return {
    matchCount: rows.length,
    pointsPerGame: longForm.pointsPerGame,
    goalsFor: longForm.goalsFor,
    goalsAgainst: longForm.goalsAgainst,
    xgFor: longForm.xgFor,
    xgAgainst: longForm.xgAgainst,
    shotsFor: longForm.shotsFor,
    shotsAgainst: longForm.shotsAgainst,
    shotsOnTargetFor: longForm.shotsOnTargetFor,
    shotsOnTargetAgainst: longForm.shotsOnTargetAgainst,
    possession: longForm.possession,
    passesAttempted: longForm.passesAttempted,
    completedPasses: longForm.completedPasses,
    passCompletion: longForm.passCompletion,
    topScorers,
    formMomentum: round(formMomentum, 4),
    confidence: round(clamp(0.4 + rows.length * 0.025, 0, 0.9), 3),
    shortForm: {
      ...shortForm,
      matchCount: latestSix.length
    },
    longForm,
    marketAngles: {
      cleanSheetRate: longForm.cleanSheetRate,
      failedToScoreRate: longForm.failedToScoreRate,
      bttsRate: longForm.bttsRate,
      over25Rate: longForm.over25Rate,
      scoringGameRate: longForm.scoringGameRate,
      concedeGameRate: longForm.concedeGameRate
    },
    recentMatches: rows.map((row) => ({
      points: row.points,
      goalsFor: row.goalsFor,
      goalsAgainst: row.goalsAgainst,
      xgFor: row.xgFor,
      xgAgainst: row.xgAgainst,
      shotsFor: row.shotsFor,
      shotsOnTargetFor: row.shotsOnTargetFor,
      possession: row.possession,
      passesAttempted: row.passesAttempted,
      completedPasses: row.completedPasses,
      passCompletion: row.passCompletion,
      scorers: row.scorers
    }))
  };
}

function teamIdentityKeys(team) {
  const key = normalizeName(team);
  const keys = new Set([key]);
  const aliases = TEAM_NAME_ALIASES[key] || [];

  for (const alias of aliases) {
    keys.add(normalizeName(alias));
  }

  return [...keys].filter(Boolean);
}

function teamNameMatchesAny(value, keys) {
  const normalized = normalizeName(value);

  if (!normalized) {
    return false;
  }

  return keys.some((key) => normalized === key || normalized.includes(key) || key.includes(normalized));
}

function summarizeFormRows(rows) {
  const safeRows = rows.length ? rows : [{
    points: 1.4,
    goalsFor: 1.2,
    goalsAgainst: 1.1,
    xgFor: 1.35,
    xgAgainst: 1.2,
    shotsFor: 10,
    shotsAgainst: 10,
    shotsOnTargetFor: 3.5,
    shotsOnTargetAgainst: 3.5,
    possession: 50,
    passesAttempted: 420,
    completedPasses: 342,
    passCompletion: 0.815
  }];

  return {
    matchCount: rows.length,
    pointsPerGame: round(mean(safeRows.map((row) => row.points)), 3),
    goalsFor: round(mean(safeRows.map((row) => row.goalsFor)), 3),
    goalsAgainst: round(mean(safeRows.map((row) => row.goalsAgainst)), 3),
    xgFor: round(mean(safeRows.map((row) => row.xgFor)), 3),
    xgAgainst: round(mean(safeRows.map((row) => row.xgAgainst)), 3),
    shotsFor: round(mean(safeRows.map((row) => row.shotsFor)), 2),
    shotsAgainst: round(mean(safeRows.map((row) => row.shotsAgainst)), 2),
    shotsOnTargetFor: round(mean(safeRows.map((row) => row.shotsOnTargetFor)), 2),
    shotsOnTargetAgainst: round(mean(safeRows.map((row) => row.shotsOnTargetAgainst)), 2),
    possession: round(mean(safeRows.map((row) => row.possession)), 1),
    passesAttempted: round(mean(safeRows.map((row) => row.passesAttempted)), 1),
    completedPasses: round(mean(safeRows.map((row) => row.completedPasses)), 1),
    passCompletion: round(mean(safeRows.map((row) => row.passCompletion)), 3),
    cleanSheetRate: round(safeRows.filter((row) => row.goalsAgainst === 0).length / safeRows.length, 3),
    failedToScoreRate: round(safeRows.filter((row) => row.goalsFor === 0).length / safeRows.length, 3),
    bttsRate: round(safeRows.filter((row) => row.goalsFor > 0 && row.goalsAgainst > 0).length / safeRows.length, 3),
    over25Rate: round(safeRows.filter((row) => row.goalsFor + row.goalsAgainst > 2.5).length / safeRows.length, 3),
    scoringGameRate: round(safeRows.filter((row) => row.goalsFor > 0).length / safeRows.length, 3),
    concedeGameRate: round(safeRows.filter((row) => row.goalsAgainst > 0).length / safeRows.length, 3)
  };
}

function summarizeFormScorers(rows) {
  const byPlayer = new Map();

  for (const row of rows) {
    for (const scorer of row.scorers || []) {
      const key = normalizeName(scorer.name);
      if (!key) {
        continue;
      }

      const existing = byPlayer.get(key) || { playerName: scorer.name, goals: 0, scoringMatches: 0 };
      existing.goals += Number(scorer.goals || 1);
      existing.scoringMatches += 1;
      byPlayer.set(key, existing);
    }
  }

  return [...byPlayer.values()]
    .sort((left, right) => Number(right.goals || 0) - Number(left.goals || 0) || normalizeName(left.playerName).localeCompare(normalizeName(right.playerName)))
    .slice(0, 8)
    .map((record) => ({
      playerName: record.playerName,
      goals: record.goals,
      scoringMatches: record.scoringMatches,
      goalsPerTwentyTeamMatches: round(record.goals / Math.max(1, rows.length) * 20, 3)
    }));
}

function inferMemoryTacticalProfile(stats = {}) {
  const possession = Number(stats.possession || 50);
  const shotsFor = Number(stats.shotsFor || 10);
  const shotsAgainst = Number(stats.shotsAgainst || 10);
  const xgFor = Number(stats.xgFor || 1.25);
  const xgAgainst = Number(stats.xgAgainst || 1.25);
  const passCompletion = Number(stats.passCompletion || stats.passing?.completion || 0.815);
  const chanceVolume = shotsFor - shotsAgainst;
  const xgBalance = xgFor - xgAgainst;
  const tags = [];
  let likelyFormation = "4-2-3-1 / 4-3-3";
  let styleOfPlay = "balanced mid-block with mixed build-up";

  if (possession >= 57 && passCompletion >= 0.82) {
    likelyFormation = "4-3-3 / 4-2-3-1";
    styleOfPlay = "possession-led build-up with high territory";
    tags.push("possession", "territory", "patient build-up");
  } else if (possession <= 47 && xgBalance >= 0) {
    likelyFormation = "4-4-2 / 4-2-3-1";
    styleOfPlay = "direct transition and counter-attacking";
    tags.push("transition", "direct", "counter");
  } else if (chanceVolume >= 2) {
    likelyFormation = "4-3-3 / 4-2-3-1";
    styleOfPlay = "front-foot pressing and fast regains";
    tags.push("pressing", "front-foot", "regains");
  } else if (xgAgainst <= 1.05 && possession < 52) {
    likelyFormation = "5-4-1 / 4-4-2";
    styleOfPlay = "compact defensive block with selective counters";
    tags.push("compact", "defensive", "counter");
  } else {
    tags.push("balanced", "mixed build-up");
  }

  if (xgBalance >= 0.35) {
    tags.push("positive xG balance");
  }

  return {
    likelyFormation,
    styleOfPlay,
    styleTags: [...new Set(tags)].slice(0, 6),
    possessionTier: possession >= 57 ? "high" : possession <= 47 ? "low" : "medium",
    pressingTier: chanceVolume >= 2 ? "high" : chanceVolume <= -2 ? "low" : "medium",
    transitionTier: possession <= 47 && xgBalance >= 0 ? "high" : "medium",
    source: "derived from 20-match public result sample and score-derived event estimates"
  };
}

export function buildOddsMovementSummaries(oddsSnapshots) {
  const grouped = new Map();

  for (const record of oddsSnapshots) {
    const key = outcomeKey(record.fixtureId, record.market, record.outcome);
    const existing = grouped.get(key) || [];
    existing.push(record);
    grouped.set(key, existing);
  }

  const summaries = new Map();

  for (const [key, records] of grouped.entries()) {
    const byCapture = new Map();

    for (const record of records) {
      const bucket = byCapture.get(record.capturedAt) || [];
      bucket.push(record);
      byCapture.set(record.capturedAt, bucket);
    }

    const captures = [...byCapture.entries()]
      .map(([capturedAt, items]) => ({
        capturedAt,
        records: items,
        averageDecimalOdds: round(mean(items.map((item) => item.decimalOdds)), 4),
        best: items.reduce((winner, item) => Number(item.decimalOdds) > Number(winner.decimalOdds) ? item : winner, items[0]),
        bookmakerCount: new Set(items.map((item) => item.bookmaker)).size
      }))
      .sort((left, right) => new Date(right.capturedAt) - new Date(left.capturedAt));

    const latest = captures[0];
    const previous = captures.find((capture) => capture.capturedAt !== latest.capturedAt);
    const movement = previous ? round((latest.averageDecimalOdds - previous.averageDecimalOdds) / previous.averageDecimalOdds, 4) : 0;
    const bestOverAverage = latest.averageDecimalOdds > 0 ? round((Number(latest.best.decimalOdds) - latest.averageDecimalOdds) / latest.averageDecimalOdds, 4) : 0;

    summaries.set(key, {
      key,
      fixtureId: latest.best.fixtureId,
      market: latest.best.market,
      outcome: latest.best.outcome,
      capturedAt: latest.capturedAt,
      bestRecord: latest.best,
      averageDecimalOdds: latest.averageDecimalOdds,
      bookmakerCount: latest.bookmakerCount,
      previousAverageDecimalOdds: previous?.averageDecimalOdds || null,
      movement,
      shortening: movement < -0.015,
      drifting: movement > 0.015,
      bestOverAverage,
      marketImpliedProbability: round(decimalToImpliedProbability(latest.averageDecimalOdds), 4)
    });
  }

  return summaries;
}

function aggregateNewsByTeam(newsArticles, teams, now) {
  const byTeam = new Map();

  for (const article of newsArticles) {
    for (const team of article.teamTags || []) {
      if (!teams.includes(team)) {
        continue;
      }

      const existing = byTeam.get(team) || [];
      existing.push(article);
      byTeam.set(team, existing);
    }
  }

  const result = new Map();

  for (const team of teams) {
    result.set(team, aggregateNews(byTeam.get(team) || [], team));
  }

  return result;
}

function aggregateNews(articles, team) {
  if (!articles.length) {
    return neutralNews();
  }

  const accepted = articles.filter((article) => article.acceptedSource !== false);
  if (!accepted.length) {
    return {
      ...neutralNews(),
      rejectedArticleCount: articles.length
    };
  }

  const articleWeights = accepted
    .map((article) => ({ article, weight: newsRelevanceWeight(article, team) }))
    .filter((item) => item.weight > 0);
  const directional = articleWeights.filter((item) => item.weight >= 0.5);

  if (!directional.length) {
    return {
      ...neutralNews(),
      contextArticleCount: accepted.length,
      rejectedArticleCount: articles.length - accepted.length
    };
  }

  const totalReliability = directional.reduce((total, item) => total + weightedReliability(item), 0) || 1;
  const sentiment = directional.reduce((total, item) => total + Number(item.article.sentiment || 0) * weightedReliability(item), 0) / totalReliability;
  const injury = directional.reduce((total, item) => total + Number(item.article.signals?.injury || 0) * weightedReliability(item), 0) / totalReliability;
  const tacticalFit = directional.reduce((total, item) => total + Number(item.article.signals?.tacticalFit || 0.45) * weightedReliability(item), 0) / totalReliability;
  const lineupClarity = directional.reduce((total, item) => total + Number(item.article.signals?.lineupClarity || 0.45) * weightedReliability(item), 0) / totalReliability;
  const rotationRisk = directional.reduce((total, item) => total + Number(item.article.signals?.rotationRisk || 0.18) * weightedReliability(item), 0) / totalReliability;
  const sourceDiversity = new Set(directional.map((item) => item.article.source || item.article.provider)).size;
  const relevance = mean(directional.map((item) => item.weight));
  const impact = clamp(sentiment * 0.5 + tacticalFit * 0.14 + lineupClarity * 0.12 - injury * 0.32 - rotationRisk * 0.12, -0.6, 0.6);

  return {
    articleCount: directional.length,
    contextArticleCount: accepted.length - directional.length,
    rejectedArticleCount: articles.length - accepted.length,
    relevance: round(relevance, 4),
    sourceDiversity,
    sentiment: round(sentiment, 4),
    injury: round(injury, 4),
    tacticalFit: round(tacticalFit, 4),
    lineupClarity: round(lineupClarity, 4),
    rotationRisk: round(rotationRisk, 4),
    impact: round(impact, 4),
    confidence: round(clamp(0.3 + sourceDiversity * 0.1 + mean(directional.map((item) => Number(item.article.sourceReliability || 0.5) * item.weight)) * 0.38, 0, 0.92), 4),
    topSignals: topNewsSignals(directional.map((item) => item.article))
  };
}

function weightedReliability(item) {
  return Number(item.article.sourceReliability || 0.5) * Number(item.weight || 0);
}

function newsRelevanceWeight(article, team) {
  const keys = teamIdentityKeys(team);
  const headline = normalizeName(`${article.title || ""} ${article.description || ""}`);
  const body = normalizeName(article.bodySnippet || "");
  const tags = article.teamTags || [];
  const taggedTeamCount = tags.length;
  const headlineMatch = keys.some((key) => headline.includes(key));
  const bodyMatch = keys.some((key) => body.includes(key));

  if (!headline && !body && tags.some((tag) => normalizeName(tag) === normalizeName(team))) {
    return 0.65;
  }

  if (headlineMatch) {
    return taggedTeamCount > 5 ? 0.72 : 1;
  }

  if (bodyMatch) {
    return taggedTeamCount > 5 ? 0.28 : 0.42;
  }

  return 0;
}

function marketPressureForTeam({ team, fixtures, movementByOutcome }) {
  const movements = [];

  for (const fixture of fixtures) {
    if (![fixture.homeTeam, fixture.awayTeam].includes(team)) {
      continue;
    }

    const matchWinner = movementByOutcome.get(outcomeKey(fixture.id, "match_winner", team));
    const drawNoBet = movementByOutcome.get(outcomeKey(fixture.id, "draw_no_bet", team));
    movements.push(...[matchWinner, drawNoBet].filter(Boolean));
  }

  if (!movements.length) {
    return {
      pressure: 0,
      confidence: 0.28,
      consensusOdds: null,
      movement: 0,
      bookmakerCount: 0
    };
  }

  const movement = mean(movements.map((item) => Number(item.movement || 0)));
  const consensusOdds = mean(movements.map((item) => item.averageDecimalOdds));
  const consensusImpliedProbability = decimalToImpliedProbability(consensusOdds);
  const movementPressure = clamp(-movement * 4.5, -0.45, 0.45);
  const consensusPressure = clamp((consensusImpliedProbability - 0.38) * 0.75, -0.22, 0.34);
  const pressure = clamp(movementPressure * 0.7 + consensusPressure * 0.3, -0.45, 0.45);
  const bookmakerCount = Math.max(...movements.map((item) => Number(item.bookmakerCount || 0)));

  return {
    pressure: round(pressure, 4),
    confidence: round(clamp(0.34 + bookmakerCount * 0.08 + movements.length * 0.06, 0, 0.9), 4),
    consensusOdds: round(consensusOdds, 3),
    consensusImpliedProbability: round(consensusImpliedProbability, 4),
    movement: round(movement, 4),
    bookmakerCount
  };
}

function neutralNews() {
  return {
    articleCount: 0,
    sourceDiversity: 0,
    sentiment: 0,
    injury: 0,
    tacticalFit: 0.45,
    lineupClarity: 0.45,
    rotationRisk: 0.18,
    impact: 0,
    confidence: 0.32,
    topSignals: []
  };
}

function topNewsSignals(articles) {
  const signals = [];
  const text = articles.map((article) => `${article.title || ""} ${article.description || ""}`).join(" ").toLowerCase();

  if (/injur|doubt|suspend|fatigue/.test(text)) {
    signals.push("availability risk");
  }

  if (/lineup|formation|shape|system/.test(text)) {
    signals.push("lineup/tactical clue");
  }

  if (/fit|return|available|training/.test(text)) {
    signals.push("positive availability");
  }

  if (/set piece|press|counter|transition/.test(text)) {
    signals.push("style clue");
  }

  return signals.slice(0, 4);
}

function aggregateScorerIntelligence(playerStats = []) {
  const byTeam = new Map();

  for (const record of playerStats) {
    const teamKey = normalizeName(record.team);
    const bucket = byTeam.get(teamKey) || [];
    bucket.push(record);
    byTeam.set(teamKey, bucket);
  }

  const result = new Map();

  for (const [teamKey, records] of byTeam.entries()) {
    const sorted = [...records].sort((left, right) => Number(right.goals || 0) - Number(left.goals || 0));
    const top = sorted.slice(0, 5);
    const topGoals = top.reduce((total, item) => total + Number(item.goals || 0), 0);
    const sample = top.reduce((total, item) => total + Number(item.matchesSampled || 0), 0);
    const threat = clamp((topGoals / Math.max(5, sample)) * 0.45, 0, 0.28);
    result.set(teamKey, {
      trackedPlayers: records.length,
      topScorers: top.map((item) => ({
        playerName: item.playerName,
        goals: Number(item.goals || 0),
        matchesSampled: Number(item.matchesSampled || 0)
      })),
      threat: round(threat, 4),
      confidence: round(clamp(0.28 + records.length * 0.025 + sample * 0.012, 0.28, 0.78), 4)
    });
  }

  return result;
}

function neutralScorerIntelligence() {
  return {
    trackedPlayers: 0,
    topScorers: [],
    threat: 0,
    confidence: 0.28
  };
}

function buildReasons({ form, news, market, scorer, learnedEdge }) {
  const reasons = [];

  if (form.matchCount) {
    reasons.push(`20-match form ${form.pointsPerGame} PPG, xG ${form.xgFor}-${form.xgAgainst}`);
  }

  if (Math.abs(form.formMomentum) >= 0.08) {
    reasons.push(form.formMomentum > 0 ? "recent form improving" : "recent form cooling");
  }

  if (news.articleCount) {
    reasons.push(`${news.articleCount} news item(s), news impact ${news.impact}`);
  }

  if (market.bookmakerCount) {
    reasons.push(`market intelligence ${round(market.movement * 100, 2)}% movement, consensus ${market.consensusOdds || "n/a"} across ${market.bookmakerCount} bookie(s)`);
  }

  if (scorer.trackedPlayers) {
    reasons.push(`${scorer.trackedPlayers} scorer record(s), top scorer signal ${scorer.threat}`);
  }

  if (Math.abs(learnedEdge) >= 0.08) {
    reasons.push(learnedEdge > 0 ? "memory currently leans positive" : "memory currently leans negative");
  }

  return reasons;
}

function blend(base, overlay, overlayWeight) {
  return base * (1 - overlayWeight) + Number(overlay || 0) * overlayWeight;
}

function outcomeKey(fixtureId, market, outcome) {
  return `${fixtureId}|${market}|${outcome}`;
}

function incrementLearning(map, key, status) {
  const item = map.get(key) || { count: 0, wins: 0, losses: 0 };
  item.count += 1;

  if (status === "won") {
    item.wins += 1;
  } else {
    item.losses += 1;
  }

  map.set(key, item);
}

function finalizeLearning(item) {
  return {
    ...item,
    winRate: item.count ? round(item.wins / item.count, 4) : 0
  };
}

function learningToAdjustment(item) {
  const sampleWeight = clamp(item.count / 30, 0, 1);
  return (item.winRate - 0.5) * 0.16 * sampleWeight;
}

function buildCalibrationBucket(outcomes) {
  const bucket = emptyCalibrationBucket();

  for (const outcome of outcomes) {
    addCalibrationOutcome(bucket, outcome);
  }

  return bucket;
}

function incrementCalibration(map, key, outcome) {
  const bucket = map.get(key) || emptyCalibrationBucket();
  addCalibrationOutcome(bucket, outcome);
  map.set(key, bucket);
}

function emptyCalibrationBucket() {
  return {
    count: 0,
    wins: 0,
    losses: 0,
    modelProbabilityTotal: 0,
    impliedProbabilityTotal: 0,
    brierTotal: 0
  };
}

function addCalibrationOutcome(bucket, outcome) {
  const probability = outcomeProbability(outcome);
  const impliedProbability = Number(outcome.marketImpliedProbability ?? outcome.impliedProbability ?? 0);
  const actual = outcome.status === "won" ? 1 : 0;

  bucket.count += 1;
  bucket.wins += actual;
  bucket.losses += actual ? 0 : 1;
  bucket.modelProbabilityTotal += probability;
  bucket.impliedProbabilityTotal += Number.isFinite(impliedProbability) ? impliedProbability : 0;
  bucket.brierTotal += (probability - actual) ** 2;
}

function finalizeCalibration(bucket) {
  const count = Number(bucket?.count || 0);

  if (!count) {
    return {
      count: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      averageModelProbability: 0,
      averageImpliedProbability: 0,
      calibrationError: 0,
      brierScore: 0
    };
  }

  const winRate = bucket.wins / count;
  const averageModelProbability = bucket.modelProbabilityTotal / count;

  return {
    count,
    wins: bucket.wins,
    losses: bucket.losses,
    winRate: round(winRate, 4),
    averageModelProbability: round(averageModelProbability, 4),
    averageImpliedProbability: round(bucket.impliedProbabilityTotal / count, 4),
    calibrationError: round(winRate - averageModelProbability, 4),
    brierScore: round(bucket.brierTotal / count, 4)
  };
}

function calibrationToAdjustment(item) {
  if (!item || Number(item.count || 0) < 6) {
    return 0;
  }

  const sampleWeight = clamp(Number(item.count || 0) / 36, 0, 1);
  return clamp(Number(item.calibrationError || 0) * 0.18 * sampleWeight, -0.045, 0.045);
}

function outcomeProbability(outcome) {
  const value = Number(
    outcome.likelyProbability
    ?? outcome.modelProbability
    ?? outcome.rawModelProbability
    ?? outcome.confidence
    ?? 0.5
  );

  return clamp(Number.isFinite(value) ? value : 0.5, 0.02, 0.98);
}

function probabilityBand(probability) {
  const pct = Math.floor(clamp(probability, 0, 0.999) * 100);

  if (pct < 40) {
    return "00-39";
  }
  if (pct < 50) {
    return "40-49";
  }
  if (pct < 60) {
    return "50-59";
  }
  if (pct < 70) {
    return "60-69";
  }
  if (pct < 80) {
    return "70-79";
  }
  return "80-99";
}
