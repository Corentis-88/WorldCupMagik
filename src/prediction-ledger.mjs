import { readJson, upsertJsonRecords } from "./db.mjs";
import { normalizeName, round } from "./utils.mjs";

const LEDGER_PATH = ["data", "prediction-ledger.json"];

export async function loadPredictionLedger() {
  return readJson(LEDGER_PATH, []);
}

export async function persistPredictionLedger(legs = []) {
  const records = legs
    .map(compactPredictionLeg)
    .filter(Boolean);

  if (!records.length) {
    return [];
  }

  return upsertJsonRecords(LEDGER_PATH, records, predictionLedgerKey, 50000);
}

export function compactPredictionLeg(leg = {}) {
  if (!leg.fixtureId || !leg.fixtureDate || !leg.market || !leg.selectionLabel) {
    return null;
  }

  return {
    id: leg.id || predictionLedgerKey(leg),
    createdAt: leg.createdAt || "",
    source: "prediction-ledger",
    fixtureId: leg.fixtureId || "",
    fixtureDate: leg.fixtureDate || "",
    homeTeam: leg.homeTeam || "",
    awayTeam: leg.awayTeam || "",
    market: leg.market || "",
    outcome: leg.outcome || "",
    playerName: leg.playerName || "",
    playerTeam: leg.playerTeam || "",
    selectionLabel: leg.selectionLabel || "",
    bookmaker: leg.bookmaker || "",
    oddsCapturedAt: leg.oddsCapturedAt || leg.components?.oddsCapturedAt || "",
    decimalOdds: Number(leg.decimalOdds || 0),
    modelProbability: round(Number(leg.modelProbability || 0), 4),
    rawModelProbability: round(Number(leg.rawModelProbability || leg.modelProbability || 0), 4),
    impliedProbability: round(Number(leg.impliedProbability || 0), 4),
    marketImpliedProbability: round(Number(leg.marketImpliedProbability || leg.impliedProbability || 0), 4),
    confidence: round(Number(leg.confidence || 0), 4),
    edge: round(Number(leg.edge || 0), 4),
    independentEdge: round(Number(leg.independentEdge || leg.edge || 0), 4),
    riskTag: leg.riskTag || "",
    hardBlocks: Array.isArray(leg.hardBlocks) ? leg.hardBlocks.slice(0, 12) : [],
    components: compactPredictionComponents(leg.components || {})
  };
}

export function predictionLedgerKey(record = {}) {
  return [
    record.fixtureId || [record.fixtureDate || "", normalizeName(record.homeTeam), normalizeName(record.awayTeam)].join("|"),
    record.market || "",
    normalizeName(record.outcome || record.selectionLabel || ""),
    normalizeName(record.playerName || ""),
    normalizeName(record.playerTeam || ""),
    normalizeName(record.bookmaker || "")
  ].join("|");
}

function compactPredictionComponents(components = {}) {
  const keep = [
    "expectedGoals",
    "homeExpectedGoals",
    "awayExpectedGoals",
    "projectedShotTotal",
    "homeProjectedShots",
    "awayProjectedShots",
    "heatStress",
    "heatExpectedGoalsAdjustment",
    "heatClimateBand",
    "heatConfidence",
    "heatLocation",
    "openingGameCaution",
    "tournamentExpectedGoalsAdjustment",
    "tournamentPhase",
    "starterLikelihood",
    "projectedMinutes",
    "scorerMarketType",
    "teamGoalLikelihood",
    "teamFirstGoalShare",
    "scorerGoalsPerTwentyTeamMatches",
    "scorerConfidence",
    "scorerMatchesSampled",
    "scoringRoleScore",
    "assistMarketType",
    "assistSampleRate",
    "assistsPerTwentyTeamMatches",
    "assistConfidence",
    "assistMatchesSampled",
    "creativeRoleScore",
    "assistMarketLiftCap",
    "playerDataCoverage",
    "playerStatSource",
    "nonMarketSignalCount",
    "dataCompleteness",
    "intelligenceConfidence",
    "outcomeLearningAdjustment",
    "outcomeLearningConfidence",
    "outcomeLearningBaseAdjustment",
    "predictionReflectionAdjustment",
    "predictionReflectionConfidence"
  ];
  const compact = {};

  for (const key of keep) {
    const value = components[key];

    if (value === undefined || value === null || value === "") {
      continue;
    }

    compact[key] = typeof value === "number" ? round(value, 4) : value;
  }

  return compact;
}
