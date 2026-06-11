import { readJson, upsertJsonRecords } from "./db.mjs";
import { makeId, normalizeName, round } from "./utils.mjs";

export async function settleStoredBetOutcomes({ matchHistory = null, now = new Date() } = {}) {
  const [legCandidates, recommendations, existingOutcomes, storedMatchHistory] = await Promise.all([
    readJson(["data", "leg-candidates-latest.json"], []),
    readJson(["data", "recommendations-latest.json"], null),
    readJson(["data", "bet-outcomes.json"], []),
    matchHistory ? Promise.resolve(matchHistory) : readJson(["data", "team-match-history.json"], [])
  ]);
  const settlement = settleBetOutcomes({
    legCandidates,
    recommendations,
    matchHistory: storedMatchHistory,
    existingOutcomes,
    now
  });

  if (settlement.newRecords.length) {
    await upsertJsonRecords(["data", "bet-outcomes.json"], settlement.newRecords, outcomeRecordKey, 20000);
  }

  return settlement;
}

export function settleBetOutcomes({ legCandidates = [], recommendations = null, matchHistory = [], existingOutcomes = [], now = new Date() } = {}) {
  const fullLegs = recommendedFullLegs({ legCandidates, recommendations });
  const existingKeys = new Set(existingOutcomes.map(outcomeRecordKey));
  const newRecords = [];
  const skipped = {
    noRecommendations: recommendations ? 0 : 1,
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

    if (existingKeys.has(key)) {
      skipped.alreadySettled += 1;
      continue;
    }

    existingKeys.add(key);
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

  if (leg.market === "both_teams_to_score") {
    const landed = homeGoals > 0 && awayGoals > 0;
    const wantsYes = /yes/i.test(outcome || leg.selectionLabel || "");
    return { status: landed === wantsYes ? "won" : "lost", reason: "both_teams_to_score" };
  }

  if (leg.market === "over_2_5_goals") {
    return { status: totalGoals > 2.5 ? "won" : "lost", reason: "goal_total" };
  }

  if (leg.market === "under_2_5_goals") {
    return { status: totalGoals < 2.5 ? "won" : "lost", reason: "goal_total" };
  }

  if (leg.market === "anytime_scorer") {
    return gradeAnytimeScorer(leg, match, totalGoals);
  }

  if (leg.market === "first_goalscorer") {
    return gradeFirstGoalscorer(leg, match, totalGoals);
  }

  return { status: "unknown", reason: "unsupported_market" };
}

function recommendedFullLegs({ legCandidates, recommendations }) {
  const candidateById = new Map(legCandidates.map((leg) => [baseLegId(leg.id), leg]));
  const selectedIds = new Set();
  const selected = [];

  for (const leg of flattenRecommendedLegs(recommendations)) {
    const id = baseLegId(leg.id);

    if (!id || selectedIds.has(id)) {
      continue;
    }

    selectedIds.add(id);
    selected.push(candidateById.get(id) || leg);
  }

  return selected;
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
  const legHome = normalizeName(leg.homeTeam);
  const legAway = normalizeName(leg.awayTeam);
  const matchHome = normalizeName(match.homeTeam);
  const matchAway = normalizeName(match.awayTeam);

  if (!legHome || !legAway || !matchHome || !matchAway) {
    return false;
  }

  return (legHome === matchHome && legAway === matchAway)
    || (legHome === matchAway && legAway === matchHome);
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
    const samePlayer = normalizeName(scorer.name || scorer.playerName) === scorerName;
    const sameTeam = !scorerTeam || normalizeName(scorer.team) === scorerTeam;
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
  const samePlayer = normalizeName(first.name || first.playerName) === scorerName;
  const sameTeam = !scorerTeam || normalizeName(first.team) === scorerTeam;

  return { status: samePlayer && sameTeam ? "won" : "lost", reason: "first_goalscorer" };
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
    dataConfidence: round(Number(leg.components?.dataCompleteness || leg.components?.intelligenceConfidence || leg.confidence || 0), 4)
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
    record.status || ""
  ].join("|");
}

function baseLegId(id) {
  return String(id || "").replace(/_short_window_repeat_\d+$/, "");
}

function inferredOutcomeFromLabel(leg) {
  const label = String(leg.selectionLabel || "");

  if (leg.market === "both_teams_to_score") {
    return /:\s*both teams to score:\s*no/i.test(label) ? "No" : /:\s*both teams to score:\s*yes/i.test(label) ? "Yes" : "";
  }

  if (leg.market === "over_2_5_goals") {
    return "Over";
  }

  if (leg.market === "under_2_5_goals") {
    return "Under";
  }

  const match = label.match(/:\s*(.*?)\s+(?:to win|draw no bet|anytime scorer|first goalscorer)/i);
  return match?.[1] || "";
}

function teamMatches(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}
