import { readJson, upsertJsonRecords } from "./db.mjs";
import { gradeLegAgainstMatch } from "./outcome-settler.mjs";
import { loadPredictionLedger } from "./prediction-ledger.mjs";
import { loadPostMatchStats, mergePostMatchStats } from "./post-match-stats.mjs";
import { clamp, makeId, mean, normalizeName, round } from "./utils.mjs";

const SCORER_MARKETS = new Set(["anytime_scorer", "first_goalscorer", "anytime_assist"]);
const GOAL_ENVIRONMENT_MARKETS = new Set([
  "both_teams_to_score",
  "over_1_5_goals",
  "over_2_5_goals",
  "under_2_5_goals",
  "under_3_5_goals",
  "under_4_5_goals"
]);

export async function refreshPredictionReflections({ matchHistory = null, postMatchStats = null, heatSnapshots = null, lineups = null, fixtures = null, now = new Date() } = {}) {
  const [
    appScanLatest,
    appScans,
    legCandidates,
    predictionLedger,
    outcomes,
    existingReflections,
    storedMatchHistory,
    storedPostMatchStats,
    storedHeatSnapshots,
    storedFixtures,
    lineupPayload
  ] = await Promise.all([
    readJson(["data", "app-scan-latest.json"], null),
    readJson(["data", "app-scans.json"], []),
    readJson(["data", "leg-candidates-latest.json"], []),
    loadPredictionLedger(),
    readJson(["data", "bet-outcomes.json"], []),
    readJson(["data", "prediction-reflections.json"], []),
    matchHistory ? Promise.resolve(matchHistory) : readJson(["data", "team-match-history.json"], []),
    postMatchStats ? Promise.resolve(postMatchStats) : loadPostMatchStats(),
    heatSnapshots ? Promise.resolve(heatSnapshots) : readJson(["data", "heat-snapshots.json"], []),
    fixtures ? Promise.resolve(fixtures) : readJson(["data", "fixtures.json"], []),
    lineups ? Promise.resolve({ lineups }) : readJson(["web", "data", "lineups-latest.json"], { lineups: [] }).catch(() => ({ lineups: [] }))
  ]);
  const mergedMatchHistory = mergePostMatchStats(storedMatchHistory, storedPostMatchStats);
  const reflection = buildPredictionReflections({
    appScans: [appScanLatest, ...appScans].filter(Boolean),
    legCandidates,
    predictionLedger,
    outcomes,
    matchHistory: mergedMatchHistory,
    heatSnapshots: storedHeatSnapshots,
    lineups: lineupPayload?.lineups || lineups || [],
    existingReflections,
    fixtures: storedFixtures,
    now
  });

  if (reflection.upsertRecords.length) {
    await upsertJsonRecords(["data", "prediction-reflections.json"], reflection.upsertRecords, reflectionRecordKey, 20000);
  }

  return reflection;
}

export function buildPredictionReflections({ appScans = [], legCandidates = [], predictionLedger = [], outcomes = [], matchHistory = [], heatSnapshots = [], lineups = [], existingReflections = [], fixtures = [], now = new Date() } = {}) {
  const existingKeys = new Set(existingReflections.map(reflectionRecordKey));
  const outcomeByLeg = new Map(outcomes.map((outcome) => [outcomeLegKey(outcome), outcome]));
  const latestHeatByFixture = latestPreKickoffHeatByFixture(heatSnapshots);
  const lineupByFixture = latestLineupByFixture(lineups);
  const fixtureContextById = reflectionTournamentContextByFixture(fixtures);
  const predictionLegs = collectPredictionLegs({ appScans, legCandidates, predictionLedger, outcomes });
  const selectedByKey = new Map();

  for (const leg of predictionLegs) {
    if (!hasReflectionShape(leg)) {
      continue;
    }

    const match = findSettledMatchForLeg(leg, matchHistory, now);

    if (!match) {
      continue;
    }

    const createdAt = new Date(leg.createdAt || 0).getTime();
    const fixtureTime = new Date(leg.fixtureDate || leg.date || 0).getTime();

    if (Number.isFinite(createdAt) && Number.isFinite(fixtureTime) && createdAt > fixtureTime + 15 * 60000) {
      continue;
    }

    const key = predictionLegKey(leg);
    const existing = selectedByKey.get(key);

    if (!existing || predictionSnapshotRank(leg) > predictionSnapshotRank(existing.leg)) {
      selectedByKey.set(key, { leg, match });
    }
  }

  const newRecords = [];
  const updatedRecords = [];
  const upsertRecords = [];

  for (const { leg, match } of selectedByKey.values()) {
    const result = gradeLegAgainstMatch(leg, match);

    if (!result.status || result.status === "unknown") {
      continue;
    }

    const outcome = outcomeByLeg.get(outcomeLegKey(leg));
    const record = buildReflectionRecord({
      leg,
      match,
      result,
      outcome,
      heatRecord: latestHeatByFixture.get(leg.fixtureId),
      lineup: lineupByFixture.get(leg.fixtureId),
      fixtureContext: fixtureContextById.get(leg.fixtureId),
      now
    });
    const key = reflectionRecordKey(record);

    if (existingKeys.has(key)) {
      updatedRecords.push(record);
    } else {
      existingKeys.add(key);
      newRecords.push(record);
    }

    upsertRecords.push(record);
  }

  return {
    createdAt: now.toISOString(),
    examinedPredictionCount: predictionLegs.length,
    insertedCount: newRecords.length,
    updatedCount: updatedRecords.length,
    upsertedCount: upsertRecords.length,
    newRecords,
    updatedRecords,
    upsertRecords
  };
}

export function buildPredictionReflectionLearning(reflections = []) {
  const settled = dedupeReflectionLearningRecords(reflections.filter((record) => record.status === "won" || record.status === "lost"));
  const buckets = {
    overall: finalizeReflectionBucket(buildReflectionBucket(settled)),
    market: bucketBy(settled, (record) => record.market || "unknown"),
    riskTag: bucketBy(settled, (record) => record.riskTag || "unknown"),
    heat: bucketBy(settled, (record) => record.heatBucket || "unknown"),
    lineup: bucketBy(settled, (record) => record.lineupBucket || "unknown"),
    tournamentPhase: bucketBy(settled, (record) => record.tournamentPhase || "unknown")
  };

  return {
    count: settled.length,
    ...buckets
  };
}

export function predictionReflectionAdjustment({ market, riskTag, model = null, outcomeLearning = null } = {}) {
  const reflection = outcomeLearning?.reflection;

  if (!reflection || reflection.count < 4) {
    return {
      adjustment: 0,
      confidence: 0,
      reasons: []
    };
  }

  const components = model?.components || {};
  const heatBucket = heatBucketForStress(components.heatStress);
  const lineupBucket = lineupBucketForModel(components);
  const tournamentPhase = tournamentPhaseForModel(components);
  const marketBucket = reflection.market?.[market];
  const riskBucket = reflection.riskTag?.[riskTag];
  const heatLearning = heatBucket ? reflection.heat?.[heatBucket] : null;
  const lineupLearning = lineupBucket ? reflection.lineup?.[lineupBucket] : null;
  const phaseLearning = tournamentPhase ? reflection.tournamentPhase?.[tournamentPhase] : null;
  const weighted = [
    [marketBucket, 0.42],
    [riskBucket, 0.18],
    [heatLearning, 0.14],
    [lineupLearning, 0.08],
    [phaseLearning, 0.18]
  ].filter(([bucket]) => bucket && bucket.count >= 3);

  if (!weighted.length) {
    return {
      adjustment: 0,
      confidence: 0,
      reasons: []
    };
  }

  const totalWeight = weighted.reduce((total, [, weight]) => total + weight, 0);
  const sampleConfidence = clamp(mean(weighted.map(([bucket]) => Math.min(1, bucket.count / 24))), 0, 1);
  const probabilityBias = weighted.reduce((total, [bucket, weight]) => total + Number(bucket.probabilityError || 0) * weight, 0) / totalWeight;
  const goalShapeBias = GOAL_ENVIRONMENT_MARKETS.has(market)
    ? weighted.reduce((total, [bucket, weight]) => {
      const goalConversionBias = Number(bucket.averageGoalTotalError || 0) * 0.018;
      const xgBias = Number(bucket.averageXgTotalError || 0) * 0.01;
      const shotBias = Number(bucket.averageShotTotalError || 0) * 0.0012;
      return total + clamp(goalConversionBias + xgBias + shotBias, -0.045, 0.045) * weight;
    }, 0) / totalWeight
    : 0;
  const adjustment = clamp(probabilityBias * 0.34 + goalShapeBias * 0.66, -0.045, 0.045);
  const reasons = [];

  if (marketBucket && marketBucket.count >= 3) {
    reasons.push(`${market} post-match reflection ${round(marketBucket.winRate * 100, 1)}% actual vs ${round(marketBucket.averageModelProbability * 100, 1)}% projected over ${marketBucket.count}`);
  }

  if (GOAL_ENVIRONMENT_MARKETS.has(market) && marketBucket && Math.abs(Number(marketBucket.averageXgTotalError || 0)) >= 0.18) {
    reasons.push(`xG environment ${marketBucket.averageXgTotalError > 0 ? "ran hotter" : "ran cooler"} than model by ${round(Math.abs(marketBucket.averageXgTotalError), 2)}`);
  }

  if (GOAL_ENVIRONMENT_MARKETS.has(market) && marketBucket && Number(marketBucket.averageGoalTotalError || 0) <= -0.18) {
    reasons.push(`actual goals finished ${round(Math.abs(marketBucket.averageGoalTotalError), 2)} below expected goal shape`);
  }

  if (heatLearning && heatLearning.count >= 3 && heatBucket !== "low_heat" && Math.abs(Number(heatLearning.averageXgTotalError || 0)) >= 0.18) {
    reasons.push(`${heatBucket.replace(/_/g, " ")} matches ${heatLearning.averageXgTotalError > 0 ? "beat" : "undershot"} expected xG`);
  }

  if (lineupLearning && lineupLearning.count >= 3 && lineupBucket !== "lineup_unknown") {
    reasons.push(`${lineupBucket.replace(/_/g, " ")} reflection sample ${lineupLearning.count}`);
  }

  if (phaseLearning && phaseLearning.count >= 3 && tournamentPhase !== "unknown") {
    reasons.push(`${tournamentPhase.replace(/_/g, " ")} reflection ${round(phaseLearning.winRate * 100, 1)}% actual over ${phaseLearning.count}`);
  }

  return {
    adjustment: round(adjustment, 4),
    confidence: round(sampleConfidence, 4),
    reasons
  };
}

export function reflectionRecordKey(record) {
  return [
    record.fixtureId || "",
    record.matchDate || record.fixtureDate || "",
    record.market || "",
    normalizeName(record.outcome || record.selectionLabel || ""),
    normalizeName(record.playerName || ""),
    normalizeName(record.bookmaker || "")
  ].join("|");
}

function collectPredictionLegs({ appScans = [], legCandidates = [], predictionLedger = [], outcomes = [] }) {
  const fromScans = appScans.flatMap((scan) => [
    ...(scan?.betslip || []).flatMap((combo) => combo.legs || []),
    ...(scan?.strongestLegs || [])
  ]);
  const fromOutcomes = outcomes
    .filter((outcome) => outcome?.predictionShape)
    .map((outcome) => ({
      ...outcome,
      components: outcome.predictionShape,
      createdAt: outcome.predictionCapturedAt || "",
      fixtureDate: outcome.fixtureDate || outcome.matchDate
    }));

  return [...predictionLedger, ...fromScans, ...legCandidates, ...fromOutcomes].filter(Boolean);
}

function hasReflectionShape(leg = {}) {
  return Number.isFinite(Number(leg.modelProbability || leg.rawModelProbability))
    && (leg.components || Number.isFinite(Number(leg.confidence)));
}

function predictionSnapshotRank(leg = {}) {
  const kickoff = new Date(leg.fixtureDate || 0).getTime();
  const created = new Date(leg.createdAt || 0).getTime();
  const hasComponents = leg.components ? 1 : 0;
  const shapeFields = [
    leg.components?.expectedGoals,
    leg.components?.homeExpectedGoals,
    leg.components?.awayExpectedGoals,
    leg.components?.projectedShotTotal,
    leg.components?.heatStress
  ].filter((value) => Number.isFinite(Number(value))).length;
  const timingScore = Number.isFinite(kickoff) && Number.isFinite(created)
    ? clamp(1 - Math.abs(kickoff - created) / (7 * 24 * 3600000), 0, 1)
    : 0.2;

  return hasComponents * 100 + shapeFields * 8 + timingScore;
}

function buildReflectionRecord({ leg, match, result, outcome, heatRecord, lineup, fixtureContext, now }) {
  const components = leg.components || {};
  const actual = actualMatchShape(match);
  const predicted = predictedMatchShape(components, fixtureContext);
  const lineupReflection = lineupShapeForLeg({ leg, lineup });
  const tournamentPhase = tournamentPhaseForModel(components, fixtureContext);
  const heatStress = Number.isFinite(Number(components.heatStress))
    ? Number(components.heatStress)
    : Number(heatRecord?.heatStress || 0);
  const heatBucket = heatBucketForStress(heatStress);
  const metricQuality = metricQualityForMatch(match, predicted);
  const actualWin = result.status === "won" ? 1 : 0;
  const modelProbability = clamp(Number(leg.modelProbability || leg.rawModelProbability || outcome?.modelProbability || 0), 0.01, 0.99);
  const xgTotalError = Number.isFinite(actual.totalXg) && Number.isFinite(predicted.totalXg)
    ? actual.totalXg - predicted.totalXg
    : null;
  const shotTotalError = Number.isFinite(actual.totalShots) && Number.isFinite(predicted.totalShots)
    ? actual.totalShots - predicted.totalShots
    : null;
  const weatherSignal = weatherImpactSignal({ heatStress, xgTotalError, shotTotalError });

  return {
    id: makeId("reflection", [
      leg.fixtureId,
      match.date,
      leg.market,
      leg.outcome || leg.selectionLabel,
      leg.bookmaker
    ]),
    createdAt: now.toISOString(),
    source: "post-match-prediction-reflection",
    sourceType: "public-web",
    fixtureId: leg.fixtureId || "",
    fixtureDate: leg.fixtureDate || "",
    matchDate: match.date,
    homeTeam: leg.homeTeam || match.homeTeam,
    awayTeam: leg.awayTeam || match.awayTeam,
    market: leg.market || "",
    outcome: leg.outcome || "",
    playerName: leg.playerName || "",
    playerTeam: leg.playerTeam || "",
    selectionLabel: leg.selectionLabel || "",
    bookmaker: leg.bookmaker || "",
    decimalOdds: Number(leg.decimalOdds || 0),
    status: result.status,
    resultReason: result.reason,
    modelProbability: round(modelProbability, 4),
    rawModelProbability: round(Number(leg.rawModelProbability || modelProbability), 4),
    impliedProbability: round(Number(leg.impliedProbability || 0), 4),
    confidence: round(Number(leg.confidence || 0), 4),
    riskTag: leg.riskTag || "",
    tournamentPhase,
    actualWin,
    probabilityError: round(actualWin - modelProbability, 4),
    brierError: round((modelProbability - actualWin) ** 2, 4),
    predicted,
    actual,
    errors: {
      goalTotal: finiteError(actual.totalGoals, predicted.totalXg),
      xgTotal: nullableRound(xgTotalError, 4),
      homeXg: finiteError(actual.homeXg, predicted.homeXg),
      awayXg: finiteError(actual.awayXg, predicted.awayXg),
      shotTotal: nullableRound(shotTotalError, 3),
      homeShots: finiteError(actual.homeShots, predicted.homeShots),
      awayShots: finiteError(actual.awayShots, predicted.awayShots)
    },
    heat: {
      heatStress: round(heatStress, 4),
      heatBucket,
      climateBand: components.heatClimateBand || heatRecord?.climateBand || "",
      expectedGoalsAdjustment: round(Number(components.heatExpectedGoalsAdjustment || heatRecord?.expectedGoalsAdjustment || 0), 4),
      confidence: round(Number(components.heatConfidence || heatRecord?.confidence || 0), 4),
      location: components.heatLocation || heatRecord?.location || "",
      weatherSignal
    },
    heatBucket,
    lineup: lineupReflection,
    lineupBucket: lineupReflection.bucket,
    metricQuality,
    learningWeight: round(clamp(Number(leg.confidence || 0.5) * metricQuality, 0.18, 1), 4)
  };
}

function actualMatchShape(match = {}) {
  return {
    homeGoals: numberOrNull(match.homeGoals),
    awayGoals: numberOrNull(match.awayGoals),
    totalGoals: numberOrNull(Number(match.homeGoals) + Number(match.awayGoals)),
    homeXg: numberOrNull(match.homeXg),
    awayXg: numberOrNull(match.awayXg),
    totalXg: numberOrNull(Number(match.homeXg) + Number(match.awayXg)),
    homeShots: numberOrNull(match.homeShots),
    awayShots: numberOrNull(match.awayShots),
    totalShots: numberOrNull(Number(match.homeShots) + Number(match.awayShots)),
    homeShotsOnTarget: numberOrNull(match.homeShotsOnTarget),
    awayShotsOnTarget: numberOrNull(match.awayShotsOnTarget),
    metricSource: match.metricSource || "",
    capturedMetricFields: match.capturedMetricFields || [],
    derivedMetricFields: match.derivedMetricFields || []
  };
}

function predictedMatchShape(components = {}, fixtureContext = null) {
  const homeXg = numberOrNull(components.homeExpectedGoals);
  const awayXg = numberOrNull(components.awayExpectedGoals);
  const totalXg = numberOrNull(components.expectedGoals ?? (isFiniteNumber(homeXg) && isFiniteNumber(awayXg) ? Number(homeXg) + Number(awayXg) : null));
  const homeShots = numberOrNull(components.homeProjectedShots);
  const awayShots = numberOrNull(components.awayProjectedShots);
  const totalShots = numberOrNull(components.projectedShotTotal ?? (isFiniteNumber(homeShots) && isFiniteNumber(awayShots) ? Number(homeShots) + Number(awayShots) : null));

  return {
    homeXg,
    awayXg,
    totalXg,
    homeShots,
    awayShots,
    totalShots,
    heatExpectedGoalsAdjustment: numberOrNull(components.heatExpectedGoalsAdjustment),
    tournamentExpectedGoalsAdjustment: numberOrNull(components.tournamentExpectedGoalsAdjustment),
    openingGameCaution: numberOrNull(components.openingGameCaution ?? openingCautionForFixtureContext(fixtureContext))
  };
}

function dedupeReflectionLearningRecords(records = []) {
  const byKey = new Map();

  for (const record of records) {
    const key = reflectionLearningKey(record);
    const existing = byKey.get(key);

    if (!existing || reflectionLearningRank(record) > reflectionLearningRank(existing)) {
      byKey.set(key, record);
    }
  }

  return [...byKey.values()];
}

function reflectionLearningKey(record = {}) {
  return [
    record.fixtureId || [record.fixtureDate || record.matchDate || "", normalizeName(record.homeTeam), normalizeName(record.awayTeam)].join("|"),
    record.market || "",
    normalizeName(record.outcome || record.selectionLabel || ""),
    normalizeName(record.playerName || ""),
    normalizeName(record.bookmaker || "")
  ].join("|");
}

function reflectionLearningRank(record = {}) {
  const captured = new Set(record.actual?.capturedMetricFields || []);
  const realMetricSource = record.actual?.metricSource && record.actual.metricSource !== "score-derived-estimates" ? 1 : 0;
  const richMetrics = (captured.has("xg") || captured.has("homeXg") ? 2 : 0)
    + (captured.has("shots") || captured.has("homeShots") ? 1.5 : 0)
    + (captured.has("shotsOnTarget") || captured.has("homeShotsOnTarget") ? 0.5 : 0);
  const metricQuality = Number(record.metricQuality || 0);
  const created = new Date(record.createdAt || 0).getTime();
  const recency = Number.isFinite(created) ? Math.min(1, created / 4102444800000) : 0;

  return realMetricSource * 10 + richMetrics + metricQuality + recency;
}

function lineupShapeForLeg({ leg, lineup }) {
  if (!lineup) {
    return {
      status: "unavailable",
      bucket: "lineup_unknown",
      bothTeamsConfirmed: false,
      playerConfirmedStarter: null
    };
  }

  const home = teamLineup(lineup, leg.homeTeam);
  const away = teamLineup(lineup, leg.awayTeam);
  const bothTeamsConfirmed = isConfirmedLineup(home) && isConfirmedLineup(away);
  const playerTeam = teamMatches(leg.playerTeam, leg.homeTeam) ? home : teamMatches(leg.playerTeam, leg.awayTeam) ? away : null;
  const playerConfirmedStarter = SCORER_MARKETS.has(leg.market)
    ? Boolean(playerTeam?.starters?.some((starter) => playerMatches(starter, leg.playerName || leg.outcome)))
    : null;
  const bucket = SCORER_MARKETS.has(leg.market)
    ? playerConfirmedStarter ? "scorer_confirmed_starter" : bothTeamsConfirmed ? "scorer_not_confirmed_starter" : "lineup_unknown"
    : bothTeamsConfirmed ? "both_xi_confirmed" : "lineup_unknown";

  return {
    status: lineup.status || "",
    bucket,
    capturedAt: lineup.capturedAt || "",
    bothTeamsConfirmed,
    playerConfirmedStarter
  };
}

function metricQualityForMatch(match = {}, predicted = {}) {
  const captured = new Set(match.capturedMetricFields || []);
  const derived = new Set(match.derivedMetricFields || []);
  let quality = 0.44;

  if (captured.has("homeXg") || captured.has("xg")) {
    quality += 0.22;
  } else if (derived.has("xg") || Number.isFinite(Number(match.homeXg))) {
    quality += 0.11;
  }

  if (captured.has("shots") || captured.has("homeShots")) {
    quality += 0.16;
  } else if (derived.has("shots") || Number.isFinite(Number(match.homeShots))) {
    quality += 0.08;
  }

  if (Number.isFinite(Number(predicted.totalXg))) {
    quality += 0.1;
  }

  if (Number.isFinite(Number(predicted.totalShots))) {
    quality += 0.08;
  }

  return round(clamp(quality, 0.25, 1), 4);
}

function weatherImpactSignal({ heatStress, xgTotalError, shotTotalError }) {
  if (Number(heatStress || 0) < 0.28 || !Number.isFinite(Number(xgTotalError))) {
    return "neutral_or_unavailable";
  }

  const blendedTempoError = Number(xgTotalError || 0) + clamp(Number(shotTotalError || 0) / 14, -0.6, 0.6);

  if (blendedTempoError <= -0.28) {
    return "heat_drag_understated";
  }

  if (blendedTempoError >= 0.28) {
    return "heat_drag_overstated";
  }

  return "heat_effect_reasonable";
}

function buildReflectionBucket(records) {
  return records.reduce((bucket, record) => {
    const weight = Number(record.learningWeight || 1);
    bucket.count += 1;
    bucket.weight += weight;
    bucket.wins += record.status === "won" ? 1 : 0;
    bucket.losses += record.status === "lost" ? 1 : 0;
    bucket.modelProbability += Number(record.modelProbability || 0) * weight;
    bucket.probabilityError += Number(record.probabilityError || 0) * weight;
    bucket.brier += Number(record.brierError || 0) * weight;
    addWeightedMetric(bucket, "goalTotalError", record.errors?.goalTotal, weight);
    addWeightedMetric(bucket, "xgTotalError", record.errors?.xgTotal, weight);
    addWeightedMetric(bucket, "shotTotalError", record.errors?.shotTotal, weight);
    bucket.metricQuality += Number(record.metricQuality || 0) * weight;

    if (record.heat?.weatherSignal && record.heat.weatherSignal !== "neutral_or_unavailable") {
      bucket.weatherSignals[record.heat.weatherSignal] = (bucket.weatherSignals[record.heat.weatherSignal] || 0) + 1;
    }

    return bucket;
  }, emptyReflectionBucket());
}

function bucketBy(records, keyFn) {
  const byKey = new Map();

  for (const record of records) {
    const key = keyFn(record);
    const existing = byKey.get(key) || [];
    existing.push(record);
    byKey.set(key, existing);
  }

  return Object.fromEntries([...byKey.entries()].map(([key, rows]) => [key, finalizeReflectionBucket(buildReflectionBucket(rows))]));
}

function emptyReflectionBucket() {
  return {
    count: 0,
    weight: 0,
    wins: 0,
    losses: 0,
    modelProbability: 0,
    probabilityError: 0,
    brier: 0,
    goalTotalError: 0,
    goalTotalErrorWeight: 0,
    xgTotalError: 0,
    xgTotalErrorWeight: 0,
    shotTotalError: 0,
    shotTotalErrorWeight: 0,
    metricQuality: 0,
    weatherSignals: {}
  };
}

function finalizeReflectionBucket(bucket) {
  const weight = Math.max(0.0001, Number(bucket.weight || 0));

  return {
    count: bucket.count,
    wins: bucket.wins,
    losses: bucket.losses,
    winRate: round(bucket.count ? bucket.wins / bucket.count : 0, 4),
    averageModelProbability: round(bucket.modelProbability / weight, 4),
    probabilityError: round(bucket.probabilityError / weight, 4),
    averageGoalTotalError: weightedAverage(bucket.goalTotalError, bucket.goalTotalErrorWeight),
    averageXgTotalError: weightedAverage(bucket.xgTotalError, bucket.xgTotalErrorWeight),
    averageShotTotalError: weightedAverage(bucket.shotTotalError, bucket.shotTotalErrorWeight),
    brierScore: round(bucket.brier / weight, 4),
    averageMetricQuality: round(bucket.metricQuality / weight, 4),
    weatherSignals: bucket.weatherSignals
  };
}

function addWeightedMetric(bucket, key, value, weight) {
  if (!isFiniteNumber(value)) {
    return;
  }

  bucket[key] += Number(value) * weight;
  bucket[`${key}Weight`] += weight;
}

function weightedAverage(total, weight) {
  return Number(weight || 0) > 0 ? round(total / weight, 4) : null;
}

function latestPreKickoffHeatByFixture(records = []) {
  const byFixture = new Map();

  for (const record of records) {
    if (!record?.fixtureId) {
      continue;
    }

    const existing = byFixture.get(record.fixtureId);

    if (!existing || new Date(record.capturedAt || 0) > new Date(existing.capturedAt || 0)) {
      byFixture.set(record.fixtureId, record);
    }
  }

  return byFixture;
}

function latestLineupByFixture(records = []) {
  const byFixture = new Map();

  for (const record of records) {
    if (!record?.fixtureId) {
      continue;
    }

    const existing = byFixture.get(record.fixtureId);

    if (!existing || lineupRank(record) > lineupRank(existing) || new Date(record.capturedAt || 0) > new Date(existing.capturedAt || 0)) {
      byFixture.set(record.fixtureId, record);
    }
  }

  return byFixture;
}

function reflectionTournamentContextByFixture(fixtures = []) {
  const groupFixtures = [...(fixtures || [])]
    .filter(isGroupStageFixture)
    .sort((left, right) => new Date(left.date || 0) - new Date(right.date || 0));
  const canonicalByPair = new Map();

  for (const fixture of groupFixtures) {
    const key = fixturePairKey(fixture);

    if (key && !canonicalByPair.has(key)) {
      canonicalByPair.set(key, fixture);
    }
  }

  const appearances = new Map();
  const contextByFixture = new Map();

  for (const fixture of [...canonicalByPair.values()].sort((left, right) => new Date(left.date || 0) - new Date(right.date || 0))) {
    const homeKey = normalizeName(fixture.homeTeam);
    const awayKey = normalizeName(fixture.awayTeam);
    const homeGame = (appearances.get(homeKey) || 0) + 1;
    const awayGame = (appearances.get(awayKey) || 0) + 1;
    const phase = homeGame === 1 && awayGame === 1
      ? "opening_group_game"
      : homeGame === 1 || awayGame === 1
        ? "mixed_opening_group_game"
        : Math.max(homeGame, awayGame) >= 3
          ? "final_group_game"
          : "middle_group_game";

    contextByFixture.set(fixture.id, { phase, homeGroupGameNumber: homeGame, awayGroupGameNumber: awayGame });
    appearances.set(homeKey, homeGame);
    appearances.set(awayKey, awayGame);
  }

  return contextByFixture;
}

function isGroupStageFixture(fixture = {}) {
  const stage = String(fixture.stage || fixture.round || "").toLowerCase();

  if (/round of|quarter|semi|final|play[- ]?off|knockout/.test(stage)) {
    return false;
  }

  return !stage || /group|first stage|stage 1/.test(stage);
}

function fixturePairKey(fixture = {}) {
  const teams = [normalizeName(fixture.homeTeam), normalizeName(fixture.awayTeam)]
    .filter(Boolean)
    .sort();

  return teams.length === 2 ? teams.join("|") : "";
}

function lineupRank(record = {}) {
  if (record.status === "confirmed") {
    return 3;
  }

  if (record.status === "partial_confirmed") {
    return 2;
  }

  return 1;
}

function findSettledMatchForLeg(leg, matchHistory, now) {
  const fixtureDate = new Date(leg.fixtureDate || leg.date || 0);
  const nowTime = new Date(now).getTime();

  return (matchHistory || [])
    .filter((match) => Number.isFinite(Number(match.homeGoals)) && Number.isFinite(Number(match.awayGoals)))
    .filter((match) => new Date(match.date || 0).getTime() <= nowTime)
    .filter((match) => teamsMatchLeg(leg, match))
    .filter((match) => {
      if (!Number.isFinite(fixtureDate.getTime())) {
        return true;
      }

      return Math.abs(new Date(match.date || 0).getTime() - fixtureDate.getTime()) <= 36 * 60 * 60 * 1000;
    })
    .sort((left, right) => Math.abs(new Date(left.date || 0).getTime() - fixtureDate.getTime()) - Math.abs(new Date(right.date || 0).getTime() - fixtureDate.getTime()))[0] || null;
}

function teamsMatchLeg(leg, match) {
  const legHome = teamIdentityKeys(leg.homeTeam);
  const legAway = teamIdentityKeys(leg.awayTeam);
  const matchHome = teamIdentityKeys(match.homeTeam);
  const matchAway = teamIdentityKeys(match.awayTeam);

  return (teamKeySetsMatch(legHome, matchHome) && teamKeySetsMatch(legAway, matchAway))
    || (teamKeySetsMatch(legHome, matchAway) && teamKeySetsMatch(legAway, matchHome));
}

function teamLineup(lineup, teamName) {
  if (!lineup?.teams || !teamName) {
    return null;
  }

  return lineup.teams[teamName]
    || Object.entries(lineup.teams).find(([team]) => teamMatches(team, teamName))?.[1]
    || null;
}

function isConfirmedLineup(team) {
  return team?.status === "confirmed" && Array.isArray(team.starters) && team.starters.length >= 7;
}

function playerMatches(left, right) {
  const leftKey = normalizeName(left);
  const rightKey = normalizeName(right);

  if (!leftKey || !rightKey) {
    return false;
  }

  const leftTokens = leftKey.split(/\s+/);
  const rightTokens = rightKey.split(/\s+/);
  const leftSurname = leftTokens.at(-1);
  const rightSurname = rightTokens.at(-1);

  return leftKey === rightKey
    || (leftSurname && leftSurname === rightKey)
    || (rightSurname && rightSurname === leftKey)
    || (leftSurname && rightSurname && leftSurname === rightSurname && Math.min(leftTokens.length, rightTokens.length) > 1);
}

function teamMatches(left, right) {
  return teamKeySetsMatch(teamIdentityKeys(left), teamIdentityKeys(right));
}

const TEAM_ALIASES = {
  usa: ["united states", "united states mens", "united states men s", "usmnt"],
  "united states": ["usa", "united states mens", "united states men s", "usmnt"],
  czechia: ["czech republic"],
  "czech republic": ["czechia"],
  turkiye: ["turkey"],
  turkey: ["turkiye"],
  "south korea": ["korea republic", "republic of korea"],
  "korea republic": ["south korea", "republic of korea"],
  "bosnia and herzegovina": ["bosnia"],
  bosnia: ["bosnia and herzegovina"],
  "ivory coast": ["cote d ivoire"],
  "cote d ivoire": ["ivory coast"]
};

function teamIdentityKeys(team) {
  const key = normalizeName(team);
  return [...new Set([key, ...(TEAM_ALIASES[key] || []).map(normalizeName)].filter(Boolean))];
}

function teamKeySetsMatch(leftKeys, rightKeys) {
  return leftKeys.some((key) => rightKeys.includes(key));
}

function outcomeLegKey(outcome) {
  return [
    outcome.fixtureId || "",
    outcome.market || "",
    normalizeName(outcome.outcome || outcome.selectionLabel || ""),
    normalizeName(outcome.playerName || ""),
    normalizeName(outcome.bookmaker || "")
  ].join("|");
}

function predictionLegKey(leg) {
  return [
    leg.fixtureId || [leg.fixtureDate || "", normalizeName(leg.homeTeam), normalizeName(leg.awayTeam)].join("|"),
    leg.market || "",
    normalizeName(leg.outcome || leg.selectionLabel || ""),
    normalizeName(leg.playerName || ""),
    normalizeName(leg.bookmaker || "")
  ].join("|");
}

function heatBucketForStress(stress) {
  const value = Number(stress || 0);

  if (value >= 0.62) {
    return "high_heat";
  }

  if (value >= 0.28) {
    return "moderate_heat";
  }

  return "low_heat";
}

function lineupBucketForModel(components = {}) {
  if (Number(components.starterLikelihood || 0) >= 0.68) {
    return "projected_starter";
  }

  if (Number(components.starterLikelihood || 0) > 0) {
    return "uncertain_starter_projection";
  }

  return "lineup_unknown";
}

function tournamentPhaseForModel(components = {}, fixtureContext = null) {
  if (components.tournamentPhase) {
    return components.tournamentPhase;
  }

  if (Number(components.openingGameCaution || 0) >= 0.75) {
    return "opening_group_game";
  }

  if (Number(components.openingGameCaution || 0) > 0) {
    return "mixed_opening_group_game";
  }

  if (fixtureContext?.phase) {
    return fixtureContext.phase;
  }

  return "unknown";
}

function openingCautionForFixtureContext(fixtureContext = null) {
  if (fixtureContext?.phase === "opening_group_game") {
    return 1;
  }

  if (fixtureContext?.phase === "mixed_opening_group_game") {
    return 0.58;
  }

  return null;
}

function finiteError(actual, predicted) {
  if (!isFiniteNumber(actual) || !isFiniteNumber(predicted)) {
    return null;
  }

  return round(Number(actual) - Number(predicted), 4);
}

function nullableRound(value, digits = 4) {
  return isFiniteNumber(value) ? round(Number(value), digits) : null;
}

function numberOrNull(value) {
  return isFiniteNumber(value) ? round(Number(value), 4) : null;
}

function isFiniteNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}
