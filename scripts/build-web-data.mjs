import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDashboardState, scanForBets, buildRiskPolicy, describeRisk, selectBetslip, selectFixturesForWindow, selectNextFixtures } from "../src/app-service.mjs";
import { loadEngineState } from "../src/db.mjs";
import { buildTeamStatsWithIntelligence, loadIntelligenceState, loadOutcomeLearning } from "../src/intelligence-memory.mjs";
import { buildBetRecommendations } from "../src/portfolio-builder.mjs";
import { fetchTeamStats } from "../src/providers/stats-provider.mjs";
import { buildLegCandidates } from "../src/scoring.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(rootDir, "web", "data");
const now = new Date();
const riskBuckets = Array.from({ length: 21 }, (_, index) => index * 5);
const dayBuckets = Array.from({ length: 15 }, (_, index) => index);

await mkdir(outputDir, { recursive: true });

// One collection pass. The web app then publishes multiple risk/day views from the same evidence.
await scanForBets({ stake: 10, betCount: 12, risk: 58, daysAhead: 14 }, { now, scheduled: true });

const [engineState, intelligenceState, outcomeLearning, dashboard] = await Promise.all([
  loadEngineState(),
  loadIntelligenceState(),
  loadOutcomeLearning(),
  getDashboardState({ now })
]);
const baseTeamStats = await fetchTeamStats({ providerConfig: engineState.providers.stats });
const teamStats = buildTeamStatsWithIntelligence({
  baseStats: baseTeamStats,
  matchHistory: intelligenceState.matchHistory,
  teamIntelligence: intelligenceState.teamIntelligence,
  now
});
const profiles = {};

for (const daysAhead of dayBuckets) {
  const fixtures = selectFixturesForWindow(engineState.fixtures, daysAhead, now);
  const scanFixtures = fixtures.length ? fixtures : selectNextFixtures(engineState.fixtures, 8, now);

  for (const risk of riskBuckets) {
    const policy = buildRiskPolicy(engineState.policy, risk);
    const legCandidates = buildLegCandidates({
      fixtures: scanFixtures,
      oddsSnapshots: engineState.oddsSnapshots,
      newsArticles: engineState.newsArticles,
      teamStats,
      policy,
      now,
      outcomeLearning
    });
    const recommendations = buildBetRecommendations(legCandidates, policy);
    const betslip = selectBetslip({ recommendations, stake: 10, betCount: 12, risk });

    profiles[profileKey(daysAhead, risk)] = {
      daysAhead,
      risk,
      riskProfile: describeRisk(risk),
      policyMarkers: summarizePolicy(policy),
      fixtureCount: scanFixtures.length,
      eligibleLegCount: recommendations.eligibleLegCount,
      betslip: betslip.map(summarizeBet)
    };
  }
}

const payload = {
  generatedAt: now.toISOString(),
  edition: "github-pages",
  source: "GitHub Actions scheduled scanner",
  engine: {
    sharedCore: true,
    riskProfileGranularity: "risk values 0-100 in 5 point steps",
    daysAheadGranularity: "every day from 0 to 14",
    notes: [
      "The hosted edition uses the same scanner, news classifier, odds movement logic, intelligence memory, risk policy, and portfolio builder as the Windows app.",
      "Chromebooks read the latest central GitHub scan; Windows PCs can also maintain private local memory in the tray app."
    ]
  },
  riskBuckets,
  dayBuckets,
  dashboard: summarizeDashboard(dashboard),
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
    selectionLabel: leg.selectionLabel,
    bookmaker: leg.bookmaker,
    decimalOdds: leg.decimalOdds,
    edge: leg.edge,
    confidence: leg.confidence,
    riskTag: leg.riskTag
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
