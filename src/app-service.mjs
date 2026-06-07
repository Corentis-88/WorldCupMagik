import { appendJsonRecords, loadEngineState, readJson, upsertJsonRecords, writeJson } from "./db.mjs";
import { buildScanIntelligence, buildTeamStatsWithIntelligence, loadIntelligenceState, loadOutcomeLearning, persistScanIntelligence } from "./intelligence-memory.mjs";
import { rankBookmakerOffers } from "./offer-engine.mjs";
import { buildBetRecommendations } from "./portfolio-builder.mjs";
import { fetchFixturesWithDiagnostics } from "./providers/fixtures-provider.mjs";
import { fetchNewsArticlesWithDiagnostics } from "./providers/news-provider.mjs";
import { fetchOddsSnapshotWithDiagnostics } from "./providers/odds-provider.mjs";
import { fetchTeamStatsWithDiagnostics } from "./providers/stats-provider.mjs";
import { buildLegCandidates } from "./scoring.mjs";
import { isoDate, makeId, round } from "./utils.mjs";

const settingsPath = ["data", "app-settings.json"];
const STANDARD_BET_TYPES = [
  { key: "single", label: "Single", type: "single", legCount: 1 },
  { key: "double", label: "Double", type: "double", legCount: 2 },
  { key: "trixie", label: "Trixie", type: "trixie", legCount: 3 },
  { key: "accumulator_3", label: "3-leg accumulator", type: "accumulator", legCount: 3 },
  { key: "accumulator_4", label: "4-leg accumulator", type: "accumulator", legCount: 4 },
  { key: "accumulator_5", label: "5-leg accumulator", type: "accumulator", legCount: 5 },
  { key: "accumulator_6", label: "6-leg accumulator", type: "accumulator", legCount: 6 },
  { key: "accumulator_8", label: "8-leg accumulator", type: "accumulator", legCount: 8 }
];

export async function getDashboardState({ now = new Date() } = {}) {
  const state = await loadEngineState();
  const settings = await loadAppSettings(state.policy);
  const liveFixtures = state.fixtures.filter(isPublicFixture);
  const [latestScan, recommendations, offers] = await Promise.all([
    readJson(["data", "app-scan-latest.json"], null),
    readJson(["data", "recommendations-latest.json"], null),
    readJson(["data", "bookmaker-offer-ranking-latest.json"], [])
  ]);

  return {
    now: now.toISOString(),
    settings,
    fixtures: selectFixturesForWindow(liveFixtures, settings.daysAhead, now),
    stats: {
      fixtureCount: liveFixtures.length,
      oddsSnapshotCount: state.oddsSnapshots.filter(isPublicOddsRecord).length,
      scorerOddsCount: state.oddsSnapshots.filter(isPublicOddsRecord).filter(isScorerOddsRecord).length,
      newsArticleCount: state.newsArticles.filter(isPublicNewsArticle).length,
      teamStatsCount: state.teamStats.filter(isPublicTeamStat).length,
      teamIntelligenceCount: latestScan?.intelligence?.teamCount || 0,
      intelligenceObservationCount: latestScan?.intelligence?.observationCount || 0,
      latestScanAt: latestScan?.createdAt || null,
      latestBetslipCount: latestScan?.betslip?.length || 0
    },
    recommendations,
    latestScan,
    offers,
    appDefaults: state.policy.appDefaults || {}
  };
}

export async function loadAppSettings(policy = null) {
  const currentPolicy = policy || (await readJson(["config", "engine-policy.json"]));
  const defaults = currentPolicy.appDefaults || {};
  const saved = await readJson(settingsPath, {});

  return sanitizeSettings({
    stake: defaults.stake ?? 10,
    risk: defaults.risk ?? 48,
    daysAhead: defaults.daysAhead ?? 2,
    ...saved
  });
}

export async function saveAppSettings(settings) {
  const sanitized = sanitizeSettings(settings);
  await writeJson(settingsPath, sanitized);
  return sanitized;
}

export async function scanForBets(settings, { now = new Date(), scheduled = false } = {}) {
  const engineState = await loadEngineState();
  const intelligenceState = await loadIntelligenceState();
  const outcomeLearning = await loadOutcomeLearning();
  const appSettings = await saveAppSettings(settings);
  const policy = buildRiskPolicy(engineState.policy, appSettings.risk);
  const sourceDiagnostics = [];
  const fixtureResult = await fetchFixturesWithDiagnostics({
    providerConfig: engineState.providers.fixtures,
    now
  });
  sourceDiagnostics.push(...fixtureResult.diagnostics);

  if (fixtureResult.records.length) {
    await writeJson(["data", "fixtures.json"], fixtureResult.records);
  }

  const liveFixtures = fixtureResult.records.length ? fixtureResult.records : engineState.fixtures.filter(isPublicFixture);
  const scanFixtures = selectFixturesForWindow(liveFixtures, appSettings.daysAhead, now);
  const statsResult = await fetchTeamStatsWithDiagnostics({
    providerConfig: engineState.providers.stats,
    fixtures: scanFixtures,
    now
  });
  sourceDiagnostics.push(...statsResult.diagnostics);
  const liveMatchHistory = [
    ...(statsResult.matchHistory || []),
    ...intelligenceState.matchHistory.filter(isPublicMatchRecord)
  ];
  const baseTeamStats = statsResult.records;

  if (statsResult.matchHistory?.length) {
    await writeJson(["data", "team-match-history.json"], statsResult.matchHistory);
  }

  if (baseTeamStats.length) {
    await writeJson(["data", "team-stats.json"], baseTeamStats);
  }

  const preScanTeamStats = buildTeamStatsWithIntelligence({
    baseStats: baseTeamStats,
    matchHistory: liveMatchHistory,
    teamIntelligence: intelligenceState.teamIntelligence,
    now
  });
  const newsResult = await fetchNewsArticlesWithDiagnostics({
    fixtures: scanFixtures,
    providerConfig: engineState.providers.news,
    now
  });
  sourceDiagnostics.push(...newsResult.diagnostics);
  const newsArticles = newsResult.records;
  const oddsResult = await fetchOddsSnapshotWithDiagnostics({
    fixtures: scanFixtures,
    providerConfig: engineState.providers.odds,
    now
  });
  sourceDiagnostics.push(...oddsResult.diagnostics);
  const oddsRecords = oddsResult.records;

  if (oddsRecords.length) {
    const existingOdds = (await readJson(["data", "odds-snapshots.json"], [])).filter(isPublicOddsRecord);
    await writeJson(["data", "odds-snapshots.json"], [...oddsRecords, ...existingOdds].slice(0, 50000));
    const existingDailyOdds = (await readJson(["data", "snapshots", `odds-${isoDate(now)}.json`], [])).filter(isPublicOddsRecord);
    await writeJson(["data", "snapshots", `odds-${isoDate(now)}.json`], [...oddsRecords, ...existingDailyOdds].slice(0, 50000));
  }

  if (newsArticles.length) {
    const existingNews = (await readJson(["data", "news-articles.json"], [])).filter(isPublicNewsArticle);
    const byArticle = new Map(existingNews.map((article) => [article.id, article]));

    for (const article of newsArticles) {
      byArticle.set(article.id, article);
    }

    await writeJson(["data", "news-articles.json"], [...byArticle.values()]
      .sort((left, right) => new Date(right.createdAt || right.publishedAt || 0) - new Date(left.createdAt || left.publishedAt || 0))
      .slice(0, 10000));
  }

  if (sourceDiagnostics.length) {
    await writeJson(["data", "source-health-latest.json"], {
      createdAt: now.toISOString(),
      diagnostics: sourceDiagnostics
    });
    await appendJsonRecords(["data", "source-health.json"], sourceDiagnostics, 20000);
  }

  const latestState = await loadEngineState();
  const allNewsArticles = latestState.newsArticles.filter(isPublicNewsArticle);
  const allOddsSnapshots = latestState.oddsSnapshots.filter(isPublicOddsRecord);
  const intelligence = buildScanIntelligence({
    fixtures: scanFixtures,
    oddsRecords,
    allOddsSnapshots,
    newsArticles: allNewsArticles,
    teamStats: preScanTeamStats,
    matchHistory: liveMatchHistory,
    previousTeamIntelligence: intelligenceState.teamIntelligence,
    now
  });
  await persistScanIntelligence(intelligence);
  const teamStats = buildTeamStatsWithIntelligence({
    baseStats: baseTeamStats,
    matchHistory: liveMatchHistory,
    teamIntelligence: intelligence.teamIntelligence,
    now
  });
  const legCandidates = buildLegCandidates({
    fixtures: scanFixtures,
    oddsSnapshots: allOddsSnapshots,
    newsArticles: allNewsArticles,
    teamStats,
    policy,
    now,
    outcomeLearning
  });
  const recommendations = buildBetRecommendations(legCandidates, policy);
  const offerRanking = rankBookmakerOffers(latestState.bookmakerOffers, policy, now);
  const betslip = selectBetslip({
    recommendations,
    stake: appSettings.stake,
    risk: appSettings.risk
  });
  const dataQuality = buildDataQualitySummary({
    scanFixtures,
    oddsRecords,
    allOddsSnapshots,
    newsArticles,
    teamStats,
    sourceDiagnostics
  });
  const scan = {
    id: makeId("app_scan", [now.toISOString(), JSON.stringify(appSettings), scheduled ? "scheduled" : "manual"]),
    createdAt: now.toISOString(),
    scheduled,
    settings: appSettings,
    riskProfile: describeRisk(appSettings.risk),
    fixtureWindow: {
      daysAhead: appSettings.daysAhead,
      selectedFixtures: scanFixtures.length,
      usedFallbackNextFixtures: false
    },
    collected: {
      fixtures: fixtureResult.records.length,
      oddsRecords: oddsRecords.length,
      scorerOddsRecords: oddsRecords.filter(isScorerOddsRecord).length,
      newsArticles: newsArticles.length,
      teamStats: teamStats.length,
      matchHistoryRecords: statsResult.matchHistory?.length || 0,
      intelligenceObservations: intelligence.observations.length,
      sourceDiagnostics: sourceDiagnostics.length
    },
    dataQuality,
    sourceHealth: summarizeSourceHealth(sourceDiagnostics),
    intelligence: {
      teamCount: intelligence.teamIntelligence.length,
      observationCount: intelligence.observations.length,
      outcomeLearningCount: outcomeLearning.outcomeCount,
      topTeams: intelligence.teamIntelligence
        .sort((left, right) => Math.abs(right.learnedEdge) - Math.abs(left.learnedEdge))
        .slice(0, 6)
        .map((item) => ({
          team: item.team,
          learnedEdge: item.learnedEdge,
          confidence: item.dataConfidence,
          reasons: item.reasons
        }))
    },
    eligibleLegCount: recommendations.eligibleLegCount,
    betslip,
    offerRanking: offerRanking.slice(0, 5),
    strongestLegs: legCandidates.filter((leg) => !leg.hardBlocks.length).slice(0, 12)
  };

  await writeJson(["data", "leg-candidates-latest.json"], legCandidates);
  await writeJson(["data", "recommendations-latest.json"], recommendations);
  await writeJson(["data", "bookmaker-offer-ranking-latest.json"], offerRanking);
  await writeJson(["data", "app-scan-latest.json"], scan);
  await appendJsonRecords(["data", "app-scans.json"], [scan], 1000);

  return scan;
}

function buildDataQualitySummary({ scanFixtures, oddsRecords, allOddsSnapshots, newsArticles, teamStats, sourceDiagnostics }) {
  const sourceErrors = sourceDiagnostics.filter((item) => item.status === "error").length;
  const sourceEmpty = sourceDiagnostics.filter((item) => item.status === "empty").length;
  const sourceOk = sourceDiagnostics.filter((item) => item.status === "ok").length;
  const teamsWithRecentMatches = teamStats.filter((team) => Number(team.sourceMatchCount || team.formMemory?.matchCount || 0) >= 2).length;
  const selectedFixtureIds = new Set(scanFixtures.map((fixture) => fixture.id));
  const fixtureOddsCoverage = scanFixtures.length
    ? new Set(allOddsSnapshots.filter((record) => selectedFixtureIds.has(record.fixtureId)).map((record) => record.fixtureId)).size / scanFixtures.length
    : 0;
  const fixtureNewsCoverage = scanFixtures.length
    ? new Set(newsArticles.flatMap((article) => article.teamTags || [])).size / Math.max(1, new Set(scanFixtures.flatMap((fixture) => [fixture.homeTeam, fixture.awayTeam])).size)
    : 0;
  const readiness = scanFixtures.length
    && oddsRecords.length
    && teamStats.length
    ? "ready"
    : "collecting";

  return {
    readiness,
    sourceOk,
    sourceEmpty,
    sourceErrors,
    fixtureCount: scanFixtures.length,
    freshOddsRecords: oddsRecords.length,
    freshScorerOddsRecords: oddsRecords.filter(isScorerOddsRecord).length,
    oddsHistoryRecords: allOddsSnapshots.length,
    scorerOddsHistoryRecords: allOddsSnapshots.filter(isScorerOddsRecord).length,
    newsArticleCount: newsArticles.length,
    teamStatsCount: teamStats.length,
    teamsWithRecentMatches,
    fixtureOddsCoverage: round(fixtureOddsCoverage, 3),
    fixtureNewsCoverage: round(fixtureNewsCoverage, 3),
    message: readiness === "ready"
      ? "Real public-web data was gathered and scored. Source misses are recorded instead of filled with made-up data."
      : "The database is still collecting real public-web data. Missing sources are visible in source health; no fake bets are generated."
  };
}

function summarizeSourceHealth(sourceDiagnostics) {
  const byKind = {};

  for (const item of sourceDiagnostics) {
    const bucket = byKind[item.kind] || { ok: 0, empty: 0, error: 0, records: 0 };
    bucket[item.status] = (bucket[item.status] || 0) + 1;
    bucket.records += Number(item.records || 0);
    byKind[item.kind] = bucket;
  }

  return {
    byKind,
    failures: sourceDiagnostics.filter((item) => item.status === "error" || item.status === "empty").slice(0, 20)
  };
}

export function buildRiskPolicy(basePolicy, riskValue) {
  const risk = clampNumber(riskValue, 0, 100);
  const appetite = risk / 100;
  const preferredDoubleMin = 2 + appetite * 0.95;
  const preferredDoubleMax = 4.6 + appetite * 10.4;
  const preferredTrixieMin = 3.2 + appetite * 3.8;
  const preferredTrixieMax = 10 + appetite * 42;
  const accumulatorRanges = {
    3: {
      min: round(4.2 + appetite * 4.8, 2),
      max: round(14 + appetite * 56, 2)
    },
    4: {
      min: round(6.5 + appetite * 8.5, 2),
      max: round(26 + appetite * 96, 2)
    },
    5: {
      min: round(9 + appetite * 13, 2),
      max: round(42 + appetite * 155, 2)
    },
    6: {
      min: round(12 + appetite * 20, 2),
      max: round(68 + appetite * 245, 2)
    },
    8: {
      min: round(22 + appetite * 38, 2),
      max: round(140 + appetite * 520, 2)
    }
  };

  return {
    ...basePolicy,
    riskProfile: {
      ...(basePolicy.riskProfile || {}),
      mode: describeRisk(risk).key,
      minLegEdge: round(0.03 - appetite * 0.03, 4),
      minLegConfidence: round(0.72 - appetite * 0.34, 4),
      minIntelligenceConfidence: round(0.64 - appetite * 0.3, 4),
      maxFavoriteImpliedProbability: round(0.82 - appetite * 0.22, 4),
      minDecimalOddsForRiskLeg: round(1.75 + appetite * 1.55, 2),
      minBookmakerCount: appetite < 0.22 ? 2 : 1,
      marketConfirmationWeight: round(0.36 - appetite * 0.16, 4),
      valueHuntingWeight: round(0.14 + appetite * 0.34, 4),
      contrarianWeight: round(0.02 + appetite * 0.38, 4),
      minRiskLegsForTrixie: appetite >= 0.42 ? 1 : 0,
      maxLegs: 8,
      maxCombinedOdds: round(38 + appetite * 560, 2),
      preferredCombinedOdds: {
        double: {
          min: round(preferredDoubleMin, 2),
          max: round(preferredDoubleMax, 2)
        },
        trixie: {
          min: round(preferredTrixieMin, 2),
          max: round(preferredTrixieMax, 2)
        },
        accumulator: {
          min: accumulatorRanges[3].min,
          max: accumulatorRanges[8].max
        },
        accumulatorByLegCount: accumulatorRanges
      }
    }
  };
}

export function describeRisk(riskValue) {
  const risk = clampNumber(riskValue, 0, 100);

  if (risk < 22) {
    return {
      key: "careful",
      label: "Careful",
      description: "Prioritises higher confidence, fresher data, and fewer legs."
    };
  }

  if (risk < 48) {
    return {
      key: "balanced",
      label: "Balanced",
      description: "Looks for value while still keeping the betslip fairly grounded."
    };
  }

  if (risk < 75) {
    return {
      key: "calculated",
      label: "Calculated Risk",
      description: "Uses public odds, team form, news, and value signals without just following favourites."
    };
  }

  return {
    key: "bold",
    label: "Bold",
    description: "Allows longer odds and bigger combined prices when the evidence supports it."
  };
}

export function selectFixturesForWindow(fixtures, daysAhead, now = new Date()) {
  const start = startOfDay(now);
  const end = new Date(start);
  end.setDate(end.getDate() + clampNumber(daysAhead, 0, 30) + 1);

  return fixtures
    .filter((fixture) => {
      const date = new Date(fixture.date);
      return date >= start && date < end;
    })
    .sort((left, right) => new Date(left.date) - new Date(right.date));
}

export function selectNextFixtures(fixtures, count, now = new Date()) {
  const start = startOfDay(now);

  return fixtures
    .filter((fixture) => new Date(fixture.date) >= start)
    .sort((left, right) => new Date(left.date) - new Date(right.date))
    .slice(0, Math.max(1, count));
}

export function selectBetslip({ recommendations, stake, risk }) {
  const totalStake = clampNumber(stake, 1, 100000);
  const selected = STANDARD_BET_TYPES
    .map((category) => ({ category, combo: pickCategoryCombo(recommendations, category, risk) }))
    .filter((item) => item.combo);
  const stakePerBet = round(totalStake / Math.max(1, selected.length || STANDARD_BET_TYPES.length), 2);

  return selected.map(({ category, combo }, index) => {
    const potentialReturn = calculatePotentialReturn(combo, stakePerBet);

    return {
    id: combo.id,
    rank: index + 1,
    category: category.key,
    label: category.label,
    type: combo.type,
    score: combo.score,
    legCount: combo.legCount,
    combinedDecimalOdds: combo.combinedDecimalOdds,
    stake: stakePerBet,
    potentialReturn,
    potentialProfit: round(Math.max(0, potentialReturn - stakePerBet), 2),
    combinedProbability: combo.combinedProbability,
    expectedValue: combo.expectedValue,
    averageConfidence: combo.averageConfidence,
    riskLegCount: combo.riskLegCount,
    legs: combo.legs,
    thesis: combo.thesis
    };
  });
}

function sanitizeSettings(settings) {
  return {
    stake: round(clampNumber(settings.stake, 1, 100000), 2),
    risk: Math.round(clampNumber(settings.risk, 0, 100)),
    daysAhead: Math.round(clampNumber(settings.daysAhead, 0, 30))
  };
}

function pickCategoryCombo(recommendations, category, risk = 50) {
  if (!recommendations) {
    return null;
  }

  if (category.type === "single") {
    return bestSingleForRisk(recommendations.singles || [], risk);
  }

  if (category.type === "double") {
    return bestCombo(recommendations.doubles || []);
  }

  if (category.type === "trixie") {
    return bestCombo(recommendations.trixies || []);
  }

  const byLegCount = recommendations.accumulatorsByLegCount?.[category.legCount] || [];
  const fallback = (recommendations.accumulators || []).filter((combo) => Number(combo.legCount) === category.legCount);
  return bestCombo(byLegCount.length ? byLegCount : fallback);
}

function bestSingleForRisk(combos, risk) {
  const appetite = clampNumber(risk, 0, 100) / 100;
  const targetOdds = 1.48 + appetite * 2.35;
  const targetRisk = appetite * 3;

  return [...combos].sort((left, right) => {
    return singleRiskFit(right, targetOdds, targetRisk, appetite) - singleRiskFit(left, targetOdds, targetRisk, appetite);
  })[0] || null;
}

function singleRiskFit(combo, targetOdds, targetRisk, appetite) {
  const leg = combo.legs?.[0] || {};
  const odds = Number(combo.combinedDecimalOdds || leg.decimalOdds || 1);
  const confidence = Number(combo.averageConfidence || leg.confidence || 0);
  const edge = Number(combo.averageEdge || leg.edge || 0);
  const expectedValue = Number(combo.expectedValue || 0);
  const oddsFit = Math.max(0, 1 - Math.abs(Math.log(Math.max(1.01, odds) / targetOdds)) / 0.78);
  const tagFit = Math.max(0, 1 - Math.abs(riskTagLevel(leg.riskTag) - targetRisk) / 3);
  const lowRiskStability = appetite < 0.38 && ["steady_edge", "value_favourite", "market_confirmed_edge"].includes(leg.riskTag) ? 9 : 0;
  const highRiskPrice = appetite > 0.55 && ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag) ? 6 : 0;

  return (Number(combo.score || 0) * 0.1)
    + oddsFit * 42
    + tagFit * 14
    + confidence * (30 - appetite * 8)
    + edge * (18 + appetite * 40)
    + Math.min(12, Math.max(-6, expectedValue * 8)) * appetite
    + lowRiskStability
    + highRiskPrice;
}

function riskTagLevel(tag) {
  if (tag === "value_favourite" || tag === "market_confirmed_edge") {
    return 0.6;
  }

  if (tag === "calculated_risk") {
    return 1.8;
  }

  if (tag === "longshot_value") {
    return 2.6;
  }

  if (tag === "contrarian_value") {
    return 3;
  }

  return 0;
}

function bestCombo(combos) {
  return [...combos].sort((left, right) => {
    const leftScore = Number(left.score || 0) + Number(left.expectedValue || 0) * 8 + Number(left.averageConfidence || 0) * 5;
    const rightScore = Number(right.score || 0) + Number(right.expectedValue || 0) * 8 + Number(right.averageConfidence || 0) * 5;
    return rightScore - leftScore;
  })[0] || null;
}

function calculatePotentialReturn(combo, stake) {
  if (combo.type !== "trixie" || combo.legs.length !== 3) {
    return round(stake * Number(combo.combinedDecimalOdds || 0), 2);
  }

  const odds = combo.legs.map((leg) => Number(leg.decimalOdds || 1));
  const unit = stake / 4;
  const doubleReturns = (odds[0] * odds[1]) + (odds[0] * odds[2]) + (odds[1] * odds[2]);
  const trebleReturn = odds[0] * odds[1] * odds[2];
  return round(unit * (doubleReturns + trebleReturn), 2);
}

function isPublicFixture(fixture) {
  return fixture?.sourceType === "public-web" || fixture?.provider === "public-web";
}

function isPublicOddsRecord(record) {
  return record?.provider === "public-web" || record?.sourceType === "public-web";
}

function isScorerOddsRecord(record) {
  return record?.market === "anytime_scorer";
}

function isPublicNewsArticle(article) {
  return article?.provider === "self-gather" || article?.sourceType === "public-web" || article?.sourceType === "rss" || article?.sourceType === "atom" || article?.sourceType === "html";
}

function isPublicTeamStat(team) {
  return team?.provider === "public-web" || team?.sourceType === "public-web";
}

function isPublicMatchRecord(match) {
  return match?.sourceType === "public-web" || match?.provider === "public-web";
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.max(min, Math.min(max, number));
}
