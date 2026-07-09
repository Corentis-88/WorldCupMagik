const MOBILE_BET_LIMIT = 8;
const MOBILE_SCORER_LIMIT = 8;
const MOBILE_ASSIST_LIMIT = 10;

export function buildMobilePayload(payload) {
  const profiles = Object.fromEntries(
    Object.entries(payload.profiles || {}).map(([key, profile]) => [key, mobileProfile(profile)])
  );
  const pickOfTheDay = Object.fromEntries(
    Object.entries(payload.pickOfTheDay || {}).map(([key, profile]) => [key, mobileProfile(profile)])
  );

  return {
    generatedAt: payload.generatedAt,
    edition: "mobile",
    source: payload.source,
    collection: {
      durationSeconds: payload.collection?.durationSeconds,
      totalBuildDurationSeconds: payload.collection?.totalBuildDurationSeconds,
      schedule: payload.collection?.schedule,
      dataQuality: payload.collection?.dataQuality
    },
    riskBuckets: payload.riskBuckets || [],
    dayBuckets: payload.dayBuckets || [],
    dateRange: payload.dateRange || {},
    fixtures: (payload.fixtures || []).map(mobileFixture),
    riskProfiles: payload.riskProfiles || {},
    legCandidatesByRisk: mobileLegCandidatesByRisk(payload.legCandidatesByRisk || {}),
    mostLikelyLegCandidates: (payload.mostLikelyLegCandidates || []).map(mobileLeg),
    markets: payload.markets || {},
    intelligence: {
      outcomeLearningCount: payload.intelligence?.outcomeLearningCount || 0,
      predictionReflectionCount: payload.intelligence?.predictionReflectionCount || 0,
      predictionReflection: payload.intelligence?.predictionReflection || null
    },
    summary: {
      fixtureCount: (payload.fixtures || []).length,
      memoryTeamCount: payload.intelligence?.teamCount || 0,
      profileCount: Object.keys(profiles).length,
      pickOfTheDayCount: Object.keys(pickOfTheDay).length
    },
    profiles,
    pickOfTheDay,
    likelyScorersByDate: buildLikelyScorersByDate(payload),
    likelyAssistsByDate: buildLikelyAssistsByDate(payload)
  };
}

function mobileProfile(profile = {}) {
  return {
    daysAhead: profile.daysAhead,
    risk: profile.risk,
    mode: profile.mode,
    dataQuality: profile.dataQuality,
    fixtureCount: profile.fixtureCount || 0,
    eligibleLegCount: profile.eligibleLegCount || 0,
    betslip: (profile.betslip || []).slice(0, MOBILE_BET_LIMIT).map(mobileBet)
  };
}

function mobileBet(bet = {}) {
  return {
    rank: bet.rank,
    category: bet.category,
    label: bet.label,
    type: bet.type,
    score: bet.score,
    legCount: bet.legCount,
    combinedDecimalOdds: bet.combinedDecimalOdds,
    uncappedCombinedDecimalOdds: bet.uncappedCombinedDecimalOdds,
    fallbackCombinedOddsCap: bet.fallbackCombinedOddsCap,
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
    scorerLegCount: bet.scorerLegCount,
    firstScorerLegCount: bet.firstScorerLegCount,
    fragileLegCount: bet.fragileLegCount,
    correlationPenalty: bet.correlationPenalty,
    correlationReasons: bet.correlationReasons,
    marketFamilyMix: bet.marketFamilyMix,
    repeatedTeamCount: bet.repeatedTeamCount,
    sameDateCluster: bet.sameDateCluster,
    shortWindowFallback: bet.shortWindowFallback,
    reusedSignalCount: bet.reusedSignalCount,
    selectionIntent: bet.selectionIntent,
    recommendedUse: bet.recommendedUse,
    selectionQuality: bet.selectionQuality,
    selectionBrainScore: bet.selectionBrainScore,
    cashScore: bet.cashScore,
    freeBetScore: bet.freeBetScore,
    longshotScore: bet.longshotScore,
    freeBetConversion: bet.freeBetConversion,
    probabilityRange: bet.probabilityRange,
    portfolioWarnings: bet.portfolioWarnings,
    thesis: trimText(bet.thesis, 360),
    legs: (bet.legs || []).map(mobileLeg)
  };
}

function mobileLegCandidatesByRisk(groups = {}) {
  return Object.fromEntries(
    Object.entries(groups).map(([risk, legs]) => [risk, (legs || []).map(mobileLeg)])
  );
}

function mobileLeg(leg = {}) {
  return {
    id: leg.id,
    fixtureId: leg.fixtureId,
    fixtureDate: leg.fixtureDate,
    homeTeam: leg.homeTeam,
    awayTeam: leg.awayTeam,
    market: leg.market,
    outcome: leg.outcome,
    selectionLabel: leg.selectionLabel,
    playerName: leg.playerName,
    playerTeam: leg.playerTeam,
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
    shortWindowFallback: leg.shortWindowFallback,
    reusedSignal: leg.reusedSignal,
    hardBlocks: leg.hardBlocks,
    components: {
      intelligenceConfidence: leg.components?.intelligenceConfidence,
      nonMarketSignalCount: leg.components?.nonMarketSignalCount,
      oddsFreshness: leg.components?.oddsFreshness,
      expectedGoals: leg.components?.expectedGoals,
      homeExpectedGoals: leg.components?.homeExpectedGoals,
      awayExpectedGoals: leg.components?.awayExpectedGoals,
      heatStress: leg.components?.heatStress,
      heatConfidence: leg.components?.heatConfidence,
      homeBttsRate: leg.components?.homeBttsRate,
      awayBttsRate: leg.components?.awayBttsRate,
      homeOver25Rate: leg.components?.homeOver25Rate,
      awayOver25Rate: leg.components?.awayOver25Rate,
      scorerMarketType: leg.components?.scorerMarketType,
      starterLikelihood: leg.components?.starterLikelihood,
      projectedMinutes: leg.components?.projectedMinutes,
      scorerGoalsPerTwentyTeamMatches: leg.components?.scorerGoalsPerTwentyTeamMatches,
      scorerConfidence: leg.components?.scorerConfidence,
      scorerMatchesSampled: leg.components?.scorerMatchesSampled,
      scorerMarketLiftCap: leg.components?.scorerMarketLiftCap,
      assistMarketType: leg.components?.assistMarketType,
      assistsPerTwentyTeamMatches: leg.components?.assistsPerTwentyTeamMatches,
      assistConfidence: leg.components?.assistConfidence,
      assistMatchesSampled: leg.components?.assistMatchesSampled,
      creativeRoleScore: leg.components?.creativeRoleScore,
      scoringRoleScore: leg.components?.scoringRoleScore,
      playerDataCoverage: leg.components?.playerDataCoverage,
      assistMarketLiftCap: leg.components?.assistMarketLiftCap,
      playerStatSource: leg.components?.playerStatSource,
      projectedShotTotal: leg.components?.projectedShotTotal,
      predictionReflectionAdjustment: leg.components?.predictionReflectionAdjustment,
      predictionReflectionConfidence: leg.components?.predictionReflectionConfidence
    }
  };
}

function mobileFixture(fixture = {}) {
  return {
    id: fixture.id,
    date: fixture.date,
    dateKey: fixture.dateKey || dateKey(fixture.date),
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    stage: fixture.stage,
    venue: fixture.venue || ""
  };
}

function buildLikelyScorersByDate(payload) {
  const grouped = {};
  const scorerLegs = scorerCandidates(payload);

  for (const fixture of payload.fixtures || []) {
    const fixturePlayers = likelyScorersForFixture({ payload, fixture, scorerLegs });
    const key = fixture.dateKey || dateKey(fixture.date);

    if (!grouped[key]) {
      grouped[key] = [];
    }

    grouped[key].push({
      fixture: mobileFixture(fixture),
      fixtureLabel: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
      players: fixturePlayers.slice(0, MOBILE_SCORER_LIMIT)
    });
  }

  return grouped;
}

function buildLikelyAssistsByDate(payload) {
  const grouped = {};
  const assistLegs = assistCandidates(payload);

  for (const fixture of payload.fixtures || []) {
    const fixturePlayers = likelyAssistsForFixture({ payload, fixture, assistLegs });
    const key = fixture.dateKey || dateKey(fixture.date);

    if (!grouped[key]) {
      grouped[key] = [];
    }

    grouped[key].push({
      fixture: mobileFixture(fixture),
      fixtureLabel: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
      players: fixturePlayers.slice(0, MOBILE_ASSIST_LIMIT)
    });
  }

  return grouped;
}

function scorerCandidates(payload) {
  const byId = new Map();
  const sourceGroups = [
    payload.mostLikelyLegCandidates || [],
    ...Object.values(payload.legCandidatesByRisk || {})
  ];

  for (const group of sourceGroups) {
    for (const leg of group || []) {
      if (!["first_goalscorer", "anytime_scorer"].includes(leg.market)) {
        continue;
      }

      const key = [
        leg.fixtureId,
        normalizeName(leg.playerName || leg.outcome || leg.selectionLabel),
        leg.market
      ].join("|");
      const existing = byId.get(key);

      if (!existing || scorerLegScore(leg) > scorerLegScore(existing)) {
        byId.set(key, leg);
      }
    }
  }

  return [...byId.values()];
}

function assistCandidates(payload) {
  const byId = new Map();
  const sourceGroups = [
    payload.mostLikelyLegCandidates || [],
    ...Object.values(payload.legCandidatesByRisk || {})
  ];

  for (const group of sourceGroups) {
    for (const leg of group || []) {
      if (leg.market !== "anytime_assist") {
        continue;
      }

      const key = [
        leg.fixtureId,
        normalizeName(leg.playerName || leg.outcome || leg.selectionLabel),
        leg.market
      ].join("|");
      const existing = byId.get(key);

      if (!existing || scorerLegScore(leg) > scorerLegScore(existing)) {
        byId.set(key, leg);
      }
    }
  }

  return [...byId.values()];
}

function likelyScorersForFixture({ payload, fixture, scorerLegs }) {
  const byPlayer = new Map();
  const fixtureLegs = scorerLegs.filter((leg) => leg.fixtureId === fixture.id);
  const firstScorerLegs = fixtureLegs.filter((leg) => leg.market === "first_goalscorer");
  const anytimeScorerLegs = fixtureLegs.filter((leg) => leg.market === "anytime_scorer");

  if (firstScorerLegs.length) {
    addScorerOddsCandidates({ byPlayer, payload, fixture, legs: firstScorerLegs, preferredMarket: "first_goalscorer" });
  } else if (anytimeScorerLegs.length) {
    addScorerOddsCandidates({ byPlayer, payload, fixture, legs: anytimeScorerLegs, preferredMarket: "anytime_scorer" });
  }

  if (byPlayer.size < MOBILE_SCORER_LIMIT) {
    addScorerMemoryCandidates({ byPlayer, payload, fixture, mode: firstScorerLegs.length ? "first_goalscorer" : "anytime_scorer" });
  }

  return [...byPlayer.values()]
    .sort((left, right) => scorerRankScore(right) - scorerRankScore(left));
}

function likelyAssistsForFixture({ payload, fixture, assistLegs }) {
  const byPlayer = new Map();
  const fixtureLegs = assistLegs.filter((leg) => leg.fixtureId === fixture.id);

  if (fixtureLegs.length) {
    addAssistOddsCandidates({ byPlayer, payload, fixture, legs: fixtureLegs });
  }

  if (byPlayer.size < MOBILE_ASSIST_LIMIT) {
    addAssistMemoryCandidates({ byPlayer, payload, fixture });
  }

  return [...byPlayer.values()]
    .sort((left, right) => assistRankScore(right) - assistRankScore(left));
}

function addScorerOddsCandidates({ byPlayer, payload, fixture, legs, preferredMarket }) {
  for (const leg of legs) {
    const playerName = leg.playerName || leg.outcome || leg.selectionLabel;

    if (!playerName) {
      continue;
    }

    const baseProbability = Number(leg.modelProbability || leg.rawModelProbability || leg.likelyProbability || 0);
    const probability = leg.market === "first_goalscorer"
      ? clamp(baseProbability, 0.018, 0.34)
      : clamp(baseProbability, 0.04, 0.58);
    const bookmaker = leg.bookmaker ? ` via ${leg.bookmaker}` : "";
    const oddsText = leg.decimalOdds ? ` @ ${Number(leg.decimalOdds).toFixed(2)}` : "";
    const label = leg.market === "first_goalscorer" ? "first-goalscorer odds" : "anytime-scorer odds";

    upsertScorerCandidate(byPlayer, {
      playerName,
      team: playerTeamFromScorerData(leg, fixture),
      probability,
      confidence: Number(leg.confidence || 0.58),
      market: preferredMarket,
      sourceWeight: leg.market === preferredMarket ? 1 : 0.82,
      starterLikelihood: Number(leg.components?.starterLikelihood || 0),
      projectedMinutes: Number(leg.components?.projectedMinutes || 0),
      reason: `${label}${bookmaker}${oddsText}`
    }, payload, fixture);
  }
}

function addAssistOddsCandidates({ byPlayer, payload, fixture, legs }) {
  for (const leg of legs) {
    const playerName = leg.playerName || leg.outcome || leg.selectionLabel;

    if (!playerName) {
      continue;
    }

    const baseProbability = Number(leg.modelProbability || leg.rawModelProbability || leg.likelyProbability || 0);
    const probability = clamp(baseProbability, 0.025, 0.42);
    const bookmaker = leg.bookmaker ? ` via ${leg.bookmaker}` : "";
    const oddsText = leg.decimalOdds ? ` @ ${Number(leg.decimalOdds).toFixed(2)}` : "";

    upsertScorerCandidate(byPlayer, {
      playerName,
      team: playerTeamFromScorerData(leg, fixture),
      probability,
      confidence: Number(leg.confidence || leg.components?.assistConfidence || 0.5),
      market: "anytime_assist",
      sourceWeight: 1.18,
      assistEvidence: Number(leg.components?.assistsPerTwentyTeamMatches || 0),
      creativeRoleScore: Number(leg.components?.creativeRoleScore || 0.5),
      starterLikelihood: Number(leg.components?.starterLikelihood || 0),
      projectedMinutes: Number(leg.components?.projectedMinutes || 0),
      reason: `anytime-assist odds${bookmaker}${oddsText}`
    }, payload, fixture);
  }
}

function addScorerMemoryCandidates({ byPlayer, payload, fixture, mode }) {
  const teamPlayers = payload.playerStats?.teams || {};
  const profiles = payload.teamProfiles?.teams || {};
  const firstScorerMode = mode === "first_goalscorer";

  for (const side of ["home", "away"]) {
    const team = side === "home" ? fixture.homeTeam : fixture.awayTeam;
    const opponent = side === "home" ? fixture.awayTeam : fixture.homeTeam;
    const teamProfile = profiles[team] || {};
    const opponentProfile = profiles[opponent] || {};
    const players = [
      ...(teamPlayers[team] || []),
      ...(teamProfile.topScorers || [])
    ];
    const expectedGoals = clamp(Number(teamProfile.longForm?.xgFor || teamProfile.longForm?.goalsFor || 1.25), 0.45, 2.6);
    const opponentConcede = clamp(Number(opponentProfile.longForm?.xgAgainst || opponentProfile.longForm?.goalsAgainst || 1.25), 0.45, 2.7);
    const teamExpectedGoals = clamp((expectedGoals * 0.65) + (opponentConcede * 0.35), 0.35, 2.8);
    const teamGoalChance = 1 - Math.exp(-teamExpectedGoals);
    const totalGoalsEstimate = Math.max(0.6, teamExpectedGoals + 1.2);
    const teamFirstGoalShare = clamp(teamExpectedGoals / totalGoalsEstimate, 0.18, 0.82);
    const uniquePlayers = dedupePlayers(players).slice(0, 8);
    const topGoalTotal = Math.max(1, uniquePlayers.reduce((total, player) => total + Number(player.goalsPerTwentyTeamMatches || player.goals || 0), 0));

    for (const player of uniquePlayers) {
      const playerGoals = Number(player.goalsPerTwentyTeamMatches || player.goals || 0);

      if (!player.playerName || playerGoals <= 0) {
        continue;
      }

      const scoringRate = clamp(playerGoals / Number(player.matchesSampled || 20), 0.02, 0.85);
      const scorerShare = clamp(playerGoals / (topGoalTotal + 4), 0.04, 0.5);
      const confidence = Number(player.scorerConfidence || teamProfile.intelligenceConfidence || 0.45);
      const anytimeProbability = clamp(
        (scoringRate * 0.43)
          + (teamGoalChance * scorerShare * 0.44)
          + (teamExpectedGoals * scorerShare * 0.12)
          + (confidence * 0.015),
        0.03,
        0.46
      );
      const firstGoalProbability = clamp(anytimeProbability * teamFirstGoalShare * 0.58, 0.018, 0.18);

      upsertScorerCandidate(byPlayer, {
        playerName: player.playerName,
        team,
        probability: firstScorerMode ? firstGoalProbability : anytimeProbability,
        confidence,
        market: mode,
        sourceWeight: firstScorerMode ? 0.28 : 0.72,
        reason: firstScorerMode
          ? `first-scorer fallback from ${round(playerGoals, 1)} goals in last ${Number(player.matchesSampled || 20)} team games`
          : `${round(playerGoals, 1)} goals in last ${Number(player.matchesSampled || 20)} team games`
      }, payload, fixture);
    }
  }
}

function addAssistMemoryCandidates({ byPlayer, payload, fixture }) {
  const teamPlayers = payload.playerStats?.teams || {};
  const profiles = payload.teamProfiles?.teams || {};

  for (const side of ["home", "away"]) {
    const team = side === "home" ? fixture.homeTeam : fixture.awayTeam;
    const opponent = side === "home" ? fixture.awayTeam : fixture.homeTeam;
    const teamProfile = profiles[team] || {};
    const opponentProfile = profiles[opponent] || {};
    const players = dedupeAssistPlayers([
      ...(teamPlayers[team] || []),
      ...(teamProfile.topScorers || [])
    ]).sort((left, right) => assistMemoryRank(right) - assistMemoryRank(left));
    const expectedGoals = clamp(Number(teamProfile.longForm?.xgFor || teamProfile.longForm?.goalsFor || 1.25), 0.45, 2.6);
    const opponentConcede = clamp(Number(opponentProfile.longForm?.xgAgainst || opponentProfile.longForm?.goalsAgainst || 1.25), 0.45, 2.7);
    const teamExpectedGoals = clamp((expectedGoals * 0.65) + (opponentConcede * 0.35), 0.35, 2.8);
    const teamGoalChance = 1 - Math.exp(-teamExpectedGoals);

    for (const player of players.slice(0, 10)) {
      if (!player.playerName) {
        continue;
      }

      const assists = Number(player.assistsPerTwentyTeamMatches || player.assists || 0);
      const goals = Number(player.goalsPerTwentyTeamMatches || player.goals || 0);
      const involvements = Number(player.goalInvolvementsPerTwentyTeamMatches || player.goalInvolvements || assists + goals);
      const assistProxy = assists > 0 ? assists : Math.max(0, involvements * 0.22 + goals * 0.08 + teamExpectedGoals * 0.12);

      if (assistProxy <= 0) {
        continue;
      }

      const sample = Math.max(1, Number(player.matchesSampled || 20));
      const assistRate = clamp(assistProxy / sample, 0.01, 0.45);
      const coverage = Number(player.playerDataCoverage || (assists > 0 ? 0.62 : 0.42));
      const confidence = Number(player.assistConfidence || player.scorerConfidence || coverage || 0.44);
      const creativeRole = clamp(
        Number(player.creativeRoleScore || 0)
          + (assists > 0 ? 0.18 : 0)
          + Math.min(0.12, involvements / 80)
          + Math.min(0.06, teamExpectedGoals / 40),
        0.28,
        assists > 0 ? 0.82 : 0.58
      );
      const probability = clamp(
        (assistRate * 0.46)
          + (teamGoalChance * creativeRole * 0.14)
          + (teamExpectedGoals * creativeRole * 0.035)
          + (confidence * coverage * 0.012),
        0.025,
        assists > 0 ? 0.34 : 0.24
      );

      upsertScorerCandidate(byPlayer, {
        playerName: player.playerName,
        team,
        probability,
        confidence,
        market: "anytime_assist",
        sourceWeight: assists > 0 ? 0.86 : 0.48,
        assistEvidence: assistProxy,
        creativeRoleScore: creativeRole,
        reason: assists > 0
          ? `${round(assists, 1)} assists in last ${sample} team games`
          : `creative-role fallback from ${round(involvements, 1)} goal involvements in last ${sample} team games`
      }, payload, fixture);
    }
  }
}

function upsertScorerCandidate(byPlayer, candidate, payload, fixture) {
  const canonical = canonicalScorerIdentity(candidate, payload, fixture);
  const existingEntry = byPlayer.get(canonical.key)
    ? [canonical.key, byPlayer.get(canonical.key)]
    : [...byPlayer.entries()].find(([, player]) => sameTeam(player.team, candidate.team) && playerNamesMatch(player.playerName, canonical.playerName));
  const key = existingEntry?.[0] || canonical.key;
  const existing = existingEntry?.[1];
  const displayName = betterDisplayPlayerName(canonical.playerName, existing?.playerName || candidate.playerName);

  if (!existing || scorerRankScore(candidate) > scorerRankScore(existing)) {
    byPlayer.set(key, {
      playerName: displayName,
      team: candidate.team,
      probability: round(candidate.probability, 4),
      confidence: round(candidate.confidence, 4),
      market: candidate.market,
      sourceWeight: round(candidate.sourceWeight, 4),
      assistEvidence: candidate.assistEvidence,
      creativeRoleScore: candidate.creativeRoleScore,
      starterLikelihood: candidate.starterLikelihood,
      projectedMinutes: candidate.projectedMinutes,
      reason: trimText(candidate.reason, 180)
    });
  } else if (displayName !== existing.playerName) {
    byPlayer.set(key, { ...existing, playerName: displayName });
  }
}

function canonicalScorerIdentity(candidate, payload, fixture) {
  const team = candidate.team || "";
  const directName = candidate.playerName || "";
  const matched = knownPlayerNamesForTeam(payload, fixture, team)
    .filter((name) => playerNamesMatch(name, directName))
    .sort((left, right) => normalizeName(right).split(/\s+/).filter(Boolean).length - normalizeName(left).split(/\s+/).filter(Boolean).length)[0];
  const playerName = matched ? betterDisplayPlayerName(matched, directName) : directName;

  return {
    key: `${normalizeName(team)}:${normalizeName(playerName)}`,
    playerName
  };
}

function knownPlayerNamesForTeam(payload, fixture, team) {
  const teams = payload?.playerStats?.teams || {};
  const names = [];

  for (const teamName of [team, fixture.homeTeam, fixture.awayTeam]) {
    if (!sameTeam(teamName, team)) {
      continue;
    }

    for (const player of teams[teamName] || []) {
      if (player.playerName) {
        names.push(player.playerName);
      }
    }
  }

  return names
    .filter(Boolean)
    .filter((name, index, items) => items.findIndex((other) => normalizeName(other) === normalizeName(name)) === index);
}

function dedupePlayers(players) {
  const byName = new Map();

  for (const player of players) {
    const key = normalizeName(player.playerName || player.name);

    if (!key) {
      continue;
    }

    const normalized = { ...player, playerName: player.playerName || player.name };
    const existing = byName.get(key);

    if (!existing || Number(normalized.goalsPerTwentyTeamMatches || normalized.goals || 0) > Number(existing.goalsPerTwentyTeamMatches || existing.goals || 0)) {
      byName.set(key, normalized);
    }
  }

  return [...byName.values()];
}

function dedupeAssistPlayers(players) {
  const byName = new Map();

  for (const player of players) {
    const key = normalizeName(player.playerName || player.name);

    if (!key) {
      continue;
    }

    const normalized = { ...player, playerName: player.playerName || player.name };
    const existing = byName.get(key);

    if (!existing || assistMemoryRank(normalized) > assistMemoryRank(existing)) {
      byName.set(key, normalized);
    }
  }

  return [...byName.values()];
}

function assistMemoryRank(player) {
  return Number(player.assistsPerTwentyTeamMatches || player.assists || 0) * 4
    + Number(player.goalInvolvementsPerTwentyTeamMatches || player.goalInvolvements || 0) * 0.7
    + Number(player.goalsPerTwentyTeamMatches || player.goals || 0) * 0.28
    + Number(player.creativeRoleScore || 0) * 2
    + Number(player.playerDataCoverage || 0);
}

function playerTeamFromScorerData(leg, fixture) {
  if (leg.playerTeam) {
    return leg.playerTeam;
  }

  if (leg.team) {
    return leg.team;
  }

  const label = normalizeName(`${leg.selectionLabel || ""} ${leg.outcome || ""}`);

  if (label.includes(normalizeName(fixture.homeTeam))) {
    return fixture.homeTeam;
  }

  if (label.includes(normalizeName(fixture.awayTeam))) {
    return fixture.awayTeam;
  }

  return "";
}

function scorerLegScore(leg) {
  return Number(leg.modelProbability || leg.rawModelProbability || leg.likelyProbability || 0)
    + Number(leg.confidence || 0) * 0.04
    + Number(leg.components?.starterLikelihood || 0) * 0.04;
}

function scorerRankScore(player) {
  return Number(player.probability || 0)
    + Number(player.sourceWeight || 0) * 0.06
    + Number(player.confidence || 0) * 0.03
    + Number(player.starterLikelihood || 0) * 0.025
    + Number(player.projectedMinutes || 0) / 9000;
}

function assistRankScore(player) {
  return Number(player.probability || 0)
    + Number(player.sourceWeight || 0) * 0.045
    + Number(player.confidence || 0) * 0.025
    + Number(player.creativeRoleScore || 0) * 0.02
    + Math.min(0.025, Number(player.assistEvidence || 0) * 0.004)
    + Number(player.starterLikelihood || 0) * 0.018
    + Number(player.projectedMinutes || 0) / 10000;
}

function trimText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();

  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sameTeam(left, right) {
  return normalizeName(left) === normalizeName(right);
}

function playerNamesMatch(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);

  if (!a || !b) {
    return false;
  }

  if (a === b || a.endsWith(` ${b}`) || b.endsWith(` ${a}`)) {
    return true;
  }

  const aSurname = a.split(/\s+/).filter(Boolean).at(-1);
  const bSurname = b.split(/\s+/).filter(Boolean).at(-1);

  return Boolean(aSurname && bSurname && aSurname.length > 3 && aSurname === bSurname);
}

function betterDisplayPlayerName(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const aWords = normalizeName(a).split(/\s+/).filter(Boolean).length;
  const bWords = normalizeName(b).split(/\s+/).filter(Boolean).length;

  if (!a) {
    return b;
  }

  if (!b) {
    return a;
  }

  return bWords > aWords ? b : a;
}

function dateKey(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}
