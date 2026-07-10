import { appendJsonRecords, loadEngineState, readJson, upsertJsonRecords, writeJson } from "./db.mjs";
import { buildScanIntelligence, buildTeamStatsWithIntelligence, loadIntelligenceState, loadOutcomeLearning, persistScanIntelligence } from "./intelligence-memory.mjs";
import { rankBookmakerOffers } from "./offer-engine.mjs";
import { buildBetRecommendations, buildMostLikelyPicks } from "./portfolio-builder.mjs";
import { loadBettingPerformance } from "./betting-performance.mjs";
import { fetchFixturesWithDiagnostics } from "./providers/fixtures-provider.mjs";
import { fetchNewsArticlesWithDiagnostics } from "./providers/news-provider.mjs";
import { fetchOddsSnapshotWithDiagnostics } from "./providers/odds-provider.mjs";
import { filterOddsIntegrity } from "./providers/odds-integrity.mjs";
import { fetchPostMatchStatsWithDiagnostics } from "./providers/post-match-stats-provider.mjs";
import { fetchSquadDepthWithDiagnostics } from "./providers/squad-provider.mjs";
import { fetchTeamStatsWithDiagnostics } from "./providers/stats-provider.mjs";
import { fetchHeatSnapshotsWithDiagnostics } from "./providers/weather-provider.mjs";
import { settleStoredBetOutcomes } from "./outcome-settler.mjs";
import { refreshPredictionReflections } from "./prediction-reflection.mjs";
import { persistPredictionLedger } from "./prediction-ledger.mjs";
import { loadPostMatchStats, mergePostMatchStats } from "./post-match-stats.mjs";
import { buildLegCandidates } from "./scoring.mjs";
import { mergeTeamStatsRecords } from "./team-stats-store.mjs";
import { selectionBrainFit, selectionBrainMetadata } from "./selection-brain.mjs";
import { buildSurvivabilityMarketCoverage, isSurvivabilityMarketRecord } from "./survivability-market-coverage.mjs";
import { isoDate, makeId, normalizeName, product, round } from "./utils.mjs";
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
  const postMatchResult = await fetchPostMatchStatsWithDiagnostics({
    providerConfig: engineState.providers.postMatchStats,
    fixtures: liveFixtures,
    now
  });
  sourceDiagnostics.push(...postMatchResult.diagnostics);

  if (postMatchResult.records.length) {
    await upsertJsonRecords(["data", "post-match-stats.json"], postMatchResult.records, postMatchRecordKey, 2000);
  }

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
  const bettingPerformance = await loadBettingPerformance({ now });

  if (statsResult.playerStats?.length) {
    await persistPlayerStats(statsResult);
  }

  if (baseTeamStats.length) {
    const mergedTeamStats = mergeTeamStatsRecords(engineState.teamStats, baseTeamStats, { now });
    await writeJson(["data", "team-stats.json"], mergedTeamStats);
    await writeJson(["data", "team-stats-latest.json"], {
      createdAt: now.toISOString(),
      providerMode: engineState.providers.stats?.mode || "self-gather",
      teams: mergedTeamStats
    });
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
    const acceptedOdds = filterOddsIntegrity([...oddsRecords, ...existingOdds]).accepted.slice(0, 50000);
    await writeJson(["data", "odds-snapshots.json"], acceptedOdds);
    const existingDailyOdds = (await readJson(["data", "snapshots", `odds-${isoDate(now)}.json`], [])).filter(isPublicOddsRecord);
    const acceptedDailyOdds = filterOddsIntegrity([...oddsRecords, ...existingDailyOdds]).accepted.slice(0, 50000);
    await writeJson(["data", "snapshots", `odds-${isoDate(now)}.json`], acceptedDailyOdds);
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
    bettingPerformance,
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
    postMatchStats,
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
      postMatchStatsCollected: postMatchResult.records.length,
      postMatchStatsRecords: postMatchStats.length,
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
  const existingScans = await readJson(["data", "app-scans.json"], []);
  await writeJson(["data", "app-scans.json"], [
    compactAppScanHistoryRecord(scan),
    ...existingScans.map(compactAppScanHistoryRecord)
  ].slice(0, 240));

  return scan;
}

function buildDataQualitySummary({ scanFixtures, oddsRecords, allOddsSnapshots, heatRecords = [], allHeatSnapshots = [], squadDepthRecords = [], allSquadDepthRecords = [], playerStats = [], newsArticles, teamStats, postMatchStats = [], sourceDiagnostics }) {
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
  const postMatchTeamKeys = new Set(postMatchStats.flatMap((record) => [record.homeTeam, record.awayTeam]).map(normalizeName).filter(Boolean));
  const postMatchFixtureIds = new Set(postMatchStats.map((record) => record.fixtureId).filter(Boolean));
  const realEventTeamCoverage = selectedTeams.size
    ? [...selectedTeams].filter((team) => postMatchTeamKeys.has(team)).length / selectedTeams.size
    : 0;
  const teamRealMetricCoverage = teamMatchSamples.map(({ team, matchCount }) => {
    const stats = teamStatsByName.get(normalizeName(team)) || {};
    const realMatches = Number(stats.realMetricMatchCount || stats.formMemory?.realMetricMatchCount || stats.intelligenceCoverage?.realMetricMatchCount || 0);
    return {
      team,
      matchCount,
      realMatches,
      coverage: matchCount ? Math.min(1, realMatches / matchCount) : 0
    };
  });
  const teamsWithUsefulRealMetrics = teamRealMetricCoverage.filter((team) => team.realMatches >= 3 && team.coverage >= 0.15).length;
  const usefulRealMetricTeamCoverage = teamRealMetricCoverage.length
    ? teamsWithUsefulRealMetrics / teamRealMetricCoverage.length
    : 0;
  const selectedPostMatchFixtureCoverage = scanFixtures.length
    ? scanFixtures.filter((fixture) => postMatchFixtureIds.has(fixture.id)).length / scanFixtures.length
    : 0;
  const eventMetricQualities = teamStats
    .filter((team) => selectedTeams.has(normalizeName(team.team)))
    .map((team) => Number(team.eventMetricQuality || team.formMemory?.eventMetricQuality || team.intelligenceCoverage?.eventMetricQuality || 0.34));
  const averageEventMetricQuality = eventMetricQualities.length ? eventMetricQualities.reduce((total, value) => total + value, 0) / eventMetricQualities.length : 0;
  const estimatedMetricOnlyTeams = teamStats
    .filter((team) => selectedTeams.has(normalizeName(team.team)))
    .filter((team) => Number(team.realMetricMatchCount || team.formMemory?.realMetricMatchCount || team.intelligenceCoverage?.realMetricMatchCount || 0) <= 0)
    .map((team) => team.team)
    .sort();
  const playerShotCoverage = playerStats.length
    ? playerStats.filter((record) => Number(record.shots || 0) > 0 || Number(record.shotsOnTarget || 0) > 0).length / playerStats.length
    : 0;
  const playerAssistCoverage = playerStats.length
    ? playerStats.filter((record) => Number(record.assists || 0) > 0 || Number(record.assistMatches || 0) > 0).length / playerStats.length
    : 0;
  const fixtureOddsCoverage = scanFixtures.length
    ? new Set(oddsRecords.filter((record) => selectedFixtureIds.has(record.fixtureId)).map((record) => record.fixtureId)).size / scanFixtures.length
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
  const sourceFailureRate = sourceDiagnostics.length ? (sourceErrors + sourceEmpty) / sourceDiagnostics.length : 1;
  const coreReady = scanFixtures.length
    && oddsRecords.length
    && teamStats.length
    && teamTwentyMatchCoverage >= 1
    && fixtureOddsCoverage >= 0.85;
  const evidenceReady = usefulRealMetricTeamCoverage >= 0.75
    && averageEventMetricQuality >= 0.52
    && sourceFailureRate <= 0.35;
  const readiness = coreReady && evidenceReady
    ? "ready"
    : coreReady
      ? "estimated-event-data"
      : scanFixtures.length && oddsRecords.length && teamStats.length
        ? "partial"
      : "collecting";
  const marketReadiness = {
    coreResultsAndGoals: coreReady ? (evidenceReady ? "ready" : "estimated-event-data") : "partial",
    scorers: playerStats.length && fixtureOddsCoverage >= 0.85 ? "partial" : "collecting",
    assists: playerAssistCoverage >= 0.45 ? "ready" : playerAssistCoverage >= 0.15 ? "partial" : "collecting",
    playerShots: playerShotCoverage >= 0.45 ? "ready" : playerShotCoverage >= 0.15 ? "partial" : "collecting"
  };

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
    playerShotCoverage: round(playerShotCoverage, 3),
    playerAssistCoverage: round(playerAssistCoverage, 3),
    newsArticleCount: newsArticles.length,
    teamStatsCount: teamStats.length,
    postMatchStatsRecords: postMatchStats.length,
    realPostMatchTeamCoverage: round(realEventTeamCoverage, 3),
    usefulRealMetricTeamCoverage: round(usefulRealMetricTeamCoverage, 3),
    teamRealMetricCoverage: teamRealMetricCoverage.map((team) => ({
      team: team.team,
      realMatches: team.realMatches,
      matchCount: team.matchCount,
      coverage: round(team.coverage, 3)
    })),
    selectedPostMatchFixtureCoverage: round(selectedPostMatchFixtureCoverage, 3),
    averageEventMetricQuality: round(averageEventMetricQuality, 3),
    estimatedMetricOnlyTeams: estimatedMetricOnlyTeams.slice(0, 16),
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
    sourceFailureRate: round(sourceFailureRate, 3),
    marketReadiness,
    message: readiness === "ready"
      ? "Real public-web data was gathered and scored, including post-match event actuals where available."
      : readiness === "estimated-event-data"
        ? "Fixture, odds, and 20-match team samples are present, but some xG/shot inputs are still score-derived estimates and are discounted in scoring."
        : readiness === "partial"
          ? "Some fixtures have usable public evidence, but the selected range does not yet have complete fresh odds and event-quality coverage."
          : "The database is still collecting real public-web data, including full 20-match team samples. Missing sources are visible in source health."
  };
}

function compactAppScanHistoryRecord(scan = {}) {
  return {
    id: scan.id,
    createdAt: scan.createdAt,
    scheduled: Boolean(scan.scheduled),
    settings: scan.settings,
    riskProfile: scan.riskProfile,
    fixtureWindow: scan.fixtureWindow,
    collected: scan.collected,
    dataQuality: scan.dataQuality,
    sourceHealth: scan.sourceHealth,
    intelligence: scan.intelligence ? {
      teamCount: scan.intelligence.teamCount,
      observationCount: scan.intelligence.observationCount,
      outcomeLearningCount: scan.intelligence.outcomeLearningCount,
      predictionReflectionCount: scan.intelligence.predictionReflectionCount,
      lastOutcomeSettlement: scan.intelligence.lastOutcomeSettlement,
      lastPredictionReflection: scan.intelligence.lastPredictionReflection
    } : null,
    eligibleLegCount: scan.eligibleLegCount,
    betslip: (scan.betslip || []).map((bet) => ({
      id: bet.id,
      category: bet.category,
      type: bet.type,
      legCount: bet.legCount,
      combinedDecimalOdds: bet.combinedDecimalOdds,
      combinedProbability: bet.combinedProbability,
      survivalCombinedProbability: bet.survivalCombinedProbability,
      score: bet.score,
      legs: (bet.legs || []).map((leg) => ({
        id: leg.id,
        fixtureId: leg.fixtureId,
        fixtureDate: leg.fixtureDate,
        market: leg.market,
        outcome: leg.outcome,
        playerName: leg.playerName,
        bookmaker: leg.bookmaker,
        decimalOdds: leg.decimalOdds,
        modelProbability: leg.modelProbability,
        confidence: leg.confidence,
        riskTag: leg.riskTag
      }))
    }))
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
  const survivalProgress = clampNumber(risk / 80, 0, 1);
  const edgeAppetite = clampNumber((risk - 80) / 20, 0, 1);
  const preferredDoubleMin = 1.8 + survivalProgress * 0.7 + edgeAppetite * 0.35;
  const preferredDoubleMax = 4.2 + survivalProgress * 2.8 + edgeAppetite * 2;
  const preferredTrixieMin = 3 + survivalProgress * 2.2 + edgeAppetite * 1.2;
  const preferredTrixieMax = 10 + survivalProgress * 8 + edgeAppetite * 8;
  const accumulatorRanges = {
    3: {
      min: round(4 + survivalProgress * 2.5 + edgeAppetite * 1.5, 2),
      max: round(14 + survivalProgress * 18 + edgeAppetite * 18, 2)
    },
    4: {
      min: round(6 + survivalProgress * 4 + edgeAppetite * 2, 2),
      max: round(24 + survivalProgress * 32 + edgeAppetite * 34, 2)
    },
    5: {
      min: round(8 + survivalProgress * 6 + edgeAppetite * 3, 2),
      max: round(38 + survivalProgress * 48 + edgeAppetite * 52, 2)
    },
    6: {
      min: round(11 + survivalProgress * 8 + edgeAppetite * 4, 2),
      max: round(58 + survivalProgress * 68 + edgeAppetite * 74, 2)
    },
    8: {
      min: round(20 + survivalProgress * 15 + edgeAppetite * 9, 2),
      max: round(105 + survivalProgress * 115 + edgeAppetite * 130, 2)
    }
  };

  return {
    ...basePolicy,
    riskProfile: {
      ...(basePolicy.riskProfile || {}),
      mode: describeRisk(risk).key,
      sliderRisk: risk,
      survivabilityFirst: true,
      survivalProgress: round(survivalProgress, 3),
      edgeBlend: round(edgeAppetite, 3),
      minLegEdge: round(0.03 - survivalProgress * 0.012 - edgeAppetite * 0.01, 4),
      minIndependentEdge: round(0.018 - survivalProgress * 0.006 - edgeAppetite * 0.006, 4),
      minLegConfidence: round(0.74 - survivalProgress * 0.06 - edgeAppetite * 0.04, 4),
      minIntelligenceConfidence: round(0.66 - survivalProgress * 0.06 - edgeAppetite * 0.06, 4),
      minNonMarketSignals: survivalProgress < 0.55 ? 3 : 2,
      minLongshotModelProbability: round(0.24 - edgeAppetite * 0.035, 4),
      minLongshotSignals: edgeAppetite >= 0.6 ? 2 : 3,
      minLongshotResultEdgeForce: round(60 - edgeAppetite * 10, 2),
      maxResultLongshotDecimalOdds: round(5.5 + survivalProgress * 0.7 + edgeAppetite * 1.8, 2),
      minDrawModelProbability: round(0.25 - edgeAppetite * 0.02, 4),
      maxDrawIndependentResultEdge: round(42 + survivalProgress * 5 + edgeAppetite * 12, 2),
      minBttsYesRawProbability: round(0.51 - survivalProgress * 0.012 - edgeAppetite * 0.013, 4),
      minBttsLowerTeamExpectedGoals: round(0.88 - survivalProgress * 0.03 - edgeAppetite * 0.03, 4),
      maxMarketOnlySurvivalGap: round(0.16 + survivalProgress * 0.035 + edgeAppetite * 0.045, 4),
      maxNegativeIndependentEdge: round(0.035 + survivalProgress * 0.012 + edgeAppetite * 0.023, 4),
      allowFirstGoalscorerBets: edgeAppetite >= 0.1,
      allowAnytimeAssistBets: risk >= 80,
      maxLongSlipScorerLegs: edgeAppetite >= 0.1 ? 2 : 1,
      maxLongSlipFirstScorers: appetite >= 0.95 ? 1 : 0,
      maxFavoriteImpliedProbability: round(0.82 - survivalProgress * 0.07 - edgeAppetite * 0.05, 4),
      minDecimalOddsForRiskLeg: round(1.62 + survivalProgress * 0.35 + edgeAppetite * 0.58, 2),
      minBookmakerCount: survivalProgress < 0.3 ? 2 : 1,
      marketConfirmationWeight: round(0.34 - survivalProgress * 0.05 - edgeAppetite * 0.03, 4),
      valueHuntingWeight: round(0.1 + survivalProgress * 0.08 + edgeAppetite * 0.2, 4),
      contrarianWeight: round(0.015 + survivalProgress * 0.025 + edgeAppetite * 0.155, 4),
      minRiskLegsForTrixie: edgeAppetite >= 0.1 ? 1 : 0,
      maxLegs: 8,
      maxCombinedOdds: round(32 + survivalProgress * 88 + edgeAppetite * 137, 2),
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
  end.setDate(end.getDate() + clampNumber(daysAhead, 0, 60) + 1);

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
    const truthfulCombo = comboWithTruthfulOdds(combo);
    const potentialReturn = truthfulCombo.directlyPlaceable ? calculatePotentialReturn(truthfulCombo, stakePerBet) : null;
    const selection = selectionBrainMetadata(truthfulCombo, { risk, category });

    return {
      id: truthfulCombo.id,
      rank: index + 1,
      category: category.key,
      label: category.label,
      type: truthfulCombo.type,
      score: truthfulCombo.score,
      legCount: truthfulCombo.legCount,
      combinedDecimalOdds: truthfulCombo.combinedDecimalOdds,
      stake: stakePerBet,
      potentialReturn,
      potentialProfit: potentialReturn === null ? null : round(Math.max(0, potentialReturn - stakePerBet), 2),
      returnStatus: truthfulCombo.directlyPlaceable ? "executable" : "research_only",
      combinedProbability: truthfulCombo.combinedProbability,
      expectedValue: truthfulCombo.expectedValue,
      averageConfidence: truthfulCombo.averageConfidence,
      averageIndependentEdge: truthfulCombo.averageIndependentEdge,
      survivalCombinedProbability: truthfulCombo.survivalCombinedProbability,
      averageSurvivalProbability: truthfulCombo.averageSurvivalProbability,
      averageNonMarketSignalCount: truthfulCombo.averageNonMarketSignalCount,
      displayRating: truthfulCombo.displayRating,
      riskLegCount: truthfulCombo.riskLegCount,
      bttsLegCount: truthfulCombo.bttsLegCount,
      scorerLegCount: truthfulCombo.scorerLegCount,
      firstScorerLegCount: truthfulCombo.firstScorerLegCount,
      fragileLegCount: truthfulCombo.fragileLegCount,
      correlationPenalty: truthfulCombo.correlationPenalty,
      correlationReasons: truthfulCombo.correlationReasons,
      marketFamilyMix: truthfulCombo.marketFamilyMix,
      repeatedTeamCount: truthfulCombo.repeatedTeamCount,
      sameDateCluster: truthfulCombo.sameDateCluster,
      shortWindowFallback: truthfulCombo.shortWindowFallback,
      bestAvailableFallback: truthfulCombo.bestAvailableFallback,
      reusedSignalCount: truthfulCombo.reusedSignalCount,
      placeabilityStatus: truthfulCombo.placeabilityStatus,
      directlyPlaceable: truthfulCombo.directlyPlaceable,
      placeableBookmaker: truthfulCombo.placeableBookmaker,
      bookmakerKey: truthfulCombo.bookmakerKey,
      sourceBookmakers: truthfulCombo.sourceBookmakers,
      sourcePublishers: truthfulCombo.sourcePublishers,
      placeabilityReason: truthfulCombo.placeabilityReason,
      selectionIntent: selection.selectionIntent,
      recommendedUse: selection.recommendedUse,
      selectionQuality: selection.selectionQuality,
      selectionBrainScore: selection.selectionBrainScore,
      cashScore: selection.cashScore,
      freeBetScore: selection.freeBetScore,
      longshotScore: selection.longshotScore,
      freeBetConversion: selection.freeBetConversion,
      probabilityRange: selection.probabilityRange,
      portfolioWarnings: selection.portfolioWarnings,
      legs: truthfulCombo.legs,
      thesis: truthfulCombo.thesis
    };
  });
}

function selectMostLikelyBetslip({ picks, stake }) {
  const stakePerBet = round(clampNumber(stake, 1, 100000), 2);

  return (picks || []).map((combo, index) => {
    const truthfulCombo = comboWithTruthfulOdds(combo);
    const potentialReturn = truthfulCombo.directlyPlaceable ? calculatePotentialReturn(truthfulCombo, stakePerBet) : null;
    const category = categoryForCombo(truthfulCombo);
    const selection = selectionBrainMetadata(truthfulCombo, { risk: 0, category });

    return {
      ...truthfulCombo,
      rank: index + 1,
      stake: stakePerBet,
      potentialReturn,
      potentialProfit: potentialReturn === null ? null : round(Math.max(0, potentialReturn - stakePerBet), 2),
      returnStatus: truthfulCombo.directlyPlaceable ? "executable" : "research_only",
      selectionIntent: selection.selectionIntent,
      recommendedUse: selection.recommendedUse,
      selectionQuality: selection.selectionQuality,
      selectionBrainScore: selection.selectionBrainScore,
      cashScore: selection.cashScore,
      freeBetScore: selection.freeBetScore,
      longshotScore: selection.longshotScore,
      freeBetConversion: selection.freeBetConversion,
      probabilityRange: selection.probabilityRange,
      portfolioWarnings: selection.portfolioWarnings
    };
  });
}

function categoryForCombo(combo = {}) {
  return STANDARD_BET_TYPES.find((category) => {
    if (category.type !== combo.type) {
      return false;
    }

    if (category.type === "single" || category.type === "double" || category.type === "trixie") {
      return true;
    }

    return Number(category.legCount) === Number(combo.legCount);
  }) || {
    key: combo.type,
    label: combo.type,
    type: combo.type,
    legCount: Number(combo.legCount || combo.legs?.length || 1)
  };
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
    return bestSingleForRisk(recommendations.singles || [], risk, category);
  }

  if (category.type === "double") {
    return bestCombo(recommendations.doubles || [], risk, category);
  }

  if (category.type === "trixie") {
    return bestCombo(recommendations.trixies || [], risk, category);
  }

  const byLegCount = recommendations.accumulatorsByLegCount?.[category.legCount] || [];
  const fallback = (recommendations.accumulators || []).filter((combo) => Number(combo.legCount) === category.legCount);
  return bestCombo(byLegCount.length ? byLegCount : fallback, risk, category);
}

function bestSingleForRisk(combos, risk, category = {}) {
  const appetite = clampNumber(risk, 0, 100) / 100;

  if (appetite <= 0) {
    return bestCombo(combos, 0, category);
  }

  const survivalProgress = clampNumber(risk / 80, 0, 1);
  const edgeBlend = clampNumber((risk - 80) / 20, 0, 1);
  const targetOdds = 1.45 + survivalProgress * 1.1 + edgeBlend * 1.25;
  const targetRisk = survivalProgress * 1.5 + edgeBlend * 1.5;

  return [...combos].sort((left, right) => {
    return singleRiskFit(right, targetOdds, targetRisk, appetite, risk, category) - singleRiskFit(left, targetOdds, targetRisk, appetite, risk, category);
  })[0] || null;
}

function singleRiskFit(combo, targetOdds, targetRisk, appetite, risk, category = {}) {
  const leg = combo.legs?.[0] || {};
  const odds = Number(combo.combinedDecimalOdds || leg.decimalOdds || 1);
  const confidence = Number(combo.averageConfidence || leg.confidence || 0);
  const edge = Number(combo.averageEdge || leg.edge || 0);
  const expectedValue = Number(combo.expectedValue || 0);
  const oddsFit = Math.max(0, 1 - Math.abs(Math.log(Math.max(1.01, odds) / targetOdds)) / 0.78);
  const tagFit = Math.max(0, 1 - Math.abs(riskTagLevel(leg.riskTag) - targetRisk) / 3);
  const lowRiskStability = appetite < 0.38 && ["steady_edge", "value_favourite", "market_confirmed_edge"].includes(leg.riskTag) ? 9 : 0;
  const survivalProgress = clampNumber(risk / 80, 0, 1);
  const edgeBlend = clampNumber((risk - 80) / 20, 0, 1);
  const highRiskPrice = edgeBlend > 0 && ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag) ? 4 * edgeBlend : 0;

  const baseFit = (Number(combo.score || 0) * 0.1)
    + oddsFit * (18 + survivalProgress * 12 + edgeBlend * 8)
    + tagFit * (8 + survivalProgress * 5)
    + comboSurvivalFit(combo) * (0.84 - survivalProgress * 0.14 - edgeBlend * 0.16)
    + confidence * (24 - survivalProgress * 3)
    + edge * edgeBlend * 38
    + Math.min(8, Math.max(-4, expectedValue * 6)) * edgeBlend
    + lowRiskStability
    + highRiskPrice;

  return baseFit + selectionBrainFit(combo, { risk, category }) * 0.18;
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

function bestCombo(combos, risk = 50, category = {}) {
  const appetite = clampNumber(risk, 0, 100) / 100;

  return [...combos].sort((left, right) => {
    return comboSelectionFit(right, appetite, risk, category) - comboSelectionFit(left, appetite, risk, category);
  })[0] || null;
}

function comboSelectionFit(combo, appetite, risk, category = {}) {
  const survivalProgress = clampNumber(risk / 80, 0, 1);
  const edgeBlend = clampNumber((risk - 80) / 20, 0, 1);
  return comboFit(combo, appetite, risk) * (0.78 - survivalProgress * 0.16 - edgeBlend * 0.14)
    + selectionBrainFit(combo, { risk, category }) * (0.22 + survivalProgress * 0.16 + edgeBlend * 0.14);
}

function comboFit(combo, appetite, risk = appetite * 100) {
  const survivalProgress = clampNumber(risk / 80, 0, 1);
  const edgeBlend = clampNumber((risk - 80) / 20, 0, 1);
  const survivalFit = comboSurvivalFit(combo);
  const expectedValue = Number(combo.expectedValue || 0);
  const independentEdge = Number(combo.averageIndependentEdge ?? combo.averageEdge ?? combo.legs?.[0]?.independentEdge ?? combo.legs?.[0]?.edge ?? 0);
  const odds = Number(combo.combinedDecimalOdds || 1);
  const legCount = Number(combo.legCount || combo.legs?.length || 1);
  const targetPerLegOdds = 1.42 + survivalProgress * 0.42 + edgeBlend * 0.5;
  const targetOdds = legCount === 1 ? targetPerLegOdds : Math.pow(targetPerLegOdds, legCount);
  const progressiveOddsFit = clampNumber(1 - Math.abs(Math.log(Math.max(1.01, odds) / targetOdds)) / 1.15, 0, 1);
  const longOddsPenalty = Math.max(0, Math.log(Math.max(1, odds / targetOdds))) * (7 - edgeBlend * 2);

  return survivalFit * (0.9 - survivalProgress * 0.12 - edgeBlend * 0.16)
    + progressiveOddsFit * (8 + survivalProgress * 14 + edgeBlend * 10)
    + Number(combo.score || 0) * (0.14 - edgeBlend * 0.03)
    + independentEdge * edgeBlend * 46
    + Math.max(-4, Math.min(8, expectedValue * 5)) * edgeBlend
    - longOddsPenalty;
}

function comboSurvivalFit(combo) {
  const survival = Number(combo.survivalCombinedProbability || combo.combinedProbability || 0);
  const averageSurvival = Number(combo.averageSurvivalProbability || combo.combinedProbability || 0);
  const confidence = Number(combo.averageConfidence || combo.legs?.[0]?.confidence || 0);
  const displayRating = Number(combo.displayRating || 0);
  const probability = Number(combo.combinedProbability || 0);

  return survival * 110
    + averageSurvival * 34
    + probability * 24
    + confidence * 22
    + displayRating * 18;
}

function calculatePotentialReturn(combo, stake) {
  if (combo.type !== "trixie" || combo.legs.length !== 3) {
    return round(stake * product(combo.legs.map((leg) => Number(leg.decimalOdds))), 2);
  }

  const odds = combo.legs.map((leg) => Number(leg.decimalOdds || 1));
  const unit = stake / 4;
  const doubleReturns = (odds[0] * odds[1]) + (odds[0] * odds[2]) + (odds[1] * odds[2]);
  const trebleReturn = odds[0] * odds[1] * odds[2];
  return round(unit * (doubleReturns + trebleReturn), 2);
}

function comboWithTruthfulOdds(combo = {}) {
  const legs = combo.legs || [];
  const combinedDecimalOdds = round(product(legs.map((leg) => Number(leg.decimalOdds))), 6);
  const combinedProbability = Number(combo.combinedProbability || 0);
  const { uncappedCombinedDecimalOdds: _uncapped, fallbackCombinedOddsCap: _cap, ...rest } = combo;

  return {
    ...rest,
    combinedDecimalOdds,
    expectedValue: round(combinedProbability * combinedDecimalOdds - 1, 4)
  };
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

function postMatchRecordKey(record) {
  if (record.sourceGameId) {
    return `fox:${record.sourceGameId}`;
  }

  if (record.fixtureId) {
    return `fixture:${record.fixtureId}`;
  }

  return matchHistoryKey(record);
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return min;
  }

  return Math.max(min, Math.min(max, number));
}
