import { readJson, upsertJsonRecords } from "./db.mjs";
import { makeId, normalizeName, round } from "./utils.mjs";

export async function settleStoredBetOutcomes({ matchHistory = null, now = new Date() } = {}) {
  const [legCandidates, recommendations, appScanLatest, appScans, existingOutcomes, storedMatchHistory] = await Promise.all([
    readJson(["data", "leg-candidates-latest.json"], []),
    readJson(["data", "recommendations-latest.json"], null),
    readJson(["data", "app-scan-latest.json"], null),
    readJson(["data", "app-scans.json"], []),
    readJson(["data", "bet-outcomes.json"], []),
    matchHistory ? Promise.resolve(matchHistory) : readJson(["data", "team-match-history.json"], [])
  ]);
  const settlement = settleBetOutcomes({
    legCandidates,
    recommendations,
    appScans: [appScanLatest, ...appScans].filter(Boolean),
    matchHistory: storedMatchHistory,
    existingOutcomes,
    now
  });

  if (settlement.newRecords.length) {
    await upsertJsonRecords(["data", "bet-outcomes.json"], settlement.newRecords, outcomeRecordKey, 20000);
  }

  return settlement;
}

export function settleBetOutcomes({ legCandidates = [], recommendations = null, appScans = [], matchHistory = [], existingOutcomes = [], now = new Date() } = {}) {
  const fullLegs = recommendedFullLegs({ legCandidates, recommendations, appScans, existingOutcomes });
  const existingByKey = new Map(existingOutcomes.map((outcome) => [outcomeRecordKey(outcome), outcome]));
  const newRecords = [];
  const skipped = {
    noRecommendations: recommendations || appScans.length ? 0 : 1,
    noMatch: 0,
    unknownMarket: 0,
    alreadySettled: 0
  };

  for (const leg of fullLegs) {
    const match = findSettledMatchForLeg(leg, matchHistory, now);

    if (!match) {
      skipped.noMatch += 1;
      continue;
    }

    const result = gradeLegAgainstMatch(leg, match);

    if (!result.status || result.status === "unknown") {
      skipped.unknownMarket += 1;
      continue;
    }

    const record = buildOutcomeRecord({ leg, match, result, now });
    const key = outcomeRecordKey(record);
    const existing = existingByKey.get(key);

    if (existing && !outcomeRecordChanged(existing, record)) {
      skipped.alreadySettled += 1;
      continue;
    }

    existingByKey.set(key, record);
    newRecords.push(record);
  }

  return {
    createdAt: now.toISOString(),
    examinedLegCount: fullLegs.length,
    insertedCount: newRecords.length,
    newRecords,
    skipped
  };
}

export function gradeLegAgainstMatch(leg, match) {
  const homeGoals = Number(match.homeGoals);
  const awayGoals = Number(match.awayGoals);

  if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) {
    return { status: "unknown", reason: "missing_score" };
  }

  const totalGoals = homeGoals + awayGoals;
  const homeWon = homeGoals > awayGoals;
  const awayWon = awayGoals > homeGoals;
  const draw = homeGoals === awayGoals;
  const outcome = String(leg.outcome || inferredOutcomeFromLabel(leg) || "");

  if (leg.market === "match_winner") {
    if (outcome === "Draw") {
      return { status: draw ? "won" : "lost", reason: "full_time_result" };
    }

    const selectedHome = teamMatches(outcome, match.homeTeam);
    const selectedAway = teamMatches(outcome, match.awayTeam);

    if (!selectedHome && !selectedAway) {
      return { status: "unknown", reason: "selection_team_not_matched" };
    }

    return { status: selectedHome ? (homeWon ? "won" : "lost") : (awayWon ? "won" : "lost"), reason: "full_time_result" };
  }

  if (leg.market === "draw_no_bet") {
    if (draw) {
      return { status: "void", reason: "draw_no_bet_push" };
    }

    const selectedHome = teamMatches(outcome, match.homeTeam);
    const selectedAway = teamMatches(outcome, match.awayTeam);

    if (!selectedHome && !selectedAway) {
      return { status: "unknown", reason: "selection_team_not_matched" };
    }

    return { status: selectedHome ? (homeWon ? "won" : "lost") : (awayWon ? "won" : "lost"), reason: "draw_no_bet_result" };
  }

  if (leg.market === "double_chance") {
    const wantsHome = teamMatches(outcome, match.homeTeam);
    const wantsAway = teamMatches(outcome, match.awayTeam);
    const wantsDraw = /draw/i.test(outcome || leg.selectionLabel || "");

    if (!wantsHome && !wantsAway && !wantsDraw) {
      return { status: "unknown", reason: "double_chance_outcome_not_matched" };
    }

    const landed = (wantsHome && homeWon) || (wantsAway && awayWon) || (wantsDraw && draw);
    return { status: landed ? "won" : "lost", reason: "double_chance_result" };
  }

  if (leg.market === "both_teams_to_score") {
    const landed = homeGoals > 0 && awayGoals > 0;
    const wantsYes = /yes/i.test(outcome || leg.selectionLabel || "");
    return { status: landed === wantsYes ? "won" : "lost", reason: "both_teams_to_score" };
  }

  if (leg.market === "over_2_5_goals") {
    return { status: totalGoals > 2.5 ? "won" : "lost", reason: "goal_total" };
  }

  if (leg.market === "over_1_5_goals") {
    return { status: totalGoals > 1.5 ? "won" : "lost", reason: "goal_total" };
  }

  if (leg.market === "under_2_5_goals") {
    return { status: totalGoals < 2.5 ? "won" : "lost", reason: "goal_total" };
  }

  if (leg.market === "under_3_5_goals") {
    return { status: totalGoals < 3.5 ? "won" : "lost", reason: "goal_total" };
  }

  if (leg.market === "under_4_5_goals") {
    return { status: totalGoals < 4.5 ? "won" : "lost", reason: "goal_total" };
  }

  if (leg.market === "anytime_scorer") {
    return gradeAnytimeScorer(leg, match, totalGoals);
  }

  if (leg.market === "first_goalscorer") {
    return gradeFirstGoalscorer(leg, match, totalGoals);
  }

  return { status: "unknown", reason: "unsupported_market" };
}

function recommendedFullLegs({ legCandidates, recommendations, appScans = [], existingOutcomes = [] }) {
  const candidateById = new Map(legCandidates.map((leg) => [baseLegId(leg.id), leg]));
  const selectedKeys = new Set();
  const selected = [];

  for (const leg of [
    ...flattenRecommendedLegs(recommendations),
    ...flattenAppScanLegs(appScans),
    ...existingOutcomes.map(outcomeToLeg)
  ]) {
    const id = baseLegId(leg.id);
    const fullLeg = candidateById.get(id) || leg;
    const key = predictionLegKey(fullLeg);

    if (!key || selectedKeys.has(key)) {
      continue;
    }

    selectedKeys.add(key);
    selected.push(fullLeg);
  }

  return selected;
}

function outcomeToLeg(outcome) {
  return {
    ...outcome,
    id: outcome.legId || outcome.id,
    fixtureDate: outcome.fixtureDate || outcome.matchDate,
    createdAt: outcome.createdAt || outcome.settledAt,
    components: outcome.predictionShape || {}
  };
}

function flattenRecommendedLegs(recommendations) {
  if (!recommendations) {
    return [];
  }

  const combos = [
    ...(recommendations.singles || []),
    ...(recommendations.doubles || []),
    ...(recommendations.trixies || []),
    ...(recommendations.accumulators || []),
    ...Object.values(recommendations.accumulatorsByLegCount || {}).flat()
  ];

  return combos.flatMap((combo) => combo.legs || []);
}

function flattenAppScanLegs(appScans = []) {
  return appScans.flatMap((scan) => {
    const betslipLegs = (scan?.betslip || []).flatMap((combo) => combo.legs || []);
    const strongestLegs = scan?.strongestLegs || [];
    return [...betslipLegs, ...strongestLegs];
  });
}

function findSettledMatchForLeg(leg, matchHistory, now) {
  const fixtureDate = new Date(leg.fixtureDate || leg.date || 0);
  const nowTime = new Date(now).getTime();

  return matchHistory
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

  if (!legHome.length || !legAway.length || !matchHome.length || !matchAway.length) {
    return false;
  }

  return (teamKeySetsMatch(legHome, matchHome) && teamKeySetsMatch(legAway, matchAway))
    || (teamKeySetsMatch(legHome, matchAway) && teamKeySetsMatch(legAway, matchHome));
}

function gradeAnytimeScorer(leg, match, totalGoals) {
  const scorerName = normalizeName(leg.playerName || leg.outcome);
  const scorerTeam = normalizeName(leg.playerTeam);
  const allScorers = [
    ...(match.homeScorers || []).map((scorer) => ({ ...scorer, team: match.homeTeam })),
    ...(match.awayScorers || []).map((scorer) => ({ ...scorer, team: match.awayTeam }))
  ];

  if (!scorerName) {
    return { status: "unknown", reason: "missing_scorer_name" };
  }

  if (!allScorers.length && totalGoals > 0) {
    return { status: "unknown", reason: "scorer_list_missing" };
  }

  const landed = allScorers.some((scorer) => {
    const samePlayer = playerNameMatches(scorer.name || scorer.playerName, scorerName);
    const sameTeam = !scorerTeam || teamMatches(scorer.team, scorerTeam);
    return samePlayer && sameTeam;
  });

  return { status: landed ? "won" : "lost", reason: "anytime_scorer" };
}

function gradeFirstGoalscorer(leg, match, totalGoals) {
  const scorerName = normalizeName(leg.playerName || leg.outcome);
  const scorerTeam = normalizeName(leg.playerTeam);
  const allScorers = [
    ...(match.homeScorers || []).map((scorer) => ({ ...scorer, team: match.homeTeam })),
    ...(match.awayScorers || []).map((scorer) => ({ ...scorer, team: match.awayTeam }))
  ];

  if (!scorerName) {
    return { status: "unknown", reason: "missing_scorer_name" };
  }

  if (!allScorers.length && totalGoals > 0) {
    return { status: "unknown", reason: "scorer_list_missing" };
  }

  if (totalGoals === 0) {
    return { status: "lost", reason: "first_goalscorer_no_goals" };
  }

  const ordered = allScorers
    .map((scorer, index) => ({
      ...scorer,
      order: Number.isFinite(Number(scorer.order)) ? Number(scorer.order) : null,
      fallbackOrder: index + 1,
      minute: Number.isFinite(Number(scorer.minute)) ? Number(scorer.minute) : null
    }))
    .filter((scorer) => Number.isFinite(scorer.minute) || Number.isFinite(scorer.order));

  if (!ordered.length) {
    return { status: "unknown", reason: "first_scorer_order_missing" };
  }

  ordered.sort((left, right) => {
    const leftMinute = Number.isFinite(left.minute) ? left.minute : 999 + left.order;
    const rightMinute = Number.isFinite(right.minute) ? right.minute : 999 + right.order;
    return leftMinute - rightMinute || (left.order ?? left.fallbackOrder) - (right.order ?? right.fallbackOrder);
  });

  const first = ordered[0];
  const samePlayer = playerNameMatches(first.name || first.playerName, scorerName);
  const sameTeam = !scorerTeam || teamMatches(first.team, scorerTeam);

  return { status: samePlayer && sameTeam ? "won" : "lost", reason: "first_goalscorer" };
}

function playerNameMatches(left, right) {
  const leftKey = normalizeName(left);
  const rightKey = normalizeName(right);

  if (!leftKey || !rightKey) {
    return false;
  }

  if (leftKey === rightKey) {
    return true;
  }

  const leftTokens = leftKey.split(/\s+/).filter(Boolean);
  const rightTokens = rightKey.split(/\s+/).filter(Boolean);
  const leftSurname = leftTokens.at(-1);
  const rightSurname = rightTokens.at(-1);

  if (!leftSurname || !rightSurname) {
    return false;
  }

  if (leftSurname !== rightSurname) {
    return false;
  }

  return leftTokens.length > 1
    || rightTokens.length > 1
    || leftKey.length >= 5
    || rightKey.length >= 5;
}

function buildOutcomeRecord({ leg, match, result, now }) {
  return {
    id: makeId("outcome", [
      baseLegId(leg.id),
      match.date,
      match.homeTeam,
      match.awayTeam,
      match.homeGoals,
      match.awayGoals,
      result.status
    ]),
    legId: baseLegId(leg.id),
    createdAt: now.toISOString(),
    settledAt: now.toISOString(),
    source: "auto-settled-public-match-history",
    sourceType: "public-web",
    fixtureId: leg.fixtureId || "",
    fixtureDate: leg.fixtureDate || "",
    matchDate: match.date,
    homeTeam: leg.homeTeam || match.homeTeam,
    awayTeam: leg.awayTeam || match.awayTeam,
    homeGoals: Number(match.homeGoals),
    awayGoals: Number(match.awayGoals),
    market: leg.market,
    outcome: leg.outcome || inferredOutcomeFromLabel(leg),
    playerName: leg.playerName || "",
    playerTeam: leg.playerTeam || "",
    selectionLabel: leg.selectionLabel || "",
    bookmaker: leg.bookmaker || "",
    decimalOdds: Number(leg.decimalOdds || 0),
    status: result.status,
    resultReason: result.reason,
    modelProbability: round(Number(leg.modelProbability || 0), 4),
    likelyProbability: round(Number(leg.likelyProbability || leg.modelProbability || 0), 4),
    rawModelProbability: round(Number(leg.rawModelProbability || leg.modelProbability || 0), 4),
    impliedProbability: round(Number(leg.impliedProbability || 0), 4),
    marketImpliedProbability: round(Number(leg.marketImpliedProbability || leg.impliedProbability || 0), 4),
    confidence: round(Number(leg.confidence || 0), 4),
    edge: round(Number(leg.edge || 0), 4),
    independentEdge: round(Number(leg.independentEdge || 0), 4),
    riskTag: leg.riskTag || "",
    riskTags: [leg.riskTag].filter(Boolean),
    nonMarketSignalCount: Number(leg.components?.nonMarketSignalCount || 0),
    dataConfidence: round(Number(leg.components?.dataCompleteness || leg.components?.intelligenceConfidence || leg.confidence || 0), 4),
    predictionShape: compactPredictionShape(leg.components || {})
  };
}

function compactPredictionShape(components = {}) {
  return {
    expectedGoals: round(Number(components.expectedGoals || 0), 4),
    homeExpectedGoals: round(Number(components.homeExpectedGoals || 0), 4),
    awayExpectedGoals: round(Number(components.awayExpectedGoals || 0), 4),
    projectedShotTotal: round(Number(components.projectedShotTotal || 0), 4),
    homeProjectedShots: round(Number(components.homeProjectedShots || 0), 4),
    awayProjectedShots: round(Number(components.awayProjectedShots || 0), 4),
    heatStress: round(Number(components.heatStress || 0), 4),
    heatExpectedGoalsAdjustment: round(Number(components.heatExpectedGoalsAdjustment || 0), 4),
    heatClimateBand: components.heatClimateBand || "",
    openingGameCaution: round(Number(components.openingGameCaution || 0), 4),
    tournamentExpectedGoalsAdjustment: round(Number(components.tournamentExpectedGoalsAdjustment || 0), 4),
    starterLikelihood: round(Number(components.starterLikelihood || 0), 4)
  };
}

function outcomeRecordKey(record) {
  return [
    record.legId || record.selectionLabel || "",
    record.fixtureId || "",
    record.matchDate || record.fixtureDate || "",
    record.market || "",
    record.outcome || "",
    record.bookmaker || "",
  ].join("|");
}

function outcomeRecordChanged(existing, next) {
  return existing.status !== next.status
    || existing.resultReason !== next.resultReason
    || Number(existing.homeGoals) !== Number(next.homeGoals)
    || Number(existing.awayGoals) !== Number(next.awayGoals);
}

function baseLegId(id) {
  return String(id || "").replace(/_short_window_repeat_\d+$/, "");
}

function predictionLegKey(leg) {
  const fixtureKey = leg.fixtureId
    || [leg.fixtureDate || leg.date || "", normalizeName(leg.homeTeam), normalizeName(leg.awayTeam)].filter(Boolean).join("|");

  return [
    fixtureKey,
    leg.market || "",
    normalizeName(leg.outcome || inferredOutcomeFromLabel(leg)),
    normalizeName(leg.playerName || ""),
    normalizeName(leg.playerTeam || ""),
    normalizeName(leg.bookmaker || "")
  ].join("|");
}

function inferredOutcomeFromLabel(leg) {
  const label = String(leg.selectionLabel || "");

  if (leg.market === "both_teams_to_score") {
    return /:\s*both teams to score:\s*no/i.test(label) ? "No" : /:\s*both teams to score:\s*yes/i.test(label) ? "Yes" : "";
  }

  if (leg.market === "over_2_5_goals") {
    return "Over";
  }

  if (leg.market === "over_1_5_goals") {
    return "Over";
  }

  if (leg.market === "under_2_5_goals") {
    return "Under";
  }

  if (leg.market === "under_3_5_goals" || leg.market === "under_4_5_goals") {
    return "Under";
  }

  if (leg.market === "double_chance") {
    const match = label.match(/:\s*double chance:\s*(.*)$/i);
    return match?.[1] || "";
  }

  const match = label.match(/:\s*(.*?)\s+(?:to win|draw no bet|anytime scorer|first goalscorer)/i);
  return match?.[1] || "";
}

function teamMatches(left, right) {
  return teamKeySetsMatch(teamIdentityKeys(left), teamIdentityKeys(right));
}

const TEAM_ALIASES = {
  usa: ["united states", "united states mens", "united states men s", "usmnt"],
  "united states": ["usa", "united states mens", "united states men s", "usmnt"],
  "united states mens": ["usa", "united states", "united states men s", "usmnt"],
  "united states men s": ["usa", "united states", "united states mens", "usmnt"],
  czechia: ["czech republic"],
  "czech republic": ["czechia"],
  turkiye: ["turkey"],
  turkey: ["turkiye"],
  "dr congo": ["congo dr", "democratic republic of the congo"],
  "congo dr": ["dr congo", "democratic republic of the congo"],
  "democratic republic of the congo": ["dr congo", "congo dr"],
  "ivory coast": ["cote d ivoire"],
  "cote d ivoire": ["ivory coast"],
  "south korea": ["korea republic", "republic of korea"],
  "korea republic": ["south korea", "republic of korea"],
  "republic of korea": ["south korea", "korea republic"],
  "bosnia and herzegovina": ["bosnia"],
  bosnia: ["bosnia and herzegovina"]
};

function teamIdentityKeys(team) {
  const key = normalizeName(team);
  const keys = new Set([key, ...(TEAM_ALIASES[key] || []).map(normalizeName)]);
  return [...keys].filter(Boolean);
}

function teamKeySetsMatch(leftKeys, rightKeys) {
  return leftKeys.some((left) => rightKeys.some((right) => {
    return left === right || left.includes(right) || right.includes(left);
  }));
}
