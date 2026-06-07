import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDashboardState, scanForBets, buildRiskPolicy, describeRisk, selectBetslip, selectFixturesForWindow } from "../src/app-service.mjs";
import { loadEngineState } from "../src/db.mjs";
import { buildTeamStatsWithIntelligence, loadIntelligenceState, loadOutcomeLearning } from "../src/intelligence-memory.mjs";
import { buildBetRecommendations } from "../src/portfolio-builder.mjs";
import { buildLegCandidates } from "../src/scoring.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(rootDir, "web", "data");
const now = new Date();
const riskBuckets = Array.from({ length: 21 }, (_, index) => index * 5);
const dayBuckets = Array.from({ length: 15 }, (_, index) => index);
const automaticRunMinutesUtc = [5, 8, 11, 14, 17, 20, 23].map((hour) => (hour * 60) + 23);

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
const liveMatchHistory = intelligenceState.matchHistory.filter(isPublicMatchRecord);
const baseTeamStats = engineState.teamStats.filter(isPublicTeamStat);
const teamStats = buildTeamStatsWithIntelligence({
  baseStats: baseTeamStats,
  matchHistory: liveMatchHistory,
  teamIntelligence: intelligenceState.teamIntelligence,
  now
});
const profiles = {};

for (const daysAhead of dayBuckets) {
  const scanFixtures = selectFixturesForWindow(liveFixtures, daysAhead, now);

  for (const risk of riskBuckets) {
    const policy = buildRiskPolicy(engineState.policy, risk);
    const legCandidates = buildLegCandidates({
      fixtures: scanFixtures,
      oddsSnapshots: liveOddsSnapshots,
      newsArticles: liveNewsArticles,
      teamStats,
      policy,
      now,
      outcomeLearning
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
      "The hosted edition uses the central public-web scanner, news classifier, odds movement logic, intelligence memory, risk policy, and portfolio builder.",
      "The web Scan button reloads this published database and rebuilds the slip locally; heavy public-web gathering is handled by scheduled server-side runs."
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
  dashboard: summarizeDashboard(dashboard),
  markets: summarizeMarkets(liveOddsSnapshots, engineState.policy),
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

function isPublicFixture(fixture) {
  return fixture?.sourceType === "public-web" || fixture?.provider === "public-web";
}

function isPublicOddsRecord(record) {
  return record?.provider === "public-web" || record?.sourceType === "public-web";
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
    stake: bet.stake,
    potentialReturn: bet.potentialReturn,
    expectedValue: bet.expectedValue,
    averageConfidence: bet.averageConfidence,
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
    edge: leg.edge,
    confidence: leg.confidence,
    riskTag: leg.riskTag
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

function summarizeDashboard(dashboard) {
  return {
    now: dashboard.now,
    settings: dashboard.settings,
    stats: dashboard.stats,
    appDefaults: dashboard.appDefaults
  };
}
