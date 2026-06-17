import { appendJsonRecords, loadEngineState, readJson, upsertJsonRecords, writeJson } from "./db.mjs";
import { buildScanIntelligence, buildTeamStatsWithIntelligence, loadIntelligenceState, loadOutcomeLearning, persistScanIntelligence } from "./intelligence-memory.mjs";
import { rankBookmakerOffers } from "./offer-engine.mjs";
import { buildBetRecommendations, buildMostLikelyPicks } from "./portfolio-builder.mjs";
import { fetchFixturesWithDiagnostics } from "./providers/fixtures-provider.mjs";
import { fetchNewsArticlesWithDiagnostics } from "./providers/news-provider.mjs";
import { fetchOddsSnapshotWithDiagnostics } from "./providers/odds-provider.mjs";
import { fetchSquadDepthWithDiagnostics } from "./providers/squad-provider.mjs";
import { fetchTeamStatsWithDiagnostics } from "./providers/stats-provider.mjs";
import { fetchHeatSnapshotsWithDiagnostics } from "./providers/weather-provider.mjs";
import { settleStoredBetOutcomes } from "./outcome-settler.mjs";
import { refreshPredictionReflections } from "./prediction-reflection.mjs";
import { persistPredictionLedger } from "./prediction-ledger.mjs";
import { loadPostMatchStats, mergePostMatchStats } from "./post-match-stats.mjs";
import { buildLegCandidates } from "./scoring.mjs";
import { buildSurvivabilityMarketCoverage, isSurvivabilityMarketRecord } from "./survivability-market-coverage.mjs";
import { isoDate, makeId, normalizeName, round } from "./utils.mjs";
import climateProfiles from "../config/team-climate-profiles.json" with { type: "json" };
import climateHistory from "../config/world-cup-climate-history.json" with { type: "json" };

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
  const [latestScan, recommendations, offers, survivabilityMarketCoverage] = await Promise.all([
    readJson(["data", "app-scan-latest.json"], null),
    readJson(["data", "recommendations-latest.json"], null),
    readJson(["data", "bookmaker-offer-ranking-latest.json"], []),
    readJson(["data", "survivability-market-coverage-latest.json"], null)
  ]);

  return {
    now: now.toISOString(),
    settings,
    fixtures: selectFixturesForWindow(liveFixtures, settings.daysAhead, now),
    stats: {
      fixtureCount: liveFixtures.length,
      oddsSnapshotCount: state.oddsSnapshots.filter(isPublicOddsRecord).length,
      survivabilityOddsCount: state.oddsSnapshots.filter(isPublicOddsRecord).filter(isSurvivabilityMarketRecord).length,
      scorerOddsCount: state.oddsSnapshots.filter(isPublicOddsRecord).filter(isScorerOddsRecord).length,
      heatSnapshotCount: state.heatSnapshots.filter(isPublicHeatRecord).length,
      squadDepthCount: state.squadDepthRecords.filter(isSquadDepthRecord).length,
      playerStatsCount: state.playerStats.filter(isPublicPlayerStat).length,
      newsArticleCount: state.newsArticles.filter(isPublicNewsArticle).length,
      teamStatsCount: state.teamStats.filter(isPublicTeamStat).length,
      teamIntelligenceCount: latestScan?.intelligence?.teamCount || 0,
      intelligenceObservationCount: latestScan?.intelligence?.observationCount || 0,
      latestScanAt: latestScan?.createdAt || null,
      latestBetslipCount: latestScan?.betslip?.length || 0
    },
    recommendations,
    latestScan,
    survivabilityMarketCoverage,
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
  let outcomeLearning = await loadOutcomeLearning();
  const appSettings = await saveAppSettings(settings);
  const useMostLikelyMode = Number(appSettings.risk || 0) <= 0;
  const policy = useMostLikelyMode ? buildMostLikelyPolicy(engineState.policy) : buildRiskPolicy(engineState.policy, appSettings.risk);
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
  const postMatchStats = await loadPostMatchStats();
  const liveMatchHistory = [
    ...(statsResult.matchHistory || []),
    ...intelligenceState.matchHistory.filter(isPublicMatchRecord)
  ];
  const enrichedMatchHistory = mergePostMatchStats(liveMatchHistory, postMatchStats);
  const baseTeamStats = statsResult.records;

  if (statsResult.matchHistory?.length) {
    await upsertJsonRecords(["data", "team-match-history.json"], statsResult.matchHistory, matchHistoryKey, 12000);
  }

  const outcomeSettlement = await settleStoredBetOutcomes({
    matchHistory: enrichedMatchHistory,
    postMatchStats,
    now
  });
  const reflectionRefresh = await refreshPredictionReflections({
    matchHistory: enrichedMatchHistory,
    postMatchStats,
    now
  });

  if (outcomeSettlement.insertedCount || reflectionRefresh.upsertedCount) {
    outcomeLearning = await loadOutcomeLearning();
  }

  if (statsResult.playerStats?.length) {
    await persistPlayerStats(statsResult);
  }

  if (baseTeamStats.length) {
    await writeJson(["data", "team-stats.json"], baseTeamStats);
  }

  const preScanTeamStats = buildTeamStatsWithIntelligence({
    baseStats: baseTeamStats,
    matchHistory: enrichedMatchHistory,
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
  const heatResult = await fetchHeatSnapshotsWithDiagnostics({
    fixtures: scanFixtures,
    providerConfig: engineState.providers.weather,
    now
  });
  sourceDiagnostics.push(...heatResult.diagnostics);
  const heatRecords = heatResult.records;
  const squadDepthResult = await fetchSquadDepthWithDiagnostics({
    fixtures: scanFixtures,
    providerConfig: engineState.providers.squadDepth,
    now
  });
  sourceDiagnostics.push(...squadDepthResult.diagnostics);
  const squadDepthRecords = squadDepthResult.records;

  if (oddsRecords.length) {
    const existingOdds = (await readJson(["data", "odds-snapshots.json"], [])).filter(isPublicOddsRecord);
    await writeJson(["data", "odds-snapshots.json"], [...oddsRecords, ...existingOdds].slice(0, 50000));
    const existingDailyOdds = (await readJson(["data", "snapshots", `odds-${isoDate(now)}.json`], [])).filter(isPublicOddsRecord);
    await writeJson(["data", "snapshots", `odds-${isoDate(now)}.json`], [...oddsRecords, ...existingDailyOdds].slice(0, 50000));
  }

  if (heatRecords.length) {
    const existingHeat = (await readJson(["data", "heat-snapshots.json"], [])).filter(isPublicHeatRecord);
    await writeJson(["data", "heat-snapshots.json"], [...heatRecords, ...existingHeat].slice(0, 20000));
  }

  if (squadDepthRecords.length) {
    await upsertJsonRecords(["data", "squad-depth.json"], squadDepthRecords, (record) => normalizeName(record.team), 2000);
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
  const allHeatSnapshots = latestState.heatSnapshots.filter(isPublicHeatRecord);
  const allSquadDepthRecords = latestState.squadDepthRecords.filter(isSquadDepthRecord);
  const allPlayerStats = latestState.playerStats.filter(isPublicPlayerStat);
  const survivabilityMarketCoverage = buildSurvivabilityMarketCoverage({
    fixtures: scanFixtures,
    oddsSnapshots: allOddsSnapshots,
    policy: latestState.policy,
    now
  });
  const intelligence = buildScanIntelligence({
    fixtures: scanFixtures,
    oddsRecords,
    allOddsSnapshots,
    newsArticles: allNewsArticles,
    teamStats: preScanTeamStats,
    matchHistory: enrichedMatchHistory,
    playerStats: allPlayerStats,
    previousTeamIntelligence: intelligenceState.teamIntelligence,
    now
  });
  await persistScanIntelligence(intelligence);
  const teamStats = buildTeamStatsWithIntelligence({
    baseStats: baseTeamStats,
    matchHistory: enrichedMatchHistory,
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
    outcomeLearning,
    heatSnapshots: allHeatSnapshots,
    squadDepthRecords: allSquadDepthRecords,
    playerStats: allPlayerStats
  });
  const recommendations = buildBetRecommendations(legCandidates, policy);
  await persistPredictionLedger(legCandidates);
  const mostLikelyBetslip = useMostLikelyMode
    ? selectMostLikelyBetslip({
      picks: buildMostLikelyPicks(legCandidates, policy, { fixtureCount: scanFixtures.length }),
      stake: appSettings.stake
    })
    : [];
  const offerRanking = rankBookmakerOffers(latestState.bookmakerOffers, policy, now);
  const betslip = useMostLikelyMode ? mostLikelyBetslip : selectBetslip({
    recommendations,
    stake: appSettings.stake,
    risk: appSettings.risk
  });
  const dataQuality = buildDataQualitySummary({
    scanFixtures,
    oddsRecords,
    allOddsSnapshots,
    heatRecords,
    allHeatSnapshots,
    squadDepthRecords,
    allSquadDepthRecords,
    playerStats: allPlayerStats,
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
      survivabilityOddsRecords: oddsRecords.filter(isSurvivabilityMarketRecord).length,
      scorerOddsRecords: oddsRecords.filter(isScorerOddsRecord).length,
      heatRecords: heatRecords.length,
      squadDepthRecords: squadDepthRecords.length,
      playerStats: allPlayerStats.length,
      newsArticles: newsArticles.length,
      teamStats: teamStats.length,
      matchHistoryRecords: statsResult.matchHistory?.length || 0,
      outcomeRecordsSettled: outcomeSettlement.insertedCount,
      predictionReflectionsSettled: reflectionRefresh.insertedCount,
      intelligenceObservations: intelligence.observations.length,
      sourceDiagnostics: sourceDiagnostics.length
    },
    dataQuality,
    survivabilityMarketCoverage,
    sourceHealth: summarizeSourceHealth(sourceDiagnostics),
    intelligence: {
      teamCount: intelligence.teamIntelligence.length,
      observationCount: intelligence.observations.length,
      outcomeLearningCount: outcomeLearning.outcomeCount,
      outcomeCalibration: outcomeLearning.calibration,
      predictionReflectionCount: outcomeLearning.reflection?.count || 0,
      predictionReflection: outcomeLearning.reflection,
      lastOutcomeSettlement: {
        examinedLegCount: outcomeSettlement.examinedLegCount,
        insertedCount: outcomeSettlement.insertedCount,
        skipped: outcomeSettlement.skipped
      },
      lastPredictionReflection: {
        examinedPredictionCount: reflectionRefresh.examinedPredictionCount,
        insertedCount: reflectionRefresh.insertedCount,
        updatedCount: reflectionRefresh.updatedCount,
        upsertedCount: reflectionRefresh.upsertedCount
      },
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
  await writeJson(["data", "survivability-market-coverage-latest.json"], survivabilityMarketCoverage);
  await writeJson(["data", "app-scan-latest.json"], scan);
  await appendJsonRecords(["data", "app-scans.json"], [scan], 1000);

  return scan;
}

function buildDataQualitySummary({ scanFixtures, oddsRecords, allOddsSnapshots, heatRecords = [], allHeatSnapshots = [], squadDepthRecords = [], allSquadDepthRecords = [], playerStats = [], newsArticles, teamStats, sourceDiagnostics }) {
  const sourceErrors = sourceDiagnostics.filter((item) => item.status === "error").length;
  const sourceEmpty = sourceDiagnostics.filter((item) => item.status === "empty").length;
  const sourceOk = sourceDiagnostics.filter((item) => item.status === "ok").length;
  const teamsWithRecentMatches = teamStats.filter((team) => Number(team.sourceMatchCount || team.formMemory?.matchCount || 0) >= 2).length;
  const selectedTeamLabels = [...new Set(scanFixtures.flatMap((fixture) => [fixture.homeTeam, fixture.awayTeam]).filter(Boolean))].sort();
  const selectedTeams = new Set(selectedTeamLabels.map(normalizeName).filter(Boolean));
  const teamStatsByName = new Map(teamStats.map((team) => [normalizeName(team.team), team]));
  const teamMatchSamples = selectedTeamLabels.map((team) => ({
    team,
    matchCount: teamMatchSampleCount(teamStatsByName.get(normalizeName(team)))
  }));
  const missingTwentyMatchTeams = teamMatchSamples.filter((team) => team.matchCount < 20);
  const teamsWithTwentyMatchSamples = teamMatchSamples.length - missingTwentyMatchTeams.length;
  const teamTwentyMatchCoverage = teamMatchSamples.length
    ? teamsWithTwentyMatchSamples / teamMatchSamples.length
    : 0;
  const minimumTeamMatchSample = teamMatchSamples.length
    ? Math.min(...teamMatchSamples.map((team) => team.matchCount))
    : 0;
  const climateProfileTeams = new Set(Object.keys(climateProfiles.teams || {}).map(normalizeName));
  const heatMemoryTeams = new Set(Object.keys(climateHistory.teamMemory || {}).map(normalizeName));
  const missingClimateProfileTeams = selectedTeamLabels.filter((team) => !climateProfileTeams.has(normalizeName(team)));
  const missingHeatMemoryTeams = selectedTeamLabels.filter((team) => !heatMemoryTeams.has(normalizeName(team)));
  const climateProfileCoverage = selectedTeams.size
    ? (selectedTeamLabels.length - missingClimateProfileTeams.length) / selectedTeamLabels.length
    : 0;
  const heatMemoryCoverage = selectedTeams.size
    ? (selectedTeamLabels.length - missingHeatMemoryTeams.length) / selectedTeamLabels.length
    : 0;
  const selectedFixtureIds = new Set(scanFixtures.map((fixture) => fixture.id));
  const fixtureOddsCoverage = scanFixtures.length
    ? new Set(allOddsSnapshots.filter((record) => selectedFixtureIds.has(record.fixtureId)).map((record) => record.fixtureId)).size / scanFixtures.length
    : 0;
  const fixtureNewsCoverage = scanFixtures.length
    ? new Set(newsArticles.flatMap((article) => article.teamTags || [])).size / Math.max(1, new Set(scanFixtures.flatMap((fixture) => [fixture.homeTeam, fixture.awayTeam])).size)
    : 0;
  const fixtureHeatCoverage = scanFixtures.length
    ? new Set(allHeatSnapshots.filter((record) => selectedFixtureIds.has(record.fixtureId)).map((record) => record.fixtureId)).size / scanFixtures.length
    : 0;
  const squadTeams = new Set(allSquadDepthRecords.map((record) => normalizeName(record.team)).filter(Boolean));
  const squadDepthCoverage = selectedTeams.size
    ? [...selectedTeams].filter((team) => squadTeams.has(team)).length / selectedTeams.size
    : 0;
  const readiness = scanFixtures.length
    && oddsRecords.length
    && teamStats.length
    && teamTwentyMatchCoverage >= 1
    ? "ready"
    : "collecting";

  return {
    readiness,
    sourceOk,
    sourceEmpty,
    sourceErrors,
    fixtureCount: scanFixtures.length,
    freshOddsRecords: oddsRecords.length,
    freshSurvivabilityOddsRecords: oddsRecords.filter(isSurvivabilityMarketRecord).length,
    freshScorerOddsRecords: oddsRecords.filter(isScorerOddsRecord).length,
    freshHeatRecords: heatRecords.length,
    freshSquadDepthRecords: squadDepthRecords.length,
    oddsHistoryRecords: allOddsSnapshots.length,
    survivabilityOddsHistoryRecords: allOddsSnapshots.filter(isSurvivabilityMarketRecord).length,
    scorerOddsHistoryRecords: allOddsSnapshots.filter(isScorerOddsRecord).length,
    heatHistoryRecords: allHeatSnapshots.length,
    squadDepthHistoryRecords: allSquadDepthRecords.length,
    playerStatsRecords: playerStats.length,
    newsArticleCount: newsArticles.length,
    teamStatsCount: teamStats.length,
    teamsWithRecentMatches,
    requiredTeamCount: selectedTeamLabels.length,
    teamsWithTwentyMatchSamples,
    teamTwentyMatchCoverage: round(teamTwentyMatchCoverage, 3),
    minimumTeamMatchSample,
    missingTwentyMatchTeams: missingTwentyMatchTeams.map((team) => ({
      team: team.team,
      matchCount: team.matchCount
    })).slice(0, 16),
    fixtureOddsCoverage: round(fixtureOddsCoverage, 3),
    fixtureHeatCoverage: round(fixtureHeatCoverage, 3),
    squadDepthCoverage: round(squadDepthCoverage, 3),
    climateProfileCoverage: round(climateProfileCoverage, 3),
    heatMemoryCoverage: round(heatMemoryCoverage, 3),
    missingClimateProfileTeams: missingClimateProfileTeams.slice(0, 16),
    missingHeatMemoryTeams: missingHeatMemoryTeams.slice(0, 16),
    fixtureNewsCoverage: round(fixtureNewsCoverage, 3),
    message: readiness === "ready"
      ? "Real public-web data was gathered and scored. Source misses are recorded instead of filled with made-up data."
      : "The database is still collecting real public-web data, including full 20-match team samples. Missing sources are visible in source health; no fake bets are generated."
  };
}

function teamMatchSampleCount(teamStats = {}) {
  return Number(
    teamStats.longForm?.matchCount
      || teamStats.sourceMatchCount
      || teamStats.formMemory?.matchCount
      || teamStats.matchCount
      || 0
  );
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

  if (risk <= 0) {
    return buildMostLikelyPolicy(basePolicy);
  }

  const appetite = risk / 100;
  const edgeAppetite = clampNumber((risk - 80) / 20, 0, 1);
  const preferredDoubleMin = 1.8 + appetite * 0.75 + edgeAppetite * 0.25;
  const preferredDoubleMax = 4.2 + appetite * 3.9 + edgeAppetite * 1.2;
  const preferredTrixieMin = 3 + appetite * 2.6 + edgeAppetite * 0.8;
  const preferredTrixieMax = 10 + appetite * 11 + edgeAppetite * 5;
  const accumulatorRanges = {
    3: {
      min: round(4 + appetite * 3 + edgeAppetite * 1, 2),
      max: round(14 + appetite * 24 + edgeAppetite * 12, 2)
    },
    4: {
      min: round(6 + appetite * 4.5 + edgeAppetite * 1.5, 2),
      max: round(24 + appetite * 42 + edgeAppetite * 24, 2)
    },
    5: {
      min: round(8 + appetite * 7 + edgeAppetite * 2, 2),
      max: round(38 + appetite * 64 + edgeAppetite * 36, 2)
    },
    6: {
      min: round(11 + appetite * 9 + edgeAppetite * 3, 2),
      max: round(58 + appetite * 92 + edgeAppetite * 50, 2)
    },
    8: {
      min: round(20 + appetite * 18 + edgeAppetite * 6, 2),
      max: round(105 + appetite * 160 + edgeAppetite * 85, 2)
    }
  };

  return {
    ...basePolicy,
    riskProfile: {
      ...(basePolicy.riskProfile || {}),
      mode: describeRisk(risk).key,
      sliderRisk: risk,
      survivabilityFirst: true,
      edgeBlend: round(edgeAppetite, 3),
      minLegEdge: round(0.03 - appetite * 0.022, 4),
      minIndependentEdge: round(0.018 - appetite * 0.012, 4),
      minLegConfidence: round(0.72 - appetite * 0.1, 4),
      minIntelligenceConfidence: round(0.64 - appetite * 0.12, 4),
      minNonMarketSignals: appetite < 0.35 ? 3 : 2,
      minLongshotModelProbability: round(0.24 - appetite * 0.035, 4),
      minLongshotSignals: appetite >= 0.72 ? 2 : 3,
      minLongshotResultEdgeForce: round(60 - appetite * 10, 2),
      maxResultLongshotDecimalOdds: round(5.5 + appetite * 1.5 + edgeAppetite * 1, 2),
      minDrawModelProbability: round(0.25 - appetite * 0.02, 4),
      maxDrawIndependentResultEdge: round(42 + appetite * 12, 2),
      minBttsYesRawProbability: round(0.51 - appetite * 0.025, 4),
      minBttsLowerTeamExpectedGoals: round(0.88 - appetite * 0.06, 4),
      maxMarketOnlySurvivalGap: round(0.16 + appetite * 0.08, 4),
      maxNegativeIndependentEdge: round(0.035 + appetite * 0.035, 4),
      allowFirstGoalscorerBets: appetite >= 0.82,
      allowAnytimeAssistBets: appetite >= 0.72,
      maxLongSlipScorerLegs: appetite >= 0.82 ? 2 : 1,
      maxLongSlipFirstScorers: appetite >= 0.95 ? 1 : 0,
      maxFavoriteImpliedProbability: round(0.82 - appetite * 0.12, 4),
      minDecimalOddsForRiskLeg: round(1.62 + appetite * 0.58 + edgeAppetite * 0.35, 2),
      minBookmakerCount: appetite < 0.22 ? 2 : 1,
      marketConfirmationWeight: round(0.34 - appetite * 0.08, 4),
      valueHuntingWeight: round(0.1 + appetite * 0.16 + edgeAppetite * 0.12, 4),
      contrarianWeight: round(0.015 + appetite * 0.08 + edgeAppetite * 0.1, 4),
      minRiskLegsForTrixie: appetite >= 0.82 ? 1 : 0,
      maxLegs: 8,
      maxCombinedOdds: round(32 + appetite * 165 + edgeAppetite * 60, 2),
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

export function buildMostLikelyPolicy(basePolicy) {
  return {
    ...basePolicy,
    riskProfile: {
      ...(basePolicy.riskProfile || {}),
      mode: "most_likely",
      minLegEdge: 0,
      minIndependentEdge: -0.025,
      minLegConfidence: 0.52,
      minIntelligenceConfidence: 0.38,
      minNonMarketSignals: 2,
      minLongshotModelProbability: 0.24,
      minLongshotSignals: 3,
      minLongshotResultEdgeForce: 54,
      maxResultLongshotDecimalOdds: 3.6,
      minDrawModelProbability: 0.24,
      maxDrawIndependentResultEdge: 42,
      minBttsYesRawProbability: 0.47,
      minBttsLowerTeamExpectedGoals: 0.78,
      maxMarketOnlySurvivalGap: 0.2,
      maxNegativeIndependentEdge: 0.055,
      allowFirstGoalscorerBets: false,
      allowAnytimeAssistBets: false,
      maxLongSlipScorerLegs: 1,
      maxLongSlipFirstScorers: 0,
      allowHighCertaintySurvivalFavorites: true,
      maxFavoriteImpliedProbability: 0.94,
      minDecimalOddsForRiskLeg: 1.01,
      minBookmakerCount: 1,
      marketConfirmationWeight: 0.22,
      valueHuntingWeight: 0.12,
      contrarianWeight: 0.04,
      minRiskLegsForTrixie: 0,
      maxLegs: 8,
      maxCombinedOdds: 1000,
      preferredCombinedOdds: {
        double: { min: 1, max: 1000 },
        trixie: { min: 1, max: 1000 },
        accumulator: { min: 1, max: 1000 },
        accumulatorByLegCount: {
          3: { min: 1, max: 1000 },
          4: { min: 1, max: 1000 },
          5: { min: 1, max: 1000 },
          6: { min: 1, max: 1000 },
          8: { min: 1, max: 1000 }
        }
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
  const start = new Date(now);
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
  const start = new Date(now);

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
  const stakePerBet = round(totalStake, 2);

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
      uncappedCombinedDecimalOdds: combo.uncappedCombinedDecimalOdds,
      fallbackCombinedOddsCap: combo.fallbackCombinedOddsCap,
      stake: stakePerBet,
      potentialReturn,
      potentialProfit: round(Math.max(0, potentialReturn - stakePerBet), 2),
      combinedProbability: combo.combinedProbability,
      expectedValue: combo.expectedValue,
      averageConfidence: combo.averageConfidence,
      averageIndependentEdge: combo.averageIndependentEdge,
      survivalCombinedProbability: combo.survivalCombinedProbability,
      averageSurvivalProbability: combo.averageSurvivalProbability,
      averageNonMarketSignalCount: combo.averageNonMarketSignalCount,
      displayRating: combo.displayRating,
      riskLegCount: combo.riskLegCount,
      bttsLegCount: combo.bttsLegCount,
      scorerLegCount: combo.scorerLegCount,
      firstScorerLegCount: combo.firstScorerLegCount,
      fragileLegCount: combo.fragileLegCount,
      shortWindowFallback: combo.shortWindowFallback,
      reusedSignalCount: combo.reusedSignalCount,
      legs: combo.legs,
      thesis: combo.thesis
    };
  });
}

function selectMostLikelyBetslip({ picks, stake }) {
  const stakePerBet = round(clampNumber(stake, 1, 100000), 2);

  return (picks || []).map((combo, index) => {
    const potentialReturn = calculatePotentialReturn(combo, stakePerBet);

    return {
      ...combo,
      rank: index + 1,
      stake: stakePerBet,
      potentialReturn,
      potentialProfit: round(Math.max(0, potentialReturn - stakePerBet), 2)
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
    return bestCombo(recommendations.doubles || [], risk);
  }

  if (category.type === "trixie") {
    return bestCombo(recommendations.trixies || [], risk);
  }

  const byLegCount = recommendations.accumulatorsByLegCount?.[category.legCount] || [];
  const fallback = (recommendations.accumulators || []).filter((combo) => Number(combo.legCount) === category.legCount);
  return bestCombo(byLegCount.length ? byLegCount : fallback, risk);
}

function bestSingleForRisk(combos, risk) {
  const appetite = clampNumber(risk, 0, 100) / 100;

  if (appetite <= 0) {
    return bestCombo(combos, 0);
  }

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
  const edgeBlend = clampNumber((appetite - 0.8) / 0.2, 0, 1);
  const highRiskPrice = edgeBlend > 0 && ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag) ? 4 * edgeBlend : 0;

  return (Number(combo.score || 0) * 0.1)
    + oddsFit * (34 - edgeBlend * 10)
    + tagFit * 14
    + comboSurvivalFit(combo, appetite) * 0.62
    + confidence * (28 - appetite * 4)
    + edge * (14 + edgeBlend * 24)
    + Math.min(8, Math.max(-4, expectedValue * 6)) * edgeBlend
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

function bestCombo(combos, risk = 50) {
  const appetite = clampNumber(risk, 0, 100) / 100;

  return [...combos].sort((left, right) => {
    return comboFit(right, appetite) - comboFit(left, appetite);
  })[0] || null;
}

function comboFit(combo, appetite) {
  const edgeBlend = clampNumber((appetite - 0.8) / 0.2, 0, 1);
  const survivalFit = comboSurvivalFit(combo, appetite);
  const expectedValue = Number(combo.expectedValue || 0);
  const independentEdge = Number(combo.averageIndependentEdge ?? combo.averageEdge ?? combo.legs?.[0]?.independentEdge ?? combo.legs?.[0]?.edge ?? 0);
  const odds = Number(combo.combinedDecimalOdds || 1);
  const legCount = Number(combo.legCount || combo.legs?.length || 1);
  const longOddsPenalty = legCount === 1
    ? Math.max(0, odds - (2.15 + appetite * 0.75 + edgeBlend * 0.45)) * (7 - edgeBlend * 2)
    : Math.max(0, Math.log(Math.max(1, odds)) - (1.2 + legCount * 0.38 + appetite * 0.35)) * (5 - edgeBlend * 1.5);

  return survivalFit
    + Number(combo.score || 0) * (0.18 - edgeBlend * 0.06)
    + independentEdge * (18 + edgeBlend * 28)
    + Math.max(-4, Math.min(8, expectedValue * 5)) * edgeBlend
    - longOddsPenalty;
}

function comboSurvivalFit(combo, appetite) {
  const survival = Number(combo.survivalCombinedProbability || combo.combinedProbability || 0);
  const averageSurvival = Number(combo.averageSurvivalProbability || combo.combinedProbability || 0);
  const confidence = Number(combo.averageConfidence || combo.legs?.[0]?.confidence || 0);
  const displayRating = Number(combo.displayRating || 0);
  const probability = Number(combo.combinedProbability || 0);
  const edgeBlend = clampNumber((appetite - 0.8) / 0.2, 0, 1);

  return survival * (110 - edgeBlend * 22)
    + averageSurvival * (34 - edgeBlend * 7)
    + probability * (24 - edgeBlend * 6)
    + confidence * 22
    + displayRating * 18;
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

function isPublicHeatRecord(record) {
  return record?.provider === "public-web" || record?.sourceType === "public-web";
}

function isSquadDepthRecord(record) {
  return record?.provider === "public-web"
    || record?.provider === "curated-profile"
    || ["public-web", "curated-profile", "curated-plus-public"].includes(record?.sourceType);
}

function isScorerOddsRecord(record) {
  return record?.market === "anytime_scorer" || record?.market === "first_goalscorer" || record?.market === "anytime_assist";
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

function isPublicPlayerStat(record) {
  return record?.sourceType === "public-web" || record?.provider === "public-web";
}

async function persistPlayerStats(statsResult) {
  const scannedTeams = new Set((statsResult.records || []).map((record) => normalizeName(record.team)).filter(Boolean));
  const existing = (await readJson(["data", "player-stats.json"], [])).filter((record) => !scannedTeams.has(normalizeName(record.team)));
  await writeJson(["data", "player-stats.json"], [...statsResult.playerStats, ...existing].slice(0, 6000));
}

function matchHistoryKey(match) {
  return `${match.date}|${normalizeName(match.homeTeam)}|${normalizeName(match.awayTeam)}|${match.homeGoals}-${match.awayGoals}`;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.max(min, Math.min(max, number));
}
