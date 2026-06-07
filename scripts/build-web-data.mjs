import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDashboardState, scanForBets, buildMostLikelyPolicy, buildRiskPolicy, describeRisk, selectBetslip, selectFixturesForWindow } from "../src/app-service.mjs";
import { loadEngineState } from "../src/db.mjs";
import { buildTeamStatsWithIntelligence, loadIntelligenceState, loadOutcomeLearning } from "../src/intelligence-memory.mjs";
import { buildBetRecommendations, buildMostLikelyPicks } from "../src/portfolio-builder.mjs";
import { buildLegCandidates } from "../src/scoring.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(rootDir, "web", "data");
const now = new Date();
const riskBuckets = Array.from({ length: 21 }, (_, index) => index * 5);
const dayBuckets = Array.from({ length: 15 }, (_, index) => index);
const automaticRunMinutesUtc = [5, 8, 11, 14, 17, 20, 23].map((hour) => (hour * 60) + 23);
const maxDaysAhead = Math.max(...dayBuckets);

await mkdir(outputDir, { recursive: true });

// One collection pass. The web app then publishes multiple risk/day views from the same evidence.
const startedAt = Date.now();
const centralScan = await scanForBets({ stake: 10, risk: 58, daysAhead: 14 }, { now, scheduled: true });
const collectionDurationMs = Date.now() - startedAt;

const [engineState, intelligenceState, outcomeLearning, dashboard] = await Promise.all([
  loadEngineState(),
  loadIntelligenceState(),
  loadOutcomeLearning(),
  getDashboardState({ now })
]);
const liveFixtures = engineState.fixtures.filter(isPublicFixture);
const liveOddsSnapshots = engineState.oddsSnapshots.filter(isPublicOddsRecord);
const liveNewsArticles = engineState.newsArticles.filter(isPublicNewsArticle);
const liveHeatSnapshots = engineState.heatSnapshots.filter(isPublicHeatRecord);
const liveSquadDepthRecords = engineState.squadDepthRecords.filter(isSquadDepthRecord);
const liveMatchHistory = intelligenceState.matchHistory.filter(isPublicMatchRecord);
const baseTeamStats = engineState.teamStats.filter(isPublicTeamStat);
const teamStats = buildTeamStatsWithIntelligence({
  baseStats: baseTeamStats,
  matchHistory: liveMatchHistory,
  teamIntelligence: intelligenceState.teamIntelligence,
  now
});
const profiles = {};
const pickOfTheDay = {};
const riskProfiles = {};
const legCandidatesByRisk = {};
const mostLikelyPolicy = buildMostLikelyPolicy(engineState.policy);
const maxRangeFixtures = selectFixturesForWindow(liveFixtures, maxDaysAhead, now);
const mostLikelyRangeLegCandidates = buildLegCandidates({
  fixtures: maxRangeFixtures,
  oddsSnapshots: liveOddsSnapshots,
  newsArticles: liveNewsArticles,
  teamStats,
  policy: mostLikelyPolicy,
  now,
  outcomeLearning,
  heatSnapshots: liveHeatSnapshots,
  squadDepthRecords: liveSquadDepthRecords
});

for (const risk of riskBuckets) {
  const policy = buildRiskPolicy(engineState.policy, risk);
  const legCandidates = buildLegCandidates({
    fixtures: maxRangeFixtures,
    oddsSnapshots: liveOddsSnapshots,
    newsArticles: liveNewsArticles,
    teamStats,
    policy,
    now,
    outcomeLearning,
    heatSnapshots: liveHeatSnapshots,
    squadDepthRecords: liveSquadDepthRecords
  });

  riskProfiles[risk] = policy.riskProfile;
  legCandidatesByRisk[risk] = legCandidates
    .filter((leg) => !leg.hardBlocks?.length)
    .map(summarizeLegCandidate);
}

for (const daysAhead of dayBuckets) {
  const scanFixtures = selectFixturesForWindow(liveFixtures, daysAhead, now);
  const mostLikelyLegCandidates = buildLegCandidates({
    fixtures: scanFixtures,
    oddsSnapshots: liveOddsSnapshots,
    newsArticles: liveNewsArticles,
    teamStats,
    policy: mostLikelyPolicy,
    now,
    outcomeLearning,
    heatSnapshots: liveHeatSnapshots,
    squadDepthRecords: liveSquadDepthRecords
  });
  const mostLikelyPicks = buildMostLikelyPicks(mostLikelyLegCandidates, mostLikelyPolicy, {
    fixtureCount: scanFixtures.length
  });

  pickOfTheDay[pickOfDayKey(daysAhead)] = {
    daysAhead,
    mode: "most_likely",
    policyMarkers: summarizePolicy(mostLikelyPolicy),
    dataQuality: centralScan.dataQuality,
    fixtureCount: scanFixtures.length,
    eligibleLegCount: mostLikelyLegCandidates.filter((leg) => !leg.hardBlocks?.length).length,
    betslip: mostLikelyPicks.map(summarizeBet)
  };

  for (const risk of riskBuckets) {
    const policy = buildRiskPolicy(engineState.policy, risk);
    const legCandidates = buildLegCandidates({
      fixtures: scanFixtures,
      oddsSnapshots: liveOddsSnapshots,
      newsArticles: liveNewsArticles,
      teamStats,
      policy,
      now,
      outcomeLearning,
      heatSnapshots: liveHeatSnapshots,
      squadDepthRecords: liveSquadDepthRecords
    });
    const recommendations = buildBetRecommendations(legCandidates, policy);
    const betslip = selectBetslip({ recommendations, stake: 10, risk });

    profiles[profileKey(daysAhead, risk)] = {
      daysAhead,
      risk,
      riskProfile: describeRisk(risk),
      policyMarkers: summarizePolicy(policy),
      dataQuality: centralScan.dataQuality,
      fixtureCount: scanFixtures.length,
      eligibleLegCount: recommendations.eligibleLegCount,
      betslip: betslip.map(summarizeBet)
    };
  }
}

const totalDurationMs = Date.now() - startedAt;
const payload = {
  generatedAt: now.toISOString(),
  edition: "github-pages",
  source: "GitHub Actions scheduled scanner",
  engine: {
    sharedCore: true,
    riskProfileGranularity: "risk values 0-100 in 5 point steps",
    daysAheadGranularity: "every day from 0 to 14",
    notes: [
      "The hosted edition uses the scheduled public-web scanner, news classifier, odds movement logic, intelligence memory, risk policy, and portfolio builder.",
      "The web app loads the published database and rebuilds the slip locally; heavy public-web gathering is handled by scheduled server-side runs."
    ]
  },
  collection: {
    durationMs: collectionDurationMs,
    durationSeconds: Math.round(collectionDurationMs / 100) / 10,
    totalBuildDurationMs: totalDurationMs,
    totalBuildDurationSeconds: Math.round(totalDurationMs / 100) / 10,
    schedule: {
      automaticRunMinutesUtc,
      gatheringWindowMinutes: 5,
      gatheringMessage: "Data Gathering: Come back in 5"
    },
    sourceHealth: centralScan.sourceHealth,
    dataQuality: centralScan.dataQuality
  },
  riskBuckets,
  dayBuckets,
  dateRange: summarizeDateRange(maxRangeFixtures, now),
  fixtures: maxRangeFixtures.map(summarizeFixture),
  riskProfiles,
  legCandidatesByRisk,
  mostLikelyLegCandidates: mostLikelyRangeLegCandidates
    .filter((leg) => !leg.hardBlocks?.length)
    .map(summarizeLegCandidate),
  dashboard: summarizeDashboard(dashboard),
  markets: summarizeMarkets(liveOddsSnapshots, engineState.policy),
  heat: summarizeHeat(liveHeatSnapshots),
  squadDepth: summarizeSquadDepth(liveSquadDepthRecords),
  pickOfTheDay,
  intelligence: {
    teamCount: intelligenceState.teamIntelligence.length,
    outcomeLearningCount: outcomeLearning.outcomeCount,
    teams: intelligenceState.teamIntelligence
  },
  profiles
};

await writeFile(join(outputDir, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Wrote ${join(outputDir, "latest.json")}`);

function profileKey(daysAhead, risk) {
  return `d${daysAhead}_r${risk}`;
}

function pickOfDayKey(daysAhead) {
  return `d${daysAhead}`;
}

function summarizeDateRange(fixtures, now) {
  const today = isoDate(now);
  const fixtureDates = fixtures
    .map((fixture) => isoDate(fixture.date))
    .sort();
  const maxFixtureDate = fixtureDates.at(-1) || today;

  return {
    min: today,
    max: maxFixtureDate,
    defaultFrom: today,
    defaultTo: maxFixtureDate
  };
}

function summarizeFixture(fixture) {
  return {
    id: fixture.id,
    date: fixture.date,
    dateKey: isoDate(fixture.date),
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    stage: fixture.stage,
    venue: fixture.venue || "",
    source: fixture.source || ""
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

function isPublicNewsArticle(article) {
  return article?.provider === "self-gather" || ["public-web", "rss", "atom", "html"].includes(article?.sourceType);
}

function isPublicTeamStat(team) {
  return team?.provider === "public-web" || team?.sourceType === "public-web";
}

function isPublicMatchRecord(match) {
  return match?.sourceType === "public-web" || match?.provider === "public-web";
}

function summarizePolicy(policy) {
  const riskProfile = policy.riskProfile || {};

  return {
    minLegEdge: riskProfile.minLegEdge,
    minLegConfidence: riskProfile.minLegConfidence,
    minIntelligenceConfidence: riskProfile.minIntelligenceConfidence,
    maxFavoriteImpliedProbability: riskProfile.maxFavoriteImpliedProbability,
    minDecimalOddsForRiskLeg: riskProfile.minDecimalOddsForRiskLeg,
    maxLegs: riskProfile.maxLegs,
    maxCombinedOdds: riskProfile.maxCombinedOdds
  };
}

function summarizeBet(bet) {
  return {
    rank: bet.rank,
    category: bet.category,
    label: bet.label,
    type: bet.type,
    score: bet.score,
    legCount: bet.legCount,
    combinedDecimalOdds: bet.combinedDecimalOdds,
    combinedProbability: bet.combinedProbability,
    stake: bet.stake,
    potentialReturn: bet.potentialReturn,
    expectedValue: bet.expectedValue,
    averageConfidence: bet.averageConfidence,
    displayRating: bet.displayRating,
    riskLegCount: bet.riskLegCount,
    thesis: bet.thesis,
    legs: bet.legs.map(summarizeLeg)
  };
}

function summarizeLeg(leg) {
  return {
    market: leg.market,
    selectionLabel: leg.selectionLabel,
    playerName: leg.playerName,
    bookmaker: leg.bookmaker,
    decimalOdds: leg.decimalOdds,
    likelyProbability: leg.likelyProbability,
    modelProbability: leg.modelProbability,
    edge: leg.edge,
    confidence: leg.confidence,
    riskTag: leg.riskTag
  };
}

function summarizeLegCandidate(leg) {
  return {
    id: leg.id,
    fixtureId: leg.fixtureId,
    fixtureDate: leg.fixtureDate,
    fixtureDateKey: isoDate(leg.fixtureDate),
    homeTeam: leg.homeTeam,
    awayTeam: leg.awayTeam,
    market: leg.market,
    outcome: leg.outcome,
    playerName: leg.playerName,
    playerTeam: leg.playerTeam,
    selectionLabel: leg.selectionLabel,
    bookmaker: leg.bookmaker,
    decimalOdds: leg.decimalOdds,
    likelyProbability: leg.likelyProbability,
    modelProbability: leg.modelProbability,
    impliedProbability: leg.impliedProbability,
    marketImpliedProbability: leg.marketImpliedProbability,
    edge: leg.edge,
    confidence: leg.confidence,
    score: leg.score,
    riskTag: leg.riskTag,
    components: {
      intelligenceConfidence: leg.components?.intelligenceConfidence,
      oddsMovement: leg.components?.oddsMovement,
      oddsShortening: leg.components?.oddsShortening,
      oddsDrifting: leg.components?.oddsDrifting,
      marketAverageOdds: leg.components?.marketAverageOdds,
      oddsFreshness: leg.components?.oddsFreshness,
      heatStress: leg.components?.heatStress,
      heatConfidence: leg.components?.heatConfidence,
      heatClimateBand: leg.components?.heatClimateBand,
      heatExpectedGoalsAdjustment: leg.components?.heatExpectedGoalsAdjustment,
      heatEdge: leg.components?.heatEdge,
      heatLocation: leg.components?.heatLocation,
      homeSquadDepth: leg.components?.homeSquadDepth,
      awaySquadDepth: leg.components?.awaySquadDepth,
      squadDepthConfidence: leg.components?.squadDepthConfidence,
      homeHistoricalHeatMemory: leg.components?.homeHistoricalHeatMemory,
      awayHistoricalHeatMemory: leg.components?.awayHistoricalHeatMemory,
      combinedHeatDifferential: leg.components?.combinedHeatDifferential
    },
    thesis: leg.thesis
  };
}

function summarizeMarkets(oddsSnapshots, policy) {
  const counts = {};

  for (const record of oddsSnapshots) {
    counts[record.market] = (counts[record.market] || 0) + 1;
  }

  return {
    configured: policy.markets || [],
    observed: counts,
    anytimeScorerRecords: counts.anytime_scorer || 0
  };
}

function summarizeHeat(heatSnapshots) {
  const locations = {};

  for (const record of heatSnapshots) {
    const key = record.location || "Unknown";
    const bucket = locations[key] || {
      records: 0,
      maxHeatStress: 0,
      maxHeatIndexC: null
    };
    bucket.records += 1;
    bucket.maxHeatStress = Math.max(bucket.maxHeatStress, Number(record.heatStress || 0));
    bucket.maxHeatIndexC = bucket.maxHeatIndexC == null
      ? record.heatIndexC
      : Math.max(Number(bucket.maxHeatIndexC || 0), Number(record.heatIndexC || 0));
    locations[key] = bucket;
  }

  return {
    recordCount: heatSnapshots.length,
    locations
  };
}

function summarizeSquadDepth(squadDepthRecords) {
  const teams = {};

  for (const record of squadDepthRecords) {
    teams[record.team] = {
      depthScore: record.depthScore,
      confidence: record.confidence,
      sourceType: record.sourceType,
      source: record.source,
      playerCount: record.playerCount || 0,
      eliteClubMentions: record.eliteClubMentions || 0,
      topLeagueMentions: record.topLeagueMentions || 0,
      clubDiversity: record.clubDiversity || 0
    };
  }

  return {
    recordCount: squadDepthRecords.length,
    publicEnhancedCount: squadDepthRecords.filter((record) => record.sourceType === "curated-plus-public" || record.sourceType === "public-web").length,
    teams
  };
}

function summarizeDashboard(dashboard) {
  return {
    now: dashboard.now,
    settings: dashboard.settings,
    stats: dashboard.stats,
    appDefaults: dashboard.appDefaults
  };
}

function isoDate(value) {
  return new Date(value).toISOString().slice(0, 10);
}
