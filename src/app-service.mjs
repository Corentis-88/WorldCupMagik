import { appendJsonRecords, loadEngineState, readJson, upsertJsonRecords, writeJson } from "./db.mjs";
import { buildScanIntelligence, buildTeamStatsWithIntelligence, loadIntelligenceState, loadOutcomeLearning, persistScanIntelligence } from "./intelligence-memory.mjs";
import { rankBookmakerOffers } from "./offer-engine.mjs";
import { buildBetRecommendations } from "./portfolio-builder.mjs";
import { fetchNewsArticles } from "./providers/news-provider.mjs";
import { fetchOddsSnapshot } from "./providers/odds-provider.mjs";
import { fetchTeamStats } from "./providers/stats-provider.mjs";
import { buildLegCandidates } from "./scoring.mjs";
import { isoDate, makeId, round } from "./utils.mjs";

const settingsPath = ["data", "app-settings.json"];

export async function getDashboardState({ now = new Date() } = {}) {
  const state = await loadEngineState();
  const settings = await loadAppSettings(state.policy);
  const [latestScan, recommendations, offers] = await Promise.all([
    readJson(["data", "app-scan-latest.json"], null),
    readJson(["data", "recommendations-latest.json"], null),
    readJson(["data", "bookmaker-offer-ranking-latest.json"], [])
  ]);

  return {
    now: now.toISOString(),
    settings,
    fixtures: selectFixturesForWindow(state.fixtures, settings.daysAhead, now),
    stats: {
      fixtureCount: state.fixtures.length,
      oddsSnapshotCount: state.oddsSnapshots.length,
      newsArticleCount: state.newsArticles.length,
      teamStatsCount: state.teamStats.length,
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
    betCount: defaults.betCount ?? 5,
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
  const fixtures = selectFixturesForWindow(engineState.fixtures, appSettings.daysAhead, now);
  const scanFixtures = fixtures.length ? fixtures : selectNextFixtures(engineState.fixtures, appSettings.betCount + 3, now);
  const baseTeamStats = await fetchTeamStats({ providerConfig: engineState.providers.stats });
  const preScanTeamStats = buildTeamStatsWithIntelligence({
    baseStats: baseTeamStats,
    matchHistory: intelligenceState.matchHistory,
    teamIntelligence: intelligenceState.teamIntelligence,
    now
  });
  const newsArticles = await fetchNewsArticles({
    fixtures: scanFixtures,
    providerConfig: engineState.providers.news,
    now
  });
  const oddsRecords = await fetchOddsSnapshot({
    fixtures: scanFixtures,
    providerConfig: engineState.providers.odds,
    now
  });

  if (oddsRecords.length) {
    await appendJsonRecords(["data", "odds-snapshots.json"], oddsRecords, 50000);
    await appendJsonRecords(["data", "snapshots", `odds-${isoDate(now)}.json`], oddsRecords, 50000);
  }

  if (newsArticles.length) {
    await upsertJsonRecords(["data", "news-articles.json"], newsArticles, (article) => article.id, 10000);
  }

  const latestState = await loadEngineState();
  const allNewsArticles = latestState.newsArticles.length ? latestState.newsArticles : newsArticles;
  const allOddsSnapshots = latestState.oddsSnapshots.length ? latestState.oddsSnapshots : oddsRecords;
  const intelligence = buildScanIntelligence({
    fixtures: scanFixtures,
    oddsRecords,
    allOddsSnapshots,
    newsArticles: allNewsArticles,
    teamStats: preScanTeamStats,
    matchHistory: intelligenceState.matchHistory,
    previousTeamIntelligence: intelligenceState.teamIntelligence,
    now
  });
  await persistScanIntelligence(intelligence);
  const teamStats = buildTeamStatsWithIntelligence({
    baseStats: baseTeamStats,
    matchHistory: intelligenceState.matchHistory,
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
    betCount: appSettings.betCount,
    risk: appSettings.risk
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
      usedFallbackNextFixtures: fixtures.length === 0
    },
    collected: {
      oddsRecords: oddsRecords.length,
      newsArticles: newsArticles.length,
      teamStats: teamStats.length,
      intelligenceObservations: intelligence.observations.length
    },
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

export function buildRiskPolicy(basePolicy, riskValue) {
  const risk = clampNumber(riskValue, 0, 100);
  const appetite = risk / 100;
  const preferredDoubleMin = 2.15 + appetite * 0.85;
  const preferredDoubleMax = 5.3 + appetite * 7.2;
  const preferredTrixieMin = 3.8 + appetite * 2.6;
  const preferredTrixieMax = 12 + appetite * 24;
  const preferredAccumulatorMin = 5.2 + appetite * 4.8;
  const preferredAccumulatorMax = 18 + appetite * 52;

  return {
    ...basePolicy,
    riskProfile: {
      ...(basePolicy.riskProfile || {}),
      mode: describeRisk(risk).key,
      minLegEdge: round(0.055 - appetite * 0.043, 4),
      minLegConfidence: round(0.69 - appetite * 0.22, 4),
      minIntelligenceConfidence: round(0.62 - appetite * 0.2, 4),
      maxFavoriteImpliedProbability: round(0.78 - appetite * 0.16, 4),
      minDecimalOddsForRiskLeg: round(1.9 + appetite * 0.85, 2),
      minBookmakerCount: appetite < 0.22 ? 2 : 1,
      marketConfirmationWeight: round(0.34 - appetite * 0.12, 4),
      valueHuntingWeight: round(0.16 + appetite * 0.22, 4),
      contrarianWeight: round(0.04 + appetite * 0.26, 4),
      minRiskLegsForTrixie: appetite >= 0.42 ? 1 : 0,
      maxLegs: appetite >= 0.72 ? 5 : appetite >= 0.42 ? 4 : 3,
      maxCombinedOdds: round(22 + appetite * 58, 2),
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
          min: round(preferredAccumulatorMin, 2),
          max: round(preferredAccumulatorMax, 2)
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
      description: "Adds price value and tactical mismatches without going full chaos mode."
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

export function selectBetslip({ recommendations, stake, betCount, risk }) {
  const count = clampNumber(betCount, 1, 12);
  const totalStake = clampNumber(stake, 1, 100000);
  const riskInfo = describeRisk(risk);
  const pools = buildOrderedPools(recommendations, riskInfo.key);
  const selected = [];
  const seen = new Set();

  for (const combo of pools) {
    if (selected.length >= count) {
      break;
    }

    const signature = combo.legs.map((leg) => leg.id).sort().join("|");

    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    selected.push(combo);
  }

  const stakePerBet = round(totalStake / Math.max(1, selected.length || count), 2);

  return selected.map((combo, index) => ({
    id: combo.id,
    rank: index + 1,
    type: combo.type,
    score: combo.score,
    legCount: combo.legCount,
    combinedDecimalOdds: combo.combinedDecimalOdds,
    stake: stakePerBet,
    potentialReturn: round(stakePerBet * Number(combo.combinedDecimalOdds || 0), 2),
    potentialProfit: round(stakePerBet * Math.max(0, Number(combo.combinedDecimalOdds || 0) - 1), 2),
    combinedProbability: combo.combinedProbability,
    expectedValue: combo.expectedValue,
    averageConfidence: combo.averageConfidence,
    riskLegCount: combo.riskLegCount,
    legs: combo.legs,
    thesis: combo.thesis
  }));
}

function buildOrderedPools(recommendations, riskKey) {
  const doubles = recommendations.doubles || [];
  const trixies = recommendations.trixies || [];
  const accumulators = recommendations.accumulators || [];

  if (riskKey === "careful") {
    return interleave([doubles, trixies, accumulators]);
  }

  if (riskKey === "balanced") {
    return interleave([doubles, trixies, doubles, accumulators]);
  }

  if (riskKey === "calculated") {
    return interleave([trixies, doubles, accumulators, trixies]);
  }

  return interleave([accumulators, trixies, doubles]);
}

function interleave(groups) {
  const result = [];
  const maxLength = Math.max(...groups.map((group) => group.length), 0);

  for (let index = 0; index < maxLength; index += 1) {
    for (const group of groups) {
      if (group[index]) {
        result.push(group[index]);
      }
    }
  }

  return result.sort((left, right) => {
    const leftScore = Number(left.score || 0) + Number(left.expectedValue || 0) * 5 + Number(left.averageConfidence || 0) * 4;
    const rightScore = Number(right.score || 0) + Number(right.expectedValue || 0) * 5 + Number(right.averageConfidence || 0) * 4;
    return rightScore - leftScore;
  });
}

function sanitizeSettings(settings) {
  return {
    stake: round(clampNumber(settings.stake, 1, 100000), 2),
    betCount: Math.round(clampNumber(settings.betCount, 1, 12)),
    risk: Math.round(clampNumber(settings.risk, 0, 100)),
    daysAhead: Math.round(clampNumber(settings.daysAhead, 0, 30))
  };
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
