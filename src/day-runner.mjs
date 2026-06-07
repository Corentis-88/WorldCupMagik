import { appendJsonRecords, loadEngineState, readJson, upsertJsonRecords, writeJson, writeText } from "./db.mjs";
import { fetchNewsArticles } from "./providers/news-provider.mjs";
import { fetchOddsSnapshot } from "./providers/odds-provider.mjs";
import { fetchTeamStats } from "./providers/stats-provider.mjs";
import { buildBetRecommendations } from "./portfolio-builder.mjs";
import { rankBookmakerOffers } from "./offer-engine.mjs";
import { buildDailyReport } from "./reporting.mjs";
import { buildLegCandidates } from "./scoring.mjs";
import { isoDate, makeId } from "./utils.mjs";

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
  const teamStats = await fetchTeamStats({ providerConfig: engineState.providers.stats });
  const newsArticles = await fetchNewsArticles({
    fixtures: engineState.fixtures,
    providerConfig: engineState.providers.news,
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

  if (teamStats.length) {
    await writeJson(["data", "team-stats-latest.json"], {
      createdAt: now.toISOString(),
      providerMode: engineState.providers.stats?.mode || "mock",
      teams: teamStats
    });
  }

  const run = buildRunRecord("snapshot", now, {
    snapshotAllowed: shouldCollectOdds,
    oddsRecordsCollected: oddsRecords.length,
    newsRecordsCollected: newsArticles.length,
    teamStatsCount: teamStats.length
  });

  await appendJsonRecords(["data", "snapshot-runs.json"], [run], 1000);
  printSnapshotSummary(run);
  return run;
}

export async function runAnalysisCycle({ state, now = new Date() } = {}) {
  const engineState = state || await loadEngineState();
  const legCandidates = buildLegCandidates({
    fixtures: engineState.fixtures,
    oddsSnapshots: engineState.oddsSnapshots,
    newsArticles: engineState.newsArticles,
    teamStats: engineState.teamStats,
    policy: engineState.policy,
    now
  });
  const recommendations = buildBetRecommendations(legCandidates, engineState.policy);
  const offerRanking = rankBookmakerOffers(engineState.bookmakerOffers, engineState.policy, now);
  const run = buildRunRecord("analysis", now, {
    oddsRecordsAvailable: engineState.oddsSnapshots.length,
    newsRecordsAvailable: engineState.newsArticles.length,
    teamStatsCount: engineState.teamStats.length,
    legCandidateCount: legCandidates.length,
    eligibleLegCount: recommendations.eligibleLegCount,
    recommendationCounts: {
      doubles: recommendations.doubles.length,
      trixies: recommendations.trixies.length,
      accumulators: recommendations.accumulators.length
    }
  });

  await writeJson(["data", "leg-candidates-latest.json"], legCandidates);
  await writeJson(["data", "recommendations-latest.json"], recommendations);
  await writeJson(["data", "bookmaker-offer-ranking-latest.json"], offerRanking);
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
  console.log(`News records collected: ${run.newsRecordsCollected}`);
  console.log(`Team stat records available: ${run.teamStatsCount}`);
}

function printAnalysisSummary({ run, recommendations, offerRanking }) {
  console.log("WorldCupMagic analysis");
  console.log("======================");
  console.log(`Leg candidates: ${run.legCandidateCount}; eligible=${recommendations.eligibleLegCount}`);
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
