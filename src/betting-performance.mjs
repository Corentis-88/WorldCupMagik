import { readJson } from "./db.mjs";
import { clamp, decimalToImpliedProbability, mean, normalizeName, round } from "./utils.mjs";

const MIN_MONEY_ODDS = 1.01;

export async function loadBettingPerformance({ oddsSnapshots = null, now = new Date() } = {}) {
  const [outcomes, odds] = await Promise.all([
    readJson(["data", "bet-outcomes.json"], []),
    oddsSnapshots ? Promise.resolve(oddsSnapshots) : readJson(["data", "odds-snapshots.json"], [])
  ]);

  return buildBettingPerformance({ outcomes, oddsSnapshots: odds, now });
}

export function buildBettingPerformance({ outcomes = [], oddsSnapshots = [], now = new Date() } = {}) {
  const settled = dedupePerformanceOutcomes(outcomes.filter((outcome) => ["won", "lost"].includes(outcome.status)));
  const closingIndex = buildClosingLineIndex(oddsSnapshots);
  const byMarket = new Map();
  const byRiskTag = new Map();
  const byBookmaker = new Map();

  for (const outcome of settled) {
    const closingLine = findClosingLine(outcome, closingIndex);
    const enriched = {
      ...outcome,
      closingLine,
      clv: closingLineValue(outcome, closingLine)
    };

    incrementPerformance(byMarket, outcome.market || outcome.type || "unknown", enriched);

    for (const tag of outcome.riskTags || [outcome.riskTag].filter(Boolean)) {
      incrementPerformance(byRiskTag, tag, enriched);
    }

    if (outcome.bookmaker) {
      incrementPerformance(byBookmaker, outcome.bookmaker, enriched);
    }
  }

  return {
    createdAt: new Date(now).toISOString(),
    outcomeCount: settled.length,
    market: finalizePerformanceMap(byMarket),
    riskTag: finalizePerformanceMap(byRiskTag),
    bookmaker: finalizePerformanceMap(byBookmaker),
    summary: finalizePerformance(buildPerformanceBucket(settled.map((outcome) => ({
      ...outcome,
      closingLine: findClosingLine(outcome, closingIndex),
      clv: closingLineValue(outcome, findClosingLine(outcome, closingIndex))
    }))))
  };
}

export function bettingPerformanceAdjustment({ market, riskTag, bookmaker, decimalOdds, movement = null, bettingPerformance = null, risk = 50 } = {}) {
  const marketPerformance = bettingPerformance?.market?.[market];
  const tagPerformance = riskTag ? bettingPerformance?.riskTag?.[riskTag] : null;
  const bookmakerPerformance = bookmaker ? bettingPerformance?.bookmaker?.[bookmaker] : null;
  const livePrice = livePriceDiscipline({ decimalOdds, movement });
  const appetite = clamp(Number(risk || 0), 0, 100) / 100;
  const sampleConfidence = clamp(mean([
    sampleConfidenceFor(marketPerformance, 18),
    sampleConfidenceFor(tagPerformance, 24),
    sampleConfidenceFor(bookmakerPerformance, 28),
    livePrice.confidence
  ]), 0, 1);
  const reasons = [];
  let probabilityAdjustment = 0;
  let scorePenalty = 0;
  let scoreBonus = 0;
  let hardBlock = false;

  for (const item of [marketPerformance, tagPerformance, bookmakerPerformance].filter(Boolean)) {
    const weighted = sampleConfidenceFor(item, item === marketPerformance ? 18 : 28);
    const underperformance = performanceUnderperformance(item);
    const outperformance = performanceOutperformance(item);

    probabilityAdjustment += underperformance * weighted * -0.055;
    probabilityAdjustment += outperformance * weighted * 0.025;
    scorePenalty += underperformance * weighted * 7;
    scoreBonus += outperformance * weighted * 3;

    if (item.action === "suppress_for_cash") {
      scorePenalty += weighted * (appetite < 0.65 ? 12 : 6);
      reasons.push(`${item.key} has poor settled ROI/CLV`);

      if (item.count >= 12 && appetite < 0.66) {
        hardBlock = true;
      }
    } else if (item.action === "downgrade") {
      reasons.push(`${item.key} is being downgraded by settled bet performance`);
    } else if (item.action === "upgrade") {
      reasons.push(`${item.key} has positive settled ROI/CLV`);
    }
  }

  if (livePrice.priceGone) {
    probabilityAdjustment -= livePrice.severity * 0.045;
    scorePenalty += livePrice.severity * (appetite < 0.75 ? 10 : 6);
    reasons.push(livePrice.reason);

    if (livePrice.severity >= 0.75 && appetite < 0.72) {
      hardBlock = true;
    }
  }

  if (livePrice.thinPrice) {
    scorePenalty += livePrice.severity * 3;
    reasons.push(livePrice.reason);
  }

  return {
    probabilityAdjustment: round(clamp(probabilityAdjustment, -0.075, 0.035), 4),
    confidence: round(sampleConfidence, 4),
    scorePenalty: round(clamp(scorePenalty, 0, 24), 2),
    scoreBonus: round(clamp(scoreBonus, 0, 8), 2),
    hardBlock,
    priceGone: livePrice.priceGone,
    livePriceDiscipline: livePrice,
    marketAction: marketPerformance?.action || "monitor",
    marketRoi: marketPerformance?.cashRoi,
    marketClv: marketPerformance?.averageClv,
    marketSample: marketPerformance?.stakedCount || marketPerformance?.count || 0,
    reasons: [...new Set(reasons)].slice(0, 6)
  };
}

function buildPerformanceBucket(outcomes = []) {
  const bucket = emptyPerformanceBucket("overall");

  for (const outcome of outcomes) {
    addPerformanceOutcome(bucket, outcome);
  }

  return bucket;
}

function incrementPerformance(map, key, outcome) {
  const bucket = map.get(key) || emptyPerformanceBucket(key);
  addPerformanceOutcome(bucket, outcome);
  map.set(key, bucket);
}

function emptyPerformanceBucket(key) {
  return {
    key,
    count: 0,
    wins: 0,
    losses: 0,
    stakedCount: 0,
    cashProfit: 0,
    freeBetProfit: 0,
    decimalOddsTotal: 0,
    impliedProbabilityTotal: 0,
    modelProbabilityTotal: 0,
    clvCount: 0,
    positiveClvCount: 0,
    clvTotal: 0
  };
}

function addPerformanceOutcome(bucket, outcome) {
  const won = outcome.status === "won";
  const odds = Number(outcome.decimalOdds || 0);
  const impliedProbability = Number(outcome.marketImpliedProbability || outcome.impliedProbability || decimalToImpliedProbability(odds));
  const modelProbability = Number(outcome.modelProbability || outcome.likelyProbability || outcome.rawModelProbability || 0);

  bucket.count += 1;
  bucket.wins += won ? 1 : 0;
  bucket.losses += won ? 0 : 1;
  bucket.modelProbabilityTotal += Number.isFinite(modelProbability) ? modelProbability : 0;
  bucket.impliedProbabilityTotal += Number.isFinite(impliedProbability) ? impliedProbability : 0;

  if (odds > MIN_MONEY_ODDS) {
    bucket.stakedCount += 1;
    bucket.cashProfit += won ? odds - 1 : -1;
    bucket.freeBetProfit += won ? odds - 1 : 0;
    bucket.decimalOddsTotal += odds;
  }

  if (outcome.clv && Number.isFinite(Number(outcome.clv.decimal))) {
    const clv = Number(outcome.clv.decimal);
    bucket.clvCount += 1;
    bucket.positiveClvCount += clv > 0.002 ? 1 : 0;
    bucket.clvTotal += clv;
  }
}

function finalizePerformanceMap(map) {
  return Object.fromEntries([...map.entries()].map(([key, bucket]) => [key, finalizePerformance(bucket)]));
}

function finalizePerformance(bucket) {
  const count = Number(bucket?.count || 0);
  const stakedCount = Number(bucket?.stakedCount || 0);
  const winRate = count ? bucket.wins / count : 0;
  const cashRoi = stakedCount ? bucket.cashProfit / stakedCount : 0;
  const freeBetConversion = stakedCount ? bucket.freeBetProfit / stakedCount : 0;
  const averageClv = bucket.clvCount ? bucket.clvTotal / bucket.clvCount : 0;
  const positiveClvRate = bucket.clvCount ? bucket.positiveClvCount / bucket.clvCount : 0;
  const averageImpliedProbability = count ? bucket.impliedProbabilityTotal / count : 0;
  const averageModelProbability = count ? bucket.modelProbabilityTotal / count : 0;
  const item = {
    key: bucket.key,
    count,
    wins: bucket.wins || 0,
    losses: bucket.losses || 0,
    stakedCount,
    winRate: round(winRate, 4),
    averageDecimalOdds: round(stakedCount ? bucket.decimalOddsTotal / stakedCount : 0, 4),
    unitProfit: round(bucket.cashProfit || 0, 4),
    cashRoi: round(cashRoi, 4),
    freeBetProfit: round(bucket.freeBetProfit || 0, 4),
    freeBetConversion: round(freeBetConversion, 4),
    averageModelProbability: round(averageModelProbability, 4),
    averageImpliedProbability: round(averageImpliedProbability, 4),
    clvCount: bucket.clvCount || 0,
    averageClv: round(averageClv, 4),
    positiveClvRate: round(positiveClvRate, 4)
  };

  return {
    ...item,
    action: performanceAction(item)
  };
}

function performanceAction(item) {
  if (item.stakedCount < 5) {
    return "monitor";
  }

  if (
    item.stakedCount >= 12
    && item.cashRoi <= -0.24
    && (item.clvCount < 4 || item.averageClv <= -0.012)
    && item.winRate < item.averageImpliedProbability + 0.015
  ) {
    return "suppress_for_cash";
  }

  if (
    item.stakedCount >= 8
    && (item.cashRoi <= -0.1 || item.averageClv <= -0.018 || (item.clvCount >= 6 && item.positiveClvRate < 0.42))
  ) {
    return "downgrade";
  }

  if (item.stakedCount >= 8 && item.cashRoi >= 0.08 && (item.clvCount < 4 || item.averageClv >= 0.008)) {
    return "upgrade";
  }

  return "monitor";
}

function performanceUnderperformance(item = {}) {
  if (!item || Number(item.stakedCount || 0) < 5) {
    return 0;
  }

  const roiDrag = clamp(-Number(item.cashRoi || 0) / 0.35, 0, 1);
  const clvDrag = Number(item.clvCount || 0) >= 4 ? clamp(-Number(item.averageClv || 0) / 0.06, 0, 1) : 0;
  const strikeDrag = clamp((Number(item.averageImpliedProbability || 0) - Number(item.winRate || 0)) / 0.22, 0, 1);
  const actionLift = item.action === "suppress_for_cash" ? 0.35 : item.action === "downgrade" ? 0.18 : 0;

  return clamp(roiDrag * 0.42 + clvDrag * 0.32 + strikeDrag * 0.26 + actionLift, 0, 1);
}

function performanceOutperformance(item = {}) {
  if (!item || Number(item.stakedCount || 0) < 8 || item.action !== "upgrade") {
    return 0;
  }

  return clamp(Number(item.cashRoi || 0) / 0.4 + Math.max(0, Number(item.averageClv || 0)) / 0.08, 0, 1);
}

function livePriceDiscipline({ decimalOdds, movement = null }) {
  const current = Number(decimalOdds || 0);
  const previous = Number(movement?.previousAverageDecimalOdds || 0);
  const average = Number(movement?.averageDecimalOdds || 0);

  if (!current || current <= 1) {
    return {
      priceGone: false,
      thinPrice: false,
      severity: 0,
      confidence: 0,
      reason: ""
    };
  }

  const shorteningDrop = previous > 1 ? (previous - Math.min(current, average || current)) / previous : 0;
  const thinPrice = current < 1.28;
  const severity = clamp(Math.max(shorteningDrop / 0.16, thinPrice ? (1.28 - current) / 0.18 : 0), 0, 1);

  if (shorteningDrop >= 0.065) {
    return {
      priceGone: true,
      thinPrice: false,
      severity,
      confidence: clamp(Number(movement?.bookmakerCount || 1) / 4, 0.25, 1),
      reason: `price shortened ${round(shorteningDrop * 100, 1)}% from recent average`
    };
  }

  if (thinPrice) {
    return {
      priceGone: false,
      thinPrice: true,
      severity,
      confidence: 0.4,
      reason: `price is very short at ${round(current, 2)}`
    };
  }

  return {
    priceGone: false,
    thinPrice: false,
    severity: 0,
    confidence: movement ? 0.35 : 0,
    reason: ""
  };
}

function sampleConfidenceFor(item, fullSample) {
  return item ? clamp(Number(item.stakedCount || item.count || 0) / fullSample, 0, 1) : 0;
}

export function buildClosingLineIndex(oddsSnapshots = []) {
  const index = new Map();

  for (const record of oddsSnapshots) {
    if (!record.fixtureId || !record.market || Number(record.decimalOdds || 0) <= 1) {
      continue;
    }

    const key = performanceOddsKey(record);
    const bucket = index.get(key) || [];
    bucket.push(record);
    index.set(key, bucket);
  }

  for (const bucket of index.values()) {
    bucket.sort((left, right) => new Date(right.capturedAt || 0) - new Date(left.capturedAt || 0));
  }

  return index;
}

export function findClosingLine(outcome, closingIndex) {
  const fixtureTime = new Date(outcome.fixtureDate || outcome.matchDate || 0).getTime();

  if (!Number.isFinite(fixtureTime)) {
    return null;
  }

  const records = closingIndex.get(performanceOddsKey(outcome)) || [];
  const latest = records.find((record) => {
    const captured = new Date(record.capturedAt || 0).getTime();
    return Number.isFinite(captured) && captured <= fixtureTime + 5 * 60000;
  });

  if (!latest) {
    return null;
  }

  const sameCapture = records.filter((record) => record.capturedAt === latest.capturedAt);
  const decimalOdds = round(mean(sameCapture.map((record) => record.decimalOdds)), 4);

  return {
    capturedAt: latest.capturedAt,
    decimalOdds,
    bookmakerCount: new Set(sameCapture.map((record) => record.bookmaker)).size,
    bestDecimalOdds: round(Math.max(...sameCapture.map((record) => Number(record.decimalOdds || 0))), 4)
  };
}

export function closingLineValue(outcome, closingLine) {
  const taken = Number(outcome.decimalOdds || 0);
  const closing = Number(closingLine?.decimalOdds || 0);

  if (taken <= 1 || closing <= 1) {
    return null;
  }

  return {
    decimal: round((taken / closing) - 1, 4),
    implied: round(decimalToImpliedProbability(closing) - decimalToImpliedProbability(taken), 4),
    takenDecimalOdds: round(taken, 4),
    closingDecimalOdds: round(closing, 4),
    closingCapturedAt: closingLine.capturedAt
  };
}

function performanceOddsKey(record = {}) {
  return [
    record.fixtureId || "",
    record.market || "",
    normalizeName(record.playerName || record.outcome || record.selectionLabel || "")
  ].join("|");
}

function dedupePerformanceOutcomes(outcomes = []) {
  const bySelection = new Map();

  for (const outcome of outcomes) {
    const key = [
      outcome.fixtureId || outcome.fixtureDate || "",
      outcome.market || outcome.type || "",
      normalizeName(outcome.playerName || outcome.outcome || outcome.selectionLabel || ""),
      normalizeName(outcome.bookmaker || "")
    ].join("|");
    const existing = bySelection.get(key);

    if (!existing || new Date(outcome.settledAt || outcome.createdAt || 0) > new Date(existing.settledAt || existing.createdAt || 0)) {
      bySelection.set(key, outcome);
    }
  }

  return [...bySelection.values()];
}
