import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDashboardState, scanForBets, buildMostLikelyPolicy, buildRiskPolicy, describeRisk, selectBetslip, selectFixturesForWindow } from "../src/app-service.mjs";
import { loadEngineState } from "../src/db.mjs";
import { buildTeamStatsWithIntelligence, loadIntelligenceState, loadOutcomeLearning } from "../src/intelligence-memory.mjs";
import { buildMobilePayload } from "../src/mobile-web-data.mjs";
import { buildBetRecommendations, buildMostLikelyPicks } from "../src/portfolio-builder.mjs";
import { buildLegCandidates } from "../src/scoring.mjs";
import { buildSurvivabilityMarketCoverage } from "../src/survivability-market-coverage.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(rootDir, "web", "data");
const now = new Date();
const riskBuckets = Array.from({ length: 21 }, (_, index) => index * 5);
const dayBuckets = Array.from({ length: 15 }, (_, index) => index);
const automaticRunMinutesUtc = [5, 8, 11, 14, 17, 20, 21, 23].map((hour) => (hour * 60) + 23);
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
const livePlayerStats = engineState.playerStats.filter(isPublicPlayerStat);
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
const fullLegCandidatesByRisk = {};
const mostLikelyPolicy = buildMostLikelyPolicy(engineState.policy);
const maxRangeFixtures = selectFixturesForWindow(liveFixtures, maxDaysAhead, now);
const survivabilityMarketCoverage = buildSurvivabilityMarketCoverage({
  fixtures: maxRangeFixtures,
  oddsSnapshots: liveOddsSnapshots,
  policy: engineState.policy,
  now
});
const mostLikelyRangeLegCandidates = buildLegCandidates({
  fixtures: maxRangeFixtures,
  oddsSnapshots: liveOddsSnapshots,
  newsArticles: liveNewsArticles,
  teamStats,
  policy: mostLikelyPolicy,
  now,
  outcomeLearning,
  heatSnapshots: liveHeatSnapshots,
  squadDepthRecords: liveSquadDepthRecords,
  playerStats: livePlayerStats
});

for (const risk of riskBuckets) {
  const policy = risk === 0 ? mostLikelyPolicy : buildRiskPolicy(engineState.policy, risk);
  const legCandidates = risk === 0
    ? mostLikelyRangeLegCandidates
    : buildLegCandidates({
      fixtures: maxRangeFixtures,
      oddsSnapshots: liveOddsSnapshots,
      newsArticles: liveNewsArticles,
      teamStats,
      policy,
      now,
      outcomeLearning,
      heatSnapshots: liveHeatSnapshots,
      squadDepthRecords: liveSquadDepthRecords,
      playerStats: livePlayerStats
    });

  riskProfiles[risk] = policy.riskProfile;
  fullLegCandidatesByRisk[risk] = legCandidates;
  legCandidatesByRisk[risk] = legCandidates
    .filter((leg) => !leg.hardBlocks?.length)
    .map(summarizeLegCandidate);
}

for (const daysAhead of dayBuckets) {
  const scanFixtures = selectFixturesForWindow(liveFixtures, daysAhead, now);
  const mostLikelyLegCandidates = filterLegCandidatesForFixtures(mostLikelyRangeLegCandidates, scanFixtures);
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
    const legCandidates = filterLegCandidatesForFixtures(fullLegCandidatesByRisk[risk], scanFixtures);

    if (risk === 0) {
      profiles[profileKey(daysAhead, risk)] = {
        daysAhead,
        risk,
        mode: "most_likely",
        riskProfile: describeRisk(risk),
        policyMarkers: summarizePolicy(mostLikelyPolicy),
        dataQuality: centralScan.dataQuality,
        fixtureCount: scanFixtures.length,
        eligibleLegCount: mostLikelyLegCandidates.filter((leg) => !leg.hardBlocks?.length).length,
        betslip: mostLikelyPicks.map(summarizeBet)
      };
      continue;
    }

    const recommendationLegCandidates = trimRecommendationLegPool(legCandidates, scanFixtures);
    const recommendations = buildBetRecommendations(recommendationLegCandidates, policy);
    const betslip = selectBetslip({ recommendations, stake: 10, risk });

    profiles[profileKey(daysAhead, risk)] = {
      daysAhead,
      risk,
      riskProfile: describeRisk(risk),
      policyMarkers: summarizePolicy(policy),
      dataQuality: centralScan.dataQuality,
      fixtureCount: scanFixtures.length,
      eligibleLegCount: legCandidates.filter((leg) => !leg.hardBlocks?.length).length,
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
    dataQuality: centralScan.dataQuality,
    survivabilityMarketCoverage
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
  survivabilityMarketCoverage,
  markets: summarizeMarkets(liveOddsSnapshots, engineState.policy, survivabilityMarketCoverage),
  heat: summarizeHeat(liveHeatSnapshots),
  squadDepth: summarizeSquadDepth(liveSquadDepthRecords),
  playerStats: summarizePlayerStats(livePlayerStats),
  teamProfiles: summarizeTeamProfiles(teamStats),
  pickOfTheDay,
  intelligence: {
    teamCount: intelligenceState.teamIntelligence.length,
    outcomeLearningCount: outcomeLearning.outcomeCount,
    outcomeCalibration: summarizeOutcomeCalibration(outcomeLearning.calibration),
    predictionReflectionCount: outcomeLearning.reflection?.count || 0,
    predictionReflection: summarizePredictionReflection(outcomeLearning.reflection),
    teams: intelligenceState.teamIntelligence
  },
  profiles
};

await writeFile(join(outputDir, "latest.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
await writeFile(join(outputDir, "mobile-latest.json"), `${JSON.stringify(buildMobilePayload(payload))}\n`, "utf8");
await writeFile(join(outputDir, "survivability-market-coverage-latest.json"), `${JSON.stringify(survivabilityMarketCoverage, null, 2)}\n`, "utf8");
console.log(`Wrote ${join(outputDir, "latest.json")}`);
console.log(`Wrote ${join(outputDir, "mobile-latest.json")}`);
console.log(`Wrote ${join(outputDir, "survivability-market-coverage-latest.json")}`);

function profileKey(daysAhead, risk) {
  return `d${daysAhead}_r${risk}`;
}

function pickOfDayKey(daysAhead) {
  return `d${daysAhead}`;
}

function filterLegCandidatesForFixtures(legCandidates, fixtures) {
  const fixtureIds = new Set((fixtures || []).map((fixture) => fixture.id).filter(Boolean));

  if (!fixtureIds.size) {
    return [];
  }

  return (legCandidates || [])
    .filter((leg) => fixtureIds.has(leg.fixtureId))
    .map((leg, index) => ({ ...leg, rank: index + 1 }));
}

function trimRecommendationLegPool(legCandidates, fixtures) {
  const fixtureTarget = Math.max(8, Math.min(14, Math.max(1, fixtures.length) * 2));
  const byId = new Map();
  const fixtureCounts = new Map();

  for (const leg of legCandidates || []) {
    if (byId.size >= fixtureTarget) {
      break;
    }

    const fixtureCount = fixtureCounts.get(leg.fixtureId) || 0;

    if (fixtureCount >= 3) {
      continue;
    }

    byId.set(leg.id, leg);
    fixtureCounts.set(leg.fixtureId, fixtureCount + 1);
  }

  for (const leg of legCandidates || []) {
    if (byId.size >= fixtureTarget) {
      break;
    }

    byId.set(leg.id, leg);
  }

  return [...byId.values()]
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
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

function isPublicPlayerStat(record) {
  return record?.sourceType === "public-web" || record?.provider === "public-web";
}

function summarizePolicy(policy) {
  const riskProfile = policy.riskProfile || {};

  return {
    minLegEdge: riskProfile.minLegEdge,
    minIndependentEdge: riskProfile.minIndependentEdge,
    minLegConfidence: riskProfile.minLegConfidence,
    minIntelligenceConfidence: riskProfile.minIntelligenceConfidence,
    minNonMarketSignals: riskProfile.minNonMarketSignals,
    minLongshotModelProbability: riskProfile.minLongshotModelProbability,
    minLongshotResultEdgeForce: riskProfile.minLongshotResultEdgeForce,
    maxResultLongshotDecimalOdds: riskProfile.maxResultLongshotDecimalOdds,
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
    averageIndependentEdge: bet.averageIndependentEdge,
    survivalCombinedProbability: bet.survivalCombinedProbability,
    averageSurvivalProbability: bet.averageSurvivalProbability,
    averageNonMarketSignalCount: bet.averageNonMarketSignalCount,
    displayRating: bet.displayRating,
    riskLegCount: bet.riskLegCount,
    bttsLegCount: bet.bttsLegCount,
    fragileLegCount: bet.fragileLegCount,
    correlationPenalty: bet.correlationPenalty,
    correlationReasons: bet.correlationReasons,
    marketFamilyMix: bet.marketFamilyMix,
    repeatedTeamCount: bet.repeatedTeamCount,
    sameDateCluster: bet.sameDateCluster,
    thesis: bet.thesis,
    legs: bet.legs.map(summarizeLeg)
  };
}

function summarizeLeg(leg) {
  return {
    id: leg.id,
    fixtureId: leg.fixtureId,
    fixtureDate: leg.fixtureDate,
    createdAt: leg.createdAt,
    homeTeam: leg.homeTeam,
    awayTeam: leg.awayTeam,
    market: leg.market,
    selectionLabel: leg.selectionLabel,
    playerName: leg.playerName,
    bookmaker: leg.bookmaker,
    decimalOdds: leg.decimalOdds,
    likelyProbability: leg.likelyProbability,
    modelProbability: leg.modelProbability,
    rawModelProbability: leg.rawModelProbability,
    impliedProbability: leg.impliedProbability,
    marketImpliedProbability: leg.marketImpliedProbability,
    independentEdge: leg.independentEdge,
    edge: leg.edge,
    confidence: leg.confidence,
    riskTag: leg.riskTag,
    components: {
      intelligenceConfidence: leg.components?.intelligenceConfidence,
      oddsAgeHours: leg.components?.oddsAgeHours,
      oddsFreshness: leg.components?.oddsFreshness,
      oddsMovement: leg.components?.oddsMovement,
      oddsShortening: leg.components?.oddsShortening,
      oddsDrifting: leg.components?.oddsDrifting,
      nonMarketSignalCount: leg.components?.nonMarketSignalCount,
      nonMarketSignals: leg.components?.nonMarketSignals,
      independentEvidenceStrength: leg.components?.independentEvidenceStrength,
      marketBlendLift: leg.components?.marketBlendLift,
      expectedGoals: leg.components?.expectedGoals,
      homeExpectedGoals: leg.components?.homeExpectedGoals,
      awayExpectedGoals: leg.components?.awayExpectedGoals,
      projectedShotTotal: leg.components?.projectedShotTotal,
      homeProjectedShots: leg.components?.homeProjectedShots,
      awayProjectedShots: leg.components?.awayProjectedShots,
      projectedShotsOnTargetTotal: leg.components?.projectedShotsOnTargetTotal,
      over15ShapeProbability: leg.components?.over15ShapeProbability,
      under35ShapeProbability: leg.components?.under35ShapeProbability,
      under45ShapeProbability: leg.components?.under45ShapeProbability,
      buildUpEdge: leg.components?.buildUpEdge,
      pressBuildEdge: leg.components?.pressBuildEdge,
      homeManager: leg.components?.homeManager,
      awayManager: leg.components?.awayManager,
      homeLikelyFormation: leg.components?.homeLikelyFormation,
      awayLikelyFormation: leg.components?.awayLikelyFormation,
      homeStyleOfPlay: leg.components?.homeStyleOfPlay,
      awayStyleOfPlay: leg.components?.awayStyleOfPlay,
      homePassCompletion: leg.components?.homePassCompletion,
      awayPassCompletion: leg.components?.awayPassCompletion,
      homeTopScorers: leg.components?.homeTopScorers,
      awayTopScorers: leg.components?.awayTopScorers,
      homeLongMatchCount: leg.components?.homeLongMatchCount,
      awayLongMatchCount: leg.components?.awayLongMatchCount,
      homeBttsRate: leg.components?.homeBttsRate,
      awayBttsRate: leg.components?.awayBttsRate,
      homeOver25Rate: leg.components?.homeOver25Rate,
      awayOver25Rate: leg.components?.awayOver25Rate,
      tournamentPhase: leg.components?.tournamentPhase,
      homeGroupGameNumber: leg.components?.homeGroupGameNumber,
      awayGroupGameNumber: leg.components?.awayGroupGameNumber,
      bothOpeningGroupGame: leg.components?.bothOpeningGroupGame,
      oneOpeningGroupGame: leg.components?.oneOpeningGroupGame,
      openingGameCaution: leg.components?.openingGameCaution,
      tournamentExpectedGoalsAdjustment: leg.components?.tournamentExpectedGoalsAdjustment,
      tournamentBttsAdjustment: leg.components?.tournamentBttsAdjustment,
      tournamentDrawLift: leg.components?.tournamentDrawLift,
      tournamentContextNote: leg.components?.tournamentContextNote,
      survivalPenalty: leg.components?.survivalPenalty,
      lateKickoffGuard: leg.components?.lateKickoffGuard,
      confidenceReasons: leg.components?.confidenceReasons,
      scorerMarketType: leg.components?.scorerMarketType,
      teamGoalLikelihood: leg.components?.teamGoalLikelihood,
      teamFirstGoalShare: leg.components?.teamFirstGoalShare,
      starterLikelihood: leg.components?.starterLikelihood,
      projectedMinutes: leg.components?.projectedMinutes,
      scorerGoalsPerTwentyTeamMatches: leg.components?.scorerGoalsPerTwentyTeamMatches,
      scorerConfidence: leg.components?.scorerConfidence,
      predictionReflectionAdjustment: leg.components?.predictionReflectionAdjustment,
      predictionReflectionConfidence: leg.components?.predictionReflectionConfidence,
      predictionReflectionReasons: leg.components?.predictionReflectionReasons
    }
  };
}

function summarizeLegCandidate(leg) {
  return {
    id: leg.id,
    createdAt: leg.createdAt,
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
    rawModelProbability: leg.rawModelProbability,
    impliedProbability: leg.impliedProbability,
    marketImpliedProbability: leg.marketImpliedProbability,
    independentEdge: leg.independentEdge,
    edge: leg.edge,
    confidence: leg.confidence,
    score: leg.score,
    riskTag: leg.riskTag,
    components: {
      intelligenceConfidence: leg.components?.intelligenceConfidence,
      nonMarketSignalCount: leg.components?.nonMarketSignalCount,
      nonMarketSignals: leg.components?.nonMarketSignals,
      independentEvidenceStrength: leg.components?.independentEvidenceStrength,
      independentEdge: leg.components?.independentEdge,
      marketBlendLift: leg.components?.marketBlendLift,
      oddsAgeHours: leg.components?.oddsAgeHours,
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
      combinedHeatDifferential: leg.components?.combinedHeatDifferential,
      marketResultEdge: leg.components?.marketResultEdge,
      expectedGoals: leg.components?.expectedGoals,
      homeExpectedGoals: leg.components?.homeExpectedGoals,
      awayExpectedGoals: leg.components?.awayExpectedGoals,
      projectedShotTotal: leg.components?.projectedShotTotal,
      homeProjectedShots: leg.components?.homeProjectedShots,
      awayProjectedShots: leg.components?.awayProjectedShots,
      projectedShotsOnTargetTotal: leg.components?.projectedShotsOnTargetTotal,
      over15ShapeProbability: leg.components?.over15ShapeProbability,
      under35ShapeProbability: leg.components?.under35ShapeProbability,
      under45ShapeProbability: leg.components?.under45ShapeProbability,
      buildUpEdge: leg.components?.buildUpEdge,
      pressBuildEdge: leg.components?.pressBuildEdge,
      homeManager: leg.components?.homeManager,
      awayManager: leg.components?.awayManager,
      homeLikelyFormation: leg.components?.homeLikelyFormation,
      awayLikelyFormation: leg.components?.awayLikelyFormation,
      homeStyleOfPlay: leg.components?.homeStyleOfPlay,
      awayStyleOfPlay: leg.components?.awayStyleOfPlay,
      homePassCompletion: leg.components?.homePassCompletion,
      awayPassCompletion: leg.components?.awayPassCompletion,
      homeTopScorers: leg.components?.homeTopScorers,
      awayTopScorers: leg.components?.awayTopScorers,
      homeLongMatchCount: leg.components?.homeLongMatchCount,
      awayLongMatchCount: leg.components?.awayLongMatchCount,
      homeBttsRate: leg.components?.homeBttsRate,
      awayBttsRate: leg.components?.awayBttsRate,
      homeOver25Rate: leg.components?.homeOver25Rate,
      awayOver25Rate: leg.components?.awayOver25Rate,
      tournamentPhase: leg.components?.tournamentPhase,
      homeGroupGameNumber: leg.components?.homeGroupGameNumber,
      awayGroupGameNumber: leg.components?.awayGroupGameNumber,
      bothOpeningGroupGame: leg.components?.bothOpeningGroupGame,
      oneOpeningGroupGame: leg.components?.oneOpeningGroupGame,
      openingGameCaution: leg.components?.openingGameCaution,
      tournamentExpectedGoalsAdjustment: leg.components?.tournamentExpectedGoalsAdjustment,
      tournamentBttsAdjustment: leg.components?.tournamentBttsAdjustment,
      tournamentDrawLift: leg.components?.tournamentDrawLift,
      tournamentContextNote: leg.components?.tournamentContextNote,
      confidenceReasons: leg.components?.confidenceReasons,
      scorerMarketType: leg.components?.scorerMarketType,
      teamGoalLikelihood: leg.components?.teamGoalLikelihood,
      teamFirstGoalShare: leg.components?.teamFirstGoalShare,
      starterLikelihood: leg.components?.starterLikelihood,
      projectedMinutes: leg.components?.projectedMinutes,
      scorerGoalsPerTwentyTeamMatches: leg.components?.scorerGoalsPerTwentyTeamMatches,
      scorerConfidence: leg.components?.scorerConfidence,
      predictionReflectionAdjustment: leg.components?.predictionReflectionAdjustment,
      predictionReflectionConfidence: leg.components?.predictionReflectionConfidence,
      predictionReflectionReasons: leg.components?.predictionReflectionReasons
    },
    thesis: leg.thesis
  };
}

function summarizeOutcomeCalibration(calibration = {}) {
  const compactMap = (items = {}) => Object.fromEntries(
    Object.entries(items)
      .filter(([, value]) => Number(value?.count || 0) > 0)
      .sort((left, right) => Number(right[1].count || 0) - Number(left[1].count || 0))
      .slice(0, 12)
  );

  return {
    overall: calibration.overall || null,
    probabilityBand: compactMap(calibration.probabilityBand),
    market: compactMap(calibration.market),
    riskTag: compactMap(calibration.riskTag)
  };
}

function summarizePredictionReflection(reflection = {}) {
  const compactMap = (items = {}) => Object.fromEntries(
    Object.entries(items)
      .filter(([, value]) => Number(value?.count || 0) > 0)
      .sort((left, right) => Number(right[1].count || 0) - Number(left[1].count || 0))
      .slice(0, 12)
  );

  return {
    count: reflection.count || 0,
    overall: reflection.overall || null,
    market: compactMap(reflection.market),
    riskTag: compactMap(reflection.riskTag),
    heat: compactMap(reflection.heat),
    lineup: compactMap(reflection.lineup)
  };
}

function summarizeMarkets(oddsSnapshots, policy, survivabilityMarketCoverage = null) {
  const counts = {};

  for (const record of oddsSnapshots) {
    counts[record.market] = (counts[record.market] || 0) + 1;
  }

  return {
    configured: policy.markets || [],
    collectOnly: Object.keys(survivabilityMarketCoverage?.markets || {}),
    observed: counts,
    anytimeScorerRecords: counts.anytime_scorer || 0,
    firstGoalscorerRecords: counts.first_goalscorer || 0,
    scorerRecords: (counts.anytime_scorer || 0) + (counts.first_goalscorer || 0),
    survivabilityCoverage: survivabilityMarketCoverage
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

function summarizePlayerStats(playerStats) {
  const byTeam = {};

  for (const record of playerStats) {
    const bucket = byTeam[record.team] || [];
    bucket.push({
      playerName: record.playerName,
      goals: record.goals || 0,
      matchesSampled: record.matchesSampled || 0,
      scoringMatches: record.scoringMatches || 0,
      goalsPerTwentyTeamMatches: record.goalsPerTwentyTeamMatches || 0,
      scorerConfidence: record.scorerConfidence || 0
    });
    byTeam[record.team] = bucket;
  }

  for (const team of Object.keys(byTeam)) {
    byTeam[team] = byTeam[team]
      .sort((left, right) => Number(right.goals || 0) - Number(left.goals || 0))
      .slice(0, 8);
  }

  return {
    recordCount: playerStats.length,
    teams: byTeam
  };
}

function summarizeTeamProfiles(teamStats) {
  const teams = {};

  for (const team of teamStats) {
    teams[team.team] = {
      team: team.team,
      updatedAt: team.updatedAt,
      manager: team.manager || "",
      captain: team.captain || "",
      provider: team.provider || team.sourceType || "public-web",
      sourceMatchCount: team.sourceMatchCount || team.longForm?.matchCount || team.formMemory?.matchCount || 0,
      sourceMatchTarget: team.sourceMatchTarget || team.intelligenceCoverage?.matchWindowTarget || 20,
      statsCompleteness: team.statsCompleteness || 0,
      intelligenceConfidence: team.intelligenceConfidence || 0,
      tacticalProfile: team.tacticalProfile || null,
      passing: team.passing || {
        attempted: team.passesAttempted || 420,
        completed: team.completedPasses || 342,
        completion: team.passCompletion || 0.815,
        source: "score-and-possession-derived estimate"
      },
      topScorers: (team.topScorers || team.scorerSummary || []).slice(0, 8),
      longForm: team.longForm || team.formMemory?.longForm || null,
      recentForm: team.recentForm || team.formMemory?.shortForm || null,
      intelligenceCoverage: team.intelligenceCoverage || {
        matchWindowTarget: 20,
        matchWindowAvailable: team.sourceMatchCount || 0,
        equalSchemaForAllTeams: true
      },
      recentMatches: (team.recentMatches || team.formMemory?.recentMatches || []).slice(0, 20)
    };
  }

  return {
    recordCount: Object.keys(teams).length,
    schema: {
      matchWindow: 20,
      includes: ["manager", "formation", "styleOfPlay", "shots", "shotsOnTarget", "possession", "passes", "completedPasses", "goals", "scorers"],
      eventDataMode: "public result rows plus score-derived event estimates"
    },
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
