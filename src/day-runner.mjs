import { appendJsonRecords, loadEngineState, readJson, upsertJsonRecords, writeJson, writeText } from "./db.mjs";
import { fetchNewsArticles } from "./providers/news-provider.mjs";
import { fetchOddsSnapshot } from "./providers/odds-provider.mjs";
import { fetchSquadDepth } from "./providers/squad-provider.mjs";
import { fetchTeamStatsWithDiagnostics } from "./providers/stats-provider.mjs";
import { fetchHeatSnapshots } from "./providers/weather-provider.mjs";
import { buildBetRecommendations } from "./portfolio-builder.mjs";
import { rankBookmakerOffers } from "./offer-engine.mjs";
import { buildDailyReport } from "./reporting.mjs";
import { loadOutcomeLearning } from "./intelligence-memory.mjs";
import { settleStoredBetOutcomes } from "./outcome-settler.mjs";
import { buildLegCandidates } from "./scoring.mjs";
import { buildSurvivabilityMarketCoverage, isSurvivabilityMarketRecord } from "./survivability-market-coverage.mjs";
import { isoDate, makeId, normalizeName } from "./utils.mjs";

export async function runDailyCycle({ now = new Date(), forceSnapshot = false } = {}) {
  const state = await loadEngineState();
  const collection = await runSnapshotCycle({ state, now, forceSnapshot });
  const analysis = await runAnalysisCycle({ state: await loadEngineState(), now });
  const run = buildRunRecord("daily", now, {
    oddsRecordsCollected: collection.oddsRecordsCollected,
    newsRecordsCollected: collection.newsRecordsCollected,
    teamStatsCount: collection.teamStatsCount,
    recommendationCounts: {
      doubles: analysis.recommendations.doubles.length,
      trixies: analysis.recommendations.trixies.length,
      accumulators: analysis.recommendations.accumulators.length
    }
  });

  await appendJsonRecords(["data", "daily-runs.json"], [run], 1000);
  printDailySummary({ run, recommendations: analysis.recommendations, offerRanking: analysis.offerRanking });
  return { run, collection, analysis };
}

export async function runSnapshotCycle({ state, now = new Date(), forceSnapshot = false } = {}) {
  const engineState = state || await loadEngineState();
  const shouldCollectOdds = forceSnapshot || shouldTakeSnapshot(engineState.policy, now);
  const statsResult = await fetchTeamStatsWithDiagnostics({
    providerConfig: engineState.providers.stats,
    fixtures: engineState.fixtures,
    now
  });
  const teamStats = statsResult.records;
  const newsArticles = await fetchNewsArticles({
    fixtures: engineState.fixtures,
    providerConfig: engineState.providers.news,
    now
  });
  const heatRecords = await fetchHeatSnapshots({
    fixtures: engineState.fixtures,
    providerConfig: engineState.providers.weather,
    now
  });
  const squadDepthRecords = await fetchSquadDepth({
    fixtures: engineState.fixtures,
    providerConfig: engineState.providers.squadDepth,
    now
  });
  const oddsRecords = shouldCollectOdds
    ? await fetchOddsSnapshot({
      fixtures: engineState.fixtures,
      providerConfig: engineState.providers.odds,
      now
    })
    : [];

  if (oddsRecords.length) {
    await appendJsonRecords(["data", "odds-snapshots.json"], oddsRecords, 50000);
    await appendJsonRecords(["data", "snapshots", `odds-${isoDate(now)}.json`], oddsRecords, 50000);
  }

  if (newsArticles.length) {
    await upsertJsonRecords(["data", "news-articles.json"], newsArticles, (article) => article.id, 10000);
  }

  if (heatRecords.length) {
    await appendJsonRecords(["data", "heat-snapshots.json"], heatRecords, 20000);
  }

  if (squadDepthRecords.length) {
    await upsertJsonRecords(["data", "squad-depth.json"], squadDepthRecords, (record) => normalizeName(record.team), 2000);
  }

  if (teamStats.length) {
    await writeJson(["data", "team-stats.json"], teamStats);
    await writeJson(["data", "team-stats-latest.json"], {
      createdAt: now.toISOString(),
      providerMode: engineState.providers.stats?.mode || "self-gather",
      teams: teamStats
    });
  }

  if (statsResult.matchHistory?.length) {
    await upsertJsonRecords(["data", "team-match-history.json"], statsResult.matchHistory, matchHistoryKey, 12000);
  }

  if (statsResult.playerStats?.length) {
    await persistPlayerStats(statsResult);
  }

  const survivabilityMarketCoverage = buildSurvivabilityMarketCoverage({
    fixtures: engineState.fixtures,
    oddsSnapshots: [...oddsRecords, ...engineState.oddsSnapshots],
    policy: engineState.policy,
    now
  });
  await writeJson(["data", "survivability-market-coverage-latest.json"], survivabilityMarketCoverage);

  const run = buildRunRecord("snapshot", now, {
    snapshotAllowed: shouldCollectOdds,
    oddsRecordsCollected: oddsRecords.length,
    survivabilityOddsRecordsCollected: oddsRecords.filter(isSurvivabilityMarketRecord).length,
    newsRecordsCollected: newsArticles.length,
    heatRecordsCollected: heatRecords.length,
    squadDepthRecordsCollected: squadDepthRecords.length,
    teamStatsCount: teamStats.length,
    matchHistoryRecordsCollected: statsResult.matchHistory?.length || 0,
    playerStatsCollected: statsResult.playerStats?.length || 0
  });

  await appendJsonRecords(["data", "snapshot-runs.json"], [run], 1000);
  printSnapshotSummary(run);
  return run;
}

export async function runAnalysisCycle({ state, now = new Date() } = {}) {
  const engineState = state || await loadEngineState();
  const outcomeSettlement = await settleStoredBetOutcomes({ now });
  const outcomeLearning = await loadOutcomeLearning();
  const legCandidates = buildLegCandidates({
    fixtures: engineState.fixtures,
    oddsSnapshots: engineState.oddsSnapshots,
    newsArticles: engineState.newsArticles,
    teamStats: engineState.teamStats,
    policy: engineState.policy,
    now,
    outcomeLearning,
    heatSnapshots: engineState.heatSnapshots,
    squadDepthRecords: engineState.squadDepthRecords,
    playerStats: engineState.playerStats
  });
  const recommendations = buildBetRecommendations(legCandidates, engineState.policy);
  const offerRanking = rankBookmakerOffers(engineState.bookmakerOffers, engineState.policy, now);
  const survivabilityMarketCoverage = buildSurvivabilityMarketCoverage({
    fixtures: engineState.fixtures,
    oddsSnapshots: engineState.oddsSnapshots,
    policy: engineState.policy,
    now
  });
  const run = buildRunRecord("analysis", now, {
    oddsRecordsAvailable: engineState.oddsSnapshots.length,
    survivabilityOddsRecordsAvailable: engineState.oddsSnapshots.filter(isSurvivabilityMarketRecord).length,
    newsRecordsAvailable: engineState.newsArticles.length,
    teamStatsCount: engineState.teamStats.length,
    legCandidateCount: legCandidates.length,
    eligibleLegCount: recommendations.eligibleLegCount,
    outcomeRecordsSettled: outcomeSettlement.insertedCount,
    outcomeLearningCount: outcomeLearning.outcomeCount,
    recommendationCounts: {
      doubles: recommendations.doubles.length,
      trixies: recommendations.trixies.length,
      accumulators: recommendations.accumulators.length
    }
  });

  await writeJson(["data", "leg-candidates-latest.json"], legCandidates);
  await writeJson(["data", "recommendations-latest.json"], recommendations);
  await writeJson(["data", "bookmaker-offer-ranking-latest.json"], offerRanking);
  await writeJson(["data", "survivability-market-coverage-latest.json"], survivabilityMarketCoverage);
  await appendJsonRecords(["data", "recommendation-runs.json"], [run], 1000);
  await writeText(["data", "daily-report-latest.md"], buildDailyReport({
    recommendations,
    offerRanking,
    legCandidates,
    run: {
      ...run,
      oddsRecordsCollected: run.oddsRecordsAvailable,
      newsRecordsCollected: run.newsRecordsAvailable
    },
    policy: engineState.policy
  }));

  printAnalysisSummary({ run, recommendations, offerRanking });
  return { run, legCandidates, recommendations, offerRanking };
}

export async function runOfferRanking({ now = new Date() } = {}) {
  const [policy, offers] = await Promise.all([
    readJson(["config", "engine-policy.json"]),
    readJson(["data", "bookmaker-offers.json"], [])
  ]);
  const ranking = rankBookmakerOffers(offers, policy, now);
  await writeJson(["data", "bookmaker-offer-ranking-latest.json"], ranking);

  console.log("WorldCupMagic offer ranking");
  console.log("===========================");

  if (!ranking.length) {
    console.log("No bookmaker offer passed the configured policy checks.");
  } else {
    for (const offer of ranking.slice(0, 5)) {
      console.log(`${offer.rank}. ${offer.bookmaker} score=${offer.score} netPromoValue=${offer.netPromoValue}`);
    }
  }

  return ranking;
}

export async function showStatus() {
  const state = await loadEngineState();
  const recommendations = await readJson(["data", "recommendations-latest.json"], null);
  const offers = await readJson(["data", "bookmaker-offer-ranking-latest.json"], []);

  console.log("WorldCupMagic status");
  console.log("====================");
  console.log(`Fixtures: ${state.fixtures.length}`);
  console.log(`Odds snapshots: ${state.oddsSnapshots.length}`);
  console.log(`News articles: ${state.newsArticles.length}`);
  console.log(`Teams with stats: ${state.teamStats.length}`);
  console.log(`Squad depth records: ${state.squadDepthRecords.length}`);
  console.log(`Latest eligible legs: ${recommendations?.eligibleLegCount ?? "not analysed yet"}`);
  console.log(`Offer candidates passing policy: ${offers.length}`);
  console.log(`Snapshot start date: ${state.policy.snapshotStartDate}`);
}

export function shouldTakeSnapshot(policy, now = new Date()) {
  return isoDate(now) >= String(policy.snapshotStartDate || "1970-01-01");
}

function buildRunRecord(type, now, details = {}) {
  return {
    id: makeId("run", [type, now.toISOString(), JSON.stringify(details)]),
    createdAt: now.toISOString(),
    type,
    ...details
  };
}

function printSnapshotSummary(run) {
  console.log("WorldCupMagic snapshot");
  console.log("======================");
  console.log(`Snapshot allowed: ${run.snapshotAllowed ? "yes" : "no, before configured start date"}`);
  console.log(`Odds records collected: ${run.oddsRecordsCollected}`);
  console.log(`Survivability odds collected: ${run.survivabilityOddsRecordsCollected || 0}`);
  console.log(`News records collected: ${run.newsRecordsCollected}`);
  console.log(`Squad depth records collected: ${run.squadDepthRecordsCollected || 0}`);
  console.log(`Team stat records available: ${run.teamStatsCount}`);
  console.log(`20-match history records collected: ${run.matchHistoryRecordsCollected || 0}`);
  console.log(`Player scorer records collected: ${run.playerStatsCollected || 0}`);
}

function matchHistoryKey(match) {
  return `${match.date}|${normalizeName(match.homeTeam)}|${normalizeName(match.awayTeam)}|${match.homeGoals}-${match.awayGoals}`;
}

async function persistPlayerStats(statsResult) {
  const scannedTeams = new Set((statsResult.records || []).map((record) => normalizeName(record.team)).filter(Boolean));
  const existing = (await readJson(["data", "player-stats.json"], [])).filter((record) => !scannedTeams.has(normalizeName(record.team)));
  await writeJson(["data", "player-stats.json"], [...statsResult.playerStats, ...existing].slice(0, 6000));
}

function printAnalysisSummary({ run, recommendations, offerRanking }) {
  console.log("WorldCupMagic analysis");
  console.log("======================");
  console.log(`Leg candidates: ${run.legCandidateCount}; eligible=${recommendations.eligibleLegCount}`);
  console.log(`Survivability odds available: ${run.survivabilityOddsRecordsAvailable || 0}`);
  console.log(`Doubles=${recommendations.doubles.length}; Trixies=${recommendations.trixies.length}; Accumulators=${recommendations.accumulators.length}`);
  console.log(`Offer candidates passing policy: ${offerRanking.length}`);
}

function printDailySummary({ run, recommendations, offerRanking }) {
  console.log("WorldCupMagic daily cycle");
  console.log("=========================");
  console.log(`Run: ${run.id}`);
  console.log(`Odds collected: ${run.oddsRecordsCollected}; news collected: ${run.newsRecordsCollected}; teams=${run.teamStatsCount}`);
  console.log(`Top double: ${recommendations.doubles[0]?.combinedDecimalOdds || "none"} odds`);
  console.log(`Top trixie: ${recommendations.trixies[0]?.combinedDecimalOdds || "none"} odds`);
  console.log(`Top accumulator: ${recommendations.accumulators[0]?.combinedDecimalOdds || "none"} odds`);
  console.log(`Top offer: ${offerRanking[0]?.bookmaker || "none passing policy"}`);
}
