import { clamp, decimalToImpliedProbability, makeId, mean, normalizeName, round } from "./utils.mjs";

export const EVENT_MARKETS = {
  playerShots: {
    key: "playerShots",
    label: "Player 1+ shot"
  },
  playerShotsOnTarget: {
    key: "playerShotsOnTarget",
    label: "Player 1+ shot on target"
  },
  goalkeeperSaves: {
    key: "goalkeeperSaves",
    label: "Goalkeeper saves"
  },
  teamShots: {
    key: "teamShots",
    label: "Team shots"
  },
  teamShotsOnTarget: {
    key: "teamShotsOnTarget",
    label: "Team shots on target"
  },
  corners: {
    key: "corners",
    label: "Corners"
  },
  teamCards: {
    key: "teamCards",
    label: "Team cards"
  },
  cleanSheets: {
    key: "cleanSheets",
    label: "Clean sheet"
  },
  winToNil: {
    key: "winToNil",
    label: "Win to nil"
  },
  playerCards: {
    key: "playerCards",
    label: "Player to be carded"
  },
  penalties: {
    key: "penalties",
    label: "Penalty awarded"
  },
  redCards: {
    key: "redCards",
    label: "Red card in match"
  }
};

const EVENT_ODDS_MARKETS = [
  "player_shot",
  "player_shot_on_target",
  "goalkeeper_saves",
  "team_shots",
  "team_shots_on_target",
  "total_corners",
  "team_corners",
  "total_cards",
  "team_cards",
  "clean_sheet",
  "win_to_nil",
  "player_card",
  "penalty_awarded",
  "red_card"
];

export function buildLikelyEventsByDate({
  fixtures = [],
  oddsSnapshots = [],
  teamStats = [],
  playerStats = [],
  postMatchStats = [],
  now = new Date(),
  playerLimit = 5
} = {}) {
  const grouped = {};
  const oddsByFixtureMarket = eventOddsByFixtureMarket(oddsSnapshots);
  const teamStatsByName = new Map((teamStats || []).map((team) => [normalizeName(team.team), team]));
  const playersByTeam = playersByTeamMap(playerStats);
  const tournamentProfile = buildTournamentEventProfile(postMatchStats);

  for (const fixture of fixtures || []) {
    const key = dateKey(fixture.date);
    const homeStats = teamStatsByName.get(normalizeName(fixture.homeTeam)) || {};
    const awayStats = teamStatsByName.get(normalizeName(fixture.awayTeam)) || {};
    const fixtureShell = compactFixture(fixture);
    const context = {
      fixture,
      homeStats,
      awayStats,
      playersByTeam,
      tournamentProfile,
      oddsByFixtureMarket,
      now
    };

    if (!grouped[key]) {
      grouped[key] = {
        playerShots: [],
        playerShotsOnTarget: [],
        goalkeeperSaves: [],
        teamShots: [],
        teamShotsOnTarget: [],
        corners: [],
        teamCards: [],
        cleanSheets: [],
        winToNil: [],
        playerCards: [],
        penalties: [],
        redCards: []
      };
    }

    grouped[key].playerShots.push({
      fixture: fixtureShell,
      fixtureLabel: fixtureLabel(fixture),
      players: buildPlayerShotCandidates(context).slice(0, playerLimit)
    });
    grouped[key].playerShotsOnTarget.push({
      fixture: fixtureShell,
      fixtureLabel: fixtureLabel(fixture),
      players: buildPlayerShotOnTargetCandidates(context).slice(0, playerLimit)
    });
    grouped[key].goalkeeperSaves.push({
      fixture: fixtureShell,
      fixtureLabel: fixtureLabel(fixture),
      players: buildGoalkeeperSaveCandidates(context).slice(0, playerLimit)
    });
    grouped[key].teamShots.push({
      fixture: fixtureShell,
      fixtureLabel: fixtureLabel(fixture),
      events: buildTeamVolumeCandidates({
        ...context,
        market: "team_shots",
        label: "Team shots",
        stat: "shots",
        fallbackLines: [8.5, 9.5, 10.5]
      })
    });
    grouped[key].teamShotsOnTarget.push({
      fixture: fixtureShell,
      fixtureLabel: fixtureLabel(fixture),
      events: buildTeamVolumeCandidates({
        ...context,
        market: "team_shots_on_target",
        label: "Team shots on target",
        stat: "shotsOnTarget",
        fallbackLines: [2.5, 3.5, 4.5]
      })
    });
    grouped[key].corners.push({
      fixture: fixtureShell,
      fixtureLabel: fixtureLabel(fixture),
      events: buildCornerCandidates(context)
    });
    grouped[key].teamCards.push({
      fixture: fixtureShell,
      fixtureLabel: fixtureLabel(fixture),
      events: buildTeamCardCandidates(context)
    });
    grouped[key].cleanSheets.push({
      fixture: fixtureShell,
      fixtureLabel: fixtureLabel(fixture),
      events: buildCleanSheetCandidates(context)
    });
    grouped[key].winToNil.push({
      fixture: fixtureShell,
      fixtureLabel: fixtureLabel(fixture),
      events: buildWinToNilCandidates(context)
    });
    grouped[key].playerCards.push({
      fixture: fixtureShell,
      fixtureLabel: fixtureLabel(fixture),
      players: buildPlayerCardCandidates(context).slice(0, playerLimit)
    });
    grouped[key].penalties.push({
      fixture: fixtureShell,
      fixtureLabel: fixtureLabel(fixture),
      events: buildBinaryEventCandidates({
        ...context,
        market: "penalty_awarded",
        label: "Penalty awarded",
        modelProbability: modelPenaltyProbability({ homeStats, awayStats, tournamentProfile })
      })
    });
    grouped[key].redCards.push({
      fixture: fixtureShell,
      fixtureLabel: fixtureLabel(fixture),
      events: buildBinaryEventCandidates({
        ...context,
        market: "red_card",
        label: "Red card in match",
        modelProbability: modelRedCardProbability({ homeStats, awayStats, tournamentProfile })
      })
    });
  }

  return grouped;
}

export function buildTournamentEventProfile(postMatchStats = []) {
  const records = (postMatchStats || []).filter((match) => match && (match.homeTeam || match.awayTeam));
  const count = records.length;
  const penaltyCount = records.filter((match) => Boolean(match.penaltyAwarded) || Number(match.penaltyCount || 0) > 0).length;
  const redCardCount = records.filter((match) => Number(match.homeRedCards || 0) + Number(match.awayRedCards || 0) > 0).length;
  const yellowCardGames = records.filter((match) => Number(match.homeYellowCards || 0) + Number(match.awayYellowCards || 0) > 0);
  const totalYellowCards = records.reduce((total, match) => total + Number(match.homeYellowCards || 0) + Number(match.awayYellowCards || 0), 0);
  const totalRedCards = records.reduce((total, match) => total + Number(match.homeRedCards || 0) + Number(match.awayRedCards || 0), 0);
  const totalFouls = records.reduce((total, match) => total + Number(match.homeFouls || 0) + Number(match.awayFouls || 0), 0);
  const teamMetrics = buildTournamentTeamMetrics(records);
  const shotsPerTeam = averageTeamMetric(records, "homeShots", "awayShots", 11.4);
  const shotsOnTargetPerTeam = averageTeamMetric(records, "homeShotsOnTarget", "awayShotsOnTarget", 3.8);
  const cornersPerTeam = averageTeamMetric(records, "homeCorners", "awayCorners", 4.5);
  const cardsPerTeam = averageDerivedTeamMetric(records, (match, side) => Number(match[`${side}YellowCards`] || 0) + Number(match[`${side}RedCards`] || 0), 2.05, (match) => match.homeYellowCards != null || match.awayYellowCards != null || match.homeRedCards != null || match.awayRedCards != null);
  const keeperSavesPerTeam = averageTeamMetric(records, "homeKeeperSaves", "awayKeeperSaves", 3.1);
  const goalRecords = records.filter((match) => match.homeGoals != null || match.awayGoals != null);
  const cleanSheets = goalRecords.reduce((total, match) => total
    + (Number(match.homeGoals || 0) === 0 ? 1 : 0)
    + (Number(match.awayGoals || 0) === 0 ? 1 : 0), 0);

  return {
    matchCount: count,
    penaltyRate: count ? round(penaltyCount / count, 4) : 0.23,
    redCardRate: count ? round(redCardCount / count, 4) : 0.12,
    yellowCardsPerMatch: count ? round(totalYellowCards / count, 3) : 4.1,
    redCardsPerMatch: count ? round(totalRedCards / count, 3) : 0.14,
    foulsPerMatch: count ? round(totalFouls / count, 2) : 25.5,
    shotsPerTeam,
    shotsOnTargetPerTeam,
    cornersPerTeam,
    cardsPerTeam,
    keeperSavesPerTeam,
    cleanSheetRate: goalRecords.length ? round(cleanSheets / Math.max(1, goalRecords.length * 2), 4) : 0.31,
    cardDataMatchCount: yellowCardGames.length,
    teams: teamMetrics
  };
}

function buildTournamentTeamMetrics(records = []) {
  const teams = {};

  for (const match of records) {
    addTournamentTeamMetric(teams, match.homeTeam, {
      goalsFor: match.homeGoals,
      goalsAgainst: match.awayGoals,
      shotsFor: match.homeShots,
      shotsAgainst: match.awayShots,
      shotsOnTargetFor: match.homeShotsOnTarget,
      shotsOnTargetAgainst: match.awayShotsOnTarget,
      cornersFor: match.homeCorners,
      cornersAgainst: match.awayCorners,
      cardsFor: Number(match.homeYellowCards || 0) + Number(match.homeRedCards || 0),
      cardsAgainst: Number(match.awayYellowCards || 0) + Number(match.awayRedCards || 0),
      keeperSaves: match.homeKeeperSaves
    });
    addTournamentTeamMetric(teams, match.awayTeam, {
      goalsFor: match.awayGoals,
      goalsAgainst: match.homeGoals,
      shotsFor: match.awayShots,
      shotsAgainst: match.homeShots,
      shotsOnTargetFor: match.awayShotsOnTarget,
      shotsOnTargetAgainst: match.homeShotsOnTarget,
      cornersFor: match.awayCorners,
      cornersAgainst: match.homeCorners,
      cardsFor: Number(match.awayYellowCards || 0) + Number(match.awayRedCards || 0),
      cardsAgainst: Number(match.homeYellowCards || 0) + Number(match.homeRedCards || 0),
      keeperSaves: match.awayKeeperSaves
    });
  }

  for (const metric of Object.values(teams)) {
    for (const key of ["goalsFor", "goalsAgainst", "shotsFor", "shotsAgainst", "shotsOnTargetFor", "shotsOnTargetAgainst", "cornersFor", "cornersAgainst", "cardsFor", "cardsAgainst", "keeperSaves"]) {
      metric[key] = round(Number(metric[key] || 0) / Math.max(1, metric.matchCount), 3);
    }

    metric.cleanSheetRate = round(Number(metric.cleanSheets || 0) / Math.max(1, metric.matchCount), 4);
    metric.failedToScoreRate = round(Number(metric.failedToScore || 0) / Math.max(1, metric.matchCount), 4);
  }

  return teams;
}

function addTournamentTeamMetric(teams, team, values = {}) {
  if (!team) {
    return;
  }

  const key = normalizeName(team);
  const metric = teams[key] || {
    team,
    matchCount: 0,
    cleanSheets: 0,
    failedToScore: 0
  };

  metric.matchCount += 1;

  for (const field of ["goalsFor", "goalsAgainst", "shotsFor", "shotsAgainst", "shotsOnTargetFor", "shotsOnTargetAgainst", "cornersFor", "cornersAgainst", "cardsFor", "cardsAgainst", "keeperSaves"]) {
    metric[field] = Number(metric[field] || 0) + Number(values[field] || 0);
  }

  if (Number(values.goalsAgainst || 0) === 0) {
    metric.cleanSheets += 1;
  }

  if (Number(values.goalsFor || 0) === 0) {
    metric.failedToScore += 1;
  }

  teams[key] = metric;
}

function averageTeamMetric(records, homeKey, awayKey, fallback) {
  return averageDerivedTeamMetric(records, (match, side) => Number(match[side === "home" ? homeKey : awayKey]), fallback, (match) => match[homeKey] != null || match[awayKey] != null);
}

function averageDerivedTeamMetric(records, valueFn, fallback, hasMetricFn = () => true) {
  let total = 0;
  let count = 0;

  for (const match of records || []) {
    if (!hasMetricFn(match)) {
      continue;
    }

    for (const side of ["home", "away"]) {
      const value = valueFn(match, side);

      if (Number.isFinite(value)) {
        total += value;
        count += 1;
      }
    }
  }

  return count ? round(total / count, 2) : fallback;
}

function buildPlayerShotOnTargetCandidates(context) {
  const { fixture, playersByTeam, oddsByFixtureMarket } = context;
  const byPlayer = new Map();
  const oddsRecords = oddsRecordsFor(oddsByFixtureMarket, fixture.id, "player_shot_on_target");

  for (const odds of oddsRecords) {
    const playerName = odds.playerName || odds.outcome;
    const team = inferPlayerTeamFromOdds({ odds, fixture, playersByTeam });
    const player = findPlayerRecord(playersByTeam, team, playerName);
    const implied = decimalToImpliedProbability(odds.decimalOdds);
    const modelProbability = modelPlayerShotOnTargetProbability({ ...context, player, team, implied });
    const probability = blendProbability(modelProbability, implied, player ? 0.38 : 0.52);

    upsertPlayerEvent(byPlayer, {
      playerName,
      team,
      probability,
      confidence: confidenceFromPlayerEvidence({ player, odds, hasMarketOdds: true, fallback: 0.62 }),
      sourceWeight: 1.25,
      reason: `1+ shot on target odds via ${odds.bookmaker || odds.source || "public odds"} @ ${Number(odds.decimalOdds || 0).toFixed(2)}`,
      market: "player_shot_on_target",
      decimalOdds: odds.decimalOdds,
      bookmaker: odds.bookmaker || "",
      source: odds.source || ""
    });
  }

  if (byPlayer.size < 5) {
    for (const team of [fixture.homeTeam, fixture.awayTeam]) {
      const candidates = (playersByTeam.get(normalizeName(team)) || [])
        .filter((player) => attackingPlayerEvidence(player) > 0)
        .sort((left, right) => attackingPlayerEvidence(right) - attackingPlayerEvidence(left))
        .slice(0, 8);

      for (const player of candidates) {
        const probability = modelPlayerShotOnTargetProbability({ ...context, player, team });

        upsertPlayerEvent(byPlayer, {
          playerName: player.playerName,
          team,
          probability,
          confidence: confidenceFromPlayerEvidence({ player, fallback: 0.44 }),
          sourceWeight: Number(player.shotsOnTarget || 0) > 0 ? 0.88 : 0.52,
          reason: shotOnTargetReason(player),
          market: "player_shot_on_target"
        });
      }
    }
  }

  return [...byPlayer.values()].sort((left, right) => playerEventRank(right) - playerEventRank(left));
}

function buildPlayerShotCandidates(context) {
  const { fixture, playersByTeam, oddsByFixtureMarket } = context;
  const byPlayer = new Map();
  const oddsRecords = oddsRecordsFor(oddsByFixtureMarket, fixture.id, "player_shot");

  for (const odds of oddsRecords) {
    const playerName = odds.playerName || odds.outcome;
    const team = inferPlayerTeamFromOdds({ odds, fixture, playersByTeam });
    const player = findPlayerRecord(playersByTeam, team, playerName);
    const line = Number(odds.line || 0.5);
    const implied = decimalToImpliedProbability(odds.decimalOdds);
    const modelProbability = modelPlayerShotProbability({ ...context, player, team, line, implied });
    const probability = blendProbability(modelProbability, implied, player ? 0.36 : 0.5);

    upsertPlayerEvent(byPlayer, {
      playerName,
      team,
      probability,
      confidence: confidenceFromPlayerEvidence({ player, odds, hasMarketOdds: true, fallback: 0.63 }),
      sourceWeight: 1.22,
      reason: `player shots odds via ${odds.bookmaker || odds.source || "public odds"}: over ${formatEventLine(line)} @ ${Number(odds.decimalOdds || 0).toFixed(2)}`,
      market: "player_shot",
      decimalOdds: odds.decimalOdds,
      bookmaker: odds.bookmaker || "",
      source: odds.source || "",
      line: formatEventLine(line),
      side: odds.side || "over"
    });
  }

  if (byPlayer.size < 5) {
    for (const team of [fixture.homeTeam, fixture.awayTeam]) {
      const candidates = (playersByTeam.get(normalizeName(team)) || [])
        .filter((player) => attackingPlayerEvidence(player) > 0)
        .sort((left, right) => attackingPlayerEvidence(right) - attackingPlayerEvidence(left))
        .slice(0, 8);

      for (const player of candidates) {
        const probability = modelPlayerShotProbability({ ...context, player, team, line: 0.5 });

        upsertPlayerEvent(byPlayer, {
          playerName: player.playerName,
          team,
          probability,
          confidence: confidenceFromPlayerEvidence({ player, fallback: 0.43 }),
          sourceWeight: Number(player.shots || 0) > 0 ? 0.82 : 0.5,
          reason: playerShotReason(player),
          market: "player_shot",
          line: "0.5",
          side: "over"
        });
      }
    }
  }

  return [...byPlayer.values()].sort((left, right) => playerEventRank(right) - playerEventRank(left));
}

function buildGoalkeeperSaveCandidates(context) {
  const { fixture, playersByTeam, oddsByFixtureMarket } = context;
  const byPlayer = new Map();
  const oddsRecords = oddsRecordsFor(oddsByFixtureMarket, fixture.id, "goalkeeper_saves");

  for (const odds of oddsRecords) {
    const playerName = odds.playerName || odds.outcome;
    const team = inferPlayerTeamFromOdds({ odds, fixture, playersByTeam });
    const player = findPlayerRecord(playersByTeam, team, playerName);
    const line = Number(odds.line || 2.5);
    const implied = decimalToImpliedProbability(odds.decimalOdds);
    const modelProbability = modelGoalkeeperSaveProbability({ ...context, team, line, implied });
    const probability = blendProbability(modelProbability, implied, 0.52);

    upsertPlayerEvent(byPlayer, {
      playerName,
      team,
      probability,
      confidence: confidenceFromPlayerEvidence({ player, odds, hasMarketOdds: true, fallback: 0.56 }),
      sourceWeight: 1.08,
      reason: `keeper saves odds via ${odds.bookmaker || odds.source || "public odds"}: over ${formatEventLine(line)} @ ${Number(odds.decimalOdds || 0).toFixed(2)}`,
      market: "goalkeeper_saves",
      decimalOdds: odds.decimalOdds,
      bookmaker: odds.bookmaker || "",
      source: odds.source || "",
      line: formatEventLine(line),
      side: odds.side || "over"
    });
  }

  return [...byPlayer.values()].sort((left, right) => playerEventRank(right) - playerEventRank(left));
}

function buildPlayerCardCandidates(context) {
  const { fixture, playersByTeam, oddsByFixtureMarket } = context;
  const byPlayer = new Map();
  const oddsRecords = oddsRecordsFor(oddsByFixtureMarket, fixture.id, "player_card");

  for (const odds of oddsRecords) {
    const playerName = odds.playerName || odds.outcome;
    const team = inferPlayerTeamFromOdds({ odds, fixture, playersByTeam });
    const player = findPlayerRecord(playersByTeam, team, playerName);
    const implied = decimalToImpliedProbability(odds.decimalOdds);
    const modelProbability = modelPlayerCardProbability({ ...context, player, team, implied });
    const probability = blendProbability(modelProbability, implied, player ? 0.42 : 0.58);

    upsertPlayerEvent(byPlayer, {
      playerName,
      team,
      probability,
      confidence: confidenceFromPlayerEvidence({ player, odds, hasMarketOdds: true, fallback: 0.58 }),
      sourceWeight: 1.18,
      reason: `player-card odds via ${odds.bookmaker || odds.source || "public odds"} @ ${Number(odds.decimalOdds || 0).toFixed(2)}`,
      market: "player_card",
      decimalOdds: odds.decimalOdds,
      bookmaker: odds.bookmaker || "",
      source: odds.source || ""
    });
  }

  if (byPlayer.size < 5) {
    for (const team of [fixture.homeTeam, fixture.awayTeam]) {
      const candidates = (playersByTeam.get(normalizeName(team)) || [])
        .filter(hasCardFallbackEvidence)
        .sort((left, right) => cardPlayerEvidence(right) - cardPlayerEvidence(left))
        .slice(0, 7);

      for (const player of candidates) {
        const probability = modelPlayerCardProbability({ ...context, player, team });

        upsertPlayerEvent(byPlayer, {
          playerName: player.playerName,
          team,
          probability,
          confidence: confidenceFromPlayerEvidence({ player, fallback: 0.35 }),
          sourceWeight: 0.42,
          reason: cardReason({ player, team, context }),
          market: "player_card"
        });
      }
    }
  }

  return [...byPlayer.values()].sort((left, right) => playerEventRank(right) - playerEventRank(left));
}

function buildBinaryEventCandidates({ fixture, oddsByFixtureMarket, market, label, modelProbability }) {
  const yesRecord = bestOddsRecord(oddsRecordsFor(oddsByFixtureMarket, fixture.id, market).filter((record) => isYesOutcome(record.outcome)));
  const noRecord = bestOddsRecord(oddsRecordsFor(oddsByFixtureMarket, fixture.id, market).filter((record) => isNoOutcome(record.outcome)));
  const yesImplied = yesRecord ? decimalToImpliedProbability(yesRecord.decimalOdds) : 0;
  const noImplied = noRecord ? decimalToImpliedProbability(noRecord.decimalOdds) : 0;
  let yesProbability = modelProbability;
  let reason = "tournament rate, fouls, xG pressure, and team style";
  let confidence = 0.42;

  if (yesImplied && noImplied) {
    const normalizedMarket = yesImplied / Math.max(0.01, yesImplied + noImplied);
    yesProbability = blendProbability(modelProbability, normalizedMarket, 0.54);
    reason = `market yes/no prices via ${yesRecord.bookmaker || noRecord.bookmaker || "public odds"} plus tournament event profile`;
    confidence = 0.66;
  } else if (yesImplied) {
    yesProbability = blendProbability(modelProbability, yesImplied, 0.48);
    reason = `yes price via ${yesRecord.bookmaker || "public odds"} plus tournament event profile`;
    confidence = 0.58;
  }

  yesProbability = clamp(yesProbability, market === "red_card" ? 0.04 : 0.07, market === "red_card" ? 0.32 : 0.46);
  const noProbability = 1 - yesProbability;

  return [
    {
      id: makeId("event", [fixture.id, market, "Yes", yesProbability]),
      event: label,
      outcome: "Yes",
      probability: round(yesProbability, 4),
      confidence: round(confidence, 4),
      reason,
      decimalOdds: yesRecord?.decimalOdds || null,
      bookmaker: yesRecord?.bookmaker || "",
      market
    },
    {
      id: makeId("event", [fixture.id, market, "No", noProbability]),
      event: label,
      outcome: "No",
      probability: round(noProbability, 4),
      confidence: round(confidence, 4),
      reason: yesRecord || noRecord ? "inverse of the yes/no market and model blend" : "inverse of tournament/team event model",
      decimalOdds: noRecord?.decimalOdds || null,
      bookmaker: noRecord?.bookmaker || "",
      market
    }
  ];
}

function buildTeamVolumeCandidates({ fixture, homeStats, awayStats, tournamentProfile, oddsByFixtureMarket, market, label, stat, fallbackLines = [] }) {
  const events = [];
  const oddsRecords = oddsRecordsFor(oddsByFixtureMarket, fixture.id, market);

  for (const odds of oddsRecords) {
    const team = odds.team || teamFromOutcome(odds.outcome, fixture);
    const teamStats = sameTeam(team, fixture.homeTeam) ? homeStats : sameTeam(team, fixture.awayTeam) ? awayStats : {};
    const opponentStats = sameTeam(team, fixture.homeTeam) ? awayStats : sameTeam(team, fixture.awayTeam) ? homeStats : {};
    const line = Number(odds.line || 0);
    const expected = expectedTeamVolume({ team, fixture, teamStats, opponentStats, tournamentProfile, stat });
    const modelProbability = probabilityOverLine(expected, line, statSpread(stat));
    const implied = decimalToImpliedProbability(odds.decimalOdds);
    const probability = blendProbability(modelProbability, implied, 0.46);
    const side = odds.side || "over";

    events.push(teamEvent({
      fixture,
      market,
      event: team ? `${team} ${label.toLowerCase()}` : label,
      outcome: `${capitalized(side)} ${formatEventLine(line)}`,
      probability: side === "under" ? 1 - probability : probability,
      confidence: 0.62,
      reason: `${label.toLowerCase()} odds via ${odds.bookmaker || odds.source || "public odds"}; model expected ${round(expected, 1)}`,
      decimalOdds: odds.decimalOdds,
      bookmaker: odds.bookmaker || "",
      team,
      line: formatEventLine(line),
      side
    }));
  }

  if (!events.length) {
    for (const team of [fixture.homeTeam, fixture.awayTeam]) {
      const teamStats = sameTeam(team, fixture.homeTeam) ? homeStats : awayStats;
      const opponentStats = sameTeam(team, fixture.homeTeam) ? awayStats : homeStats;
      const expected = expectedTeamVolume({ team, fixture, teamStats, opponentStats, tournamentProfile, stat });
      const line = fallbackLineForExpected(expected, fallbackLines);

      events.push(teamEvent({
        fixture,
        market,
        event: `${team} ${label.toLowerCase()}`,
        outcome: `Over ${formatEventLine(line)}`,
        probability: probabilityOverLine(expected, line, statSpread(stat)),
        confidence: stat === "corners" || stat === "cards" ? 0.38 : 0.48,
        reason: `model expected ${round(expected, 1)} from 20-match team profile and tournament actuals`,
        team,
        line: formatEventLine(line),
        side: "over"
      }));
    }
  }

  return events
    .filter((event) => Number(event.probability || 0) > 0)
    .sort((left, right) => teamEventRank(right) - teamEventRank(left))
    .slice(0, 5);
}

function buildCornerCandidates(context) {
  const { fixture, homeStats, awayStats, tournamentProfile, oddsByFixtureMarket } = context;
  const events = [
    ...buildTeamVolumeCandidates({
      ...context,
      market: "team_corners",
      label: "team corners",
      stat: "corners",
      fallbackLines: [2.5, 3.5, 4.5]
    })
  ];
  const totalOdds = oddsRecordsFor(oddsByFixtureMarket, fixture.id, "total_corners");

  for (const odds of totalOdds) {
    const line = Number(odds.line || 8.5);
    const expected = expectedTeamVolume({ team: fixture.homeTeam, fixture, teamStats: homeStats, opponentStats: awayStats, tournamentProfile, stat: "corners" })
      + expectedTeamVolume({ team: fixture.awayTeam, fixture, teamStats: awayStats, opponentStats: homeStats, tournamentProfile, stat: "corners" });
    const modelProbability = probabilityOverLine(expected, line, 2.8);
    const implied = decimalToImpliedProbability(odds.decimalOdds);
    const side = odds.side || "over";

    events.push(teamEvent({
      fixture,
      market: "total_corners",
      event: "Total corners",
      outcome: `${capitalized(side)} ${formatEventLine(line)}`,
      probability: side === "under" ? 1 - blendProbability(modelProbability, implied, 0.46) : blendProbability(modelProbability, implied, 0.46),
      confidence: 0.6,
      reason: `corner-total odds via ${odds.bookmaker || odds.source || "public odds"}; model expected ${round(expected, 1)}`,
      decimalOdds: odds.decimalOdds,
      bookmaker: odds.bookmaker || "",
      line: formatEventLine(line),
      side
    }));
  }

  if (!totalOdds.length) {
    const expected = expectedTeamVolume({ team: fixture.homeTeam, fixture, teamStats: homeStats, opponentStats: awayStats, tournamentProfile, stat: "corners" })
      + expectedTeamVolume({ team: fixture.awayTeam, fixture, teamStats: awayStats, opponentStats: homeStats, tournamentProfile, stat: "corners" });
    const line = fallbackLineForExpected(expected, [7.5, 8.5, 9.5]);

    events.push(teamEvent({
      fixture,
      market: "total_corners",
      event: "Total corners",
      outcome: `Over ${formatEventLine(line)}`,
      probability: probabilityOverLine(expected, line, 2.8),
      confidence: 0.36,
      reason: `model expected ${round(expected, 1)} corners from tournament actuals and pressure profile`,
      line: formatEventLine(line),
      side: "over"
    }));
  }

  return events
    .filter((event) => Number(event.probability || 0) > 0)
    .sort((left, right) => teamEventRank(right) - teamEventRank(left))
    .slice(0, 6);
}

function buildTeamCardCandidates(context) {
  const { fixture, homeStats, awayStats, tournamentProfile, oddsByFixtureMarket } = context;
  const events = buildTeamVolumeCandidates({
    ...context,
    market: "team_cards",
    label: "team cards",
    stat: "cards",
    fallbackLines: [1.5, 2.5, 3.5]
  });
  const totalOdds = oddsRecordsFor(oddsByFixtureMarket, fixture.id, "total_cards");

  for (const odds of totalOdds) {
    const line = Number(odds.line || 3.5);
    const expected = expectedTeamVolume({ team: fixture.homeTeam, fixture, teamStats: homeStats, opponentStats: awayStats, tournamentProfile, stat: "cards" })
      + expectedTeamVolume({ team: fixture.awayTeam, fixture, teamStats: awayStats, opponentStats: homeStats, tournamentProfile, stat: "cards" });
    const modelProbability = probabilityOverLine(expected, line, 1.8);
    const implied = decimalToImpliedProbability(odds.decimalOdds);
    const side = odds.side || "over";

    events.push(teamEvent({
      fixture,
      market: "total_cards",
      event: "Total cards",
      outcome: `${capitalized(side)} ${formatEventLine(line)}`,
      probability: side === "under" ? 1 - blendProbability(modelProbability, implied, 0.46) : blendProbability(modelProbability, implied, 0.46),
      confidence: 0.59,
      reason: `card-total odds via ${odds.bookmaker || odds.source || "public odds"}; model expected ${round(expected, 1)}`,
      decimalOdds: odds.decimalOdds,
      bookmaker: odds.bookmaker || "",
      line: formatEventLine(line),
      side
    }));
  }

  if (!totalOdds.length) {
    const expected = expectedTeamVolume({ team: fixture.homeTeam, fixture, teamStats: homeStats, opponentStats: awayStats, tournamentProfile, stat: "cards" })
      + expectedTeamVolume({ team: fixture.awayTeam, fixture, teamStats: awayStats, opponentStats: homeStats, tournamentProfile, stat: "cards" });
    const line = fallbackLineForExpected(expected, [3.5, 4.5, 5.5]);

    events.push(teamEvent({
      fixture,
      market: "total_cards",
      event: "Total cards",
      outcome: `Over ${formatEventLine(line)}`,
      probability: probabilityOverLine(expected, line, 1.8),
      confidence: 0.36,
      reason: `model expected ${round(expected, 1)} cards from tournament actuals and foul pressure`,
      line: formatEventLine(line),
      side: "over"
    }));
  }

  return events
    .filter((event) => Number(event.probability || 0) > 0)
    .sort((left, right) => teamEventRank(right) - teamEventRank(left))
    .slice(0, 6);
}

function buildCleanSheetCandidates(context) {
  const { fixture, homeStats, awayStats, oddsByFixtureMarket } = context;
  const events = [];
  const oddsRecords = oddsRecordsFor(oddsByFixtureMarket, fixture.id, "clean_sheet");

  for (const odds of oddsRecords) {
    const team = odds.team || teamFromOutcome(odds.outcome, fixture);
    const probability = modelCleanSheetProbability({ ...context, team });
    const implied = decimalToImpliedProbability(odds.decimalOdds);
    const yesProbability = blendProbability(probability, implied, 0.48);
    const outcome = isNoOutcome(odds.outcome) ? "No" : "Yes";

    events.push(teamEvent({
      fixture,
      market: "clean_sheet",
      event: `${team || "Team"} clean sheet`,
      outcome,
      probability: outcome === "No" ? 1 - yesProbability : yesProbability,
      confidence: 0.61,
      reason: `clean-sheet odds via ${odds.bookmaker || odds.source || "public odds"} plus scoring/concession profile`,
      decimalOdds: odds.decimalOdds,
      bookmaker: odds.bookmaker || "",
      team
    }));
  }

  if (!events.length) {
    for (const team of [fixture.homeTeam, fixture.awayTeam]) {
      const yesProbability = modelCleanSheetProbability({ ...context, team });
      const likelyYes = yesProbability >= 0.5;

      events.push(teamEvent({
        fixture,
        market: "clean_sheet",
        event: `${team} clean sheet`,
        outcome: likelyYes ? "Yes" : "No",
        probability: likelyYes ? yesProbability : 1 - yesProbability,
        confidence: 0.46,
        reason: `clean-sheet model from opponent failed-to-score rate, xG against, and tournament actuals`,
        team
      }));
    }
  }

  return events.sort((left, right) => teamEventRank(right) - teamEventRank(left)).slice(0, 4);
}

function buildWinToNilCandidates(context) {
  const { fixture, oddsByFixtureMarket } = context;
  const events = [];
  const oddsRecords = oddsRecordsFor(oddsByFixtureMarket, fixture.id, "win_to_nil");

  for (const odds of oddsRecords) {
    const team = odds.team || teamFromOutcome(odds.outcome, fixture);
    const probability = modelWinToNilProbability({ ...context, team });
    const implied = decimalToImpliedProbability(odds.decimalOdds);
    const yesProbability = blendProbability(probability, implied, 0.5);
    const outcome = isNoOutcome(odds.outcome) ? "No" : "Yes";

    events.push(teamEvent({
      fixture,
      market: "win_to_nil",
      event: `${team || "Team"} win to nil`,
      outcome,
      probability: outcome === "No" ? 1 - yesProbability : yesProbability,
      confidence: 0.59,
      reason: `win-to-nil odds via ${odds.bookmaker || odds.source || "public odds"} plus win and clean-sheet model`,
      decimalOdds: odds.decimalOdds,
      bookmaker: odds.bookmaker || "",
      team
    }));
  }

  if (!events.length) {
    for (const team of [fixture.homeTeam, fixture.awayTeam]) {
      const yesProbability = modelWinToNilProbability({ ...context, team });

      events.push(teamEvent({
        fixture,
        market: "win_to_nil",
        event: `${team} win to nil`,
        outcome: yesProbability >= 0.5 ? "Yes" : "No",
        probability: Math.max(yesProbability, 1 - yesProbability),
        confidence: 0.42,
        reason: `win-to-nil model from team strength, clean-sheet chance, and opponent scoring threat`,
        team
      }));
    }
  }

  return events.sort((left, right) => teamEventRank(right) - teamEventRank(left)).slice(0, 4);
}

function modelPlayerShotOnTargetProbability({ fixture, homeStats, awayStats, player, team, implied = 0 }) {
  const teamStats = sameTeam(team, fixture.homeTeam) ? homeStats : sameTeam(team, fixture.awayTeam) ? awayStats : {};
  const opponentStats = sameTeam(team, fixture.homeTeam) ? awayStats : sameTeam(team, fixture.awayTeam) ? homeStats : {};
  const teamSot = mean([
    Number(teamStats.shotsOnTargetFor || teamStats.longForm?.shotsOnTargetFor || 3.4),
    Number(opponentStats.shotsOnTargetAgainst || opponentStats.longForm?.shotsOnTargetAgainst || 3.4)
  ]);
  const sample = Math.max(1, Number(player?.matchesSampled || 20));
  const directSotRate = Number(player?.shotsOnTarget || 0) / sample;
  const goalsPerTwenty = Number(player?.goalsPerTwentyTeamMatches || player?.goals || 0);
  const shotsPerTwenty = Number(player?.shots || 0);
  const scoringRole = Number(player?.scoringRoleScore || 0.34);
  const fallbackSotRate = clamp((goalsPerTwenty / 20) * 0.72 + (shotsPerTwenty / sample) * 0.18 + scoringRole * 0.08, 0.03, 0.72);
  const sotRate = directSotRate > 0 ? directSotRate : fallbackSotRate;
  const marketAnchor = implied ? implied * 0.12 : 0;

  return clamp(
    0.105
      + sotRate * 0.5
      + teamSot * 0.032
      + scoringRole * 0.07
      + Number(player?.playerDataCoverage || 0) * 0.03
      + marketAnchor,
    0.08,
    0.72
  );
}

function modelPlayerShotProbability({ fixture, homeStats, awayStats, player, team, line = 0.5, implied = 0 }) {
  const teamStats = sameTeam(team, fixture.homeTeam) ? homeStats : sameTeam(team, fixture.awayTeam) ? awayStats : {};
  const opponentStats = sameTeam(team, fixture.homeTeam) ? awayStats : sameTeam(team, fixture.awayTeam) ? homeStats : {};
  const teamShots = mean([
    Number(teamStats.shotsFor || teamStats.longForm?.shotsFor || 10.8),
    Number(opponentStats.shotsAgainst || opponentStats.longForm?.shotsAgainst || 10.8)
  ]);
  const sample = Math.max(1, Number(player?.matchesSampled || 20));
  const directShotRate = Number(player?.shots || 0) / sample;
  const goalsPerTwenty = Number(player?.goalsPerTwentyTeamMatches || player?.goals || 0);
  const scoringRole = Number(player?.scoringRoleScore || 0.34);
  const fallbackShotRate = clamp((goalsPerTwenty / 20) * 1.15 + scoringRole * 0.5 + teamShots * 0.018, 0.08, 1.65);
  const expectedShots = directShotRate > 0 ? directShotRate : fallbackShotRate;
  const lineProbability = probabilityOverLine(expectedShots, Number(line || 0.5), 0.95);
  const marketAnchor = implied ? implied * 0.1 : 0;

  return clamp(lineProbability * 0.88 + teamShots * 0.006 + scoringRole * 0.04 + marketAnchor, 0.1, 0.86);
}

function modelGoalkeeperSaveProbability({ fixture, homeStats, awayStats, tournamentProfile, team, line = 2.5, implied = 0 }) {
  const teamStats = sameTeam(team, fixture.homeTeam) ? homeStats : sameTeam(team, fixture.awayTeam) ? awayStats : {};
  const opponentStats = sameTeam(team, fixture.homeTeam) ? awayStats : sameTeam(team, fixture.awayTeam) ? homeStats : {};
  const teamTournament = teamTournamentMetric(tournamentProfile, team);
  const opponentSot = mean([
    Number(opponentStats.shotsOnTargetFor || opponentStats.longForm?.shotsOnTargetFor || tournamentProfile.shotsOnTargetPerTeam || 3.8),
    Number(teamStats.shotsOnTargetAgainst || teamStats.longForm?.shotsOnTargetAgainst || tournamentProfile.shotsOnTargetPerTeam || 3.8),
    Number(teamTournament.keeperSaves || tournamentProfile.keeperSavesPerTeam || 3.1) + 0.4
  ]);
  const expectedSaves = clamp(opponentSot - Number(opponentStats.goalsFor || opponentStats.longForm?.goalsFor || 1.2) * 0.55, 1.1, 7.4);
  const modelProbability = probabilityOverLine(expectedSaves, Number(line || 2.5), 1.35);

  return clamp(blendProbability(modelProbability, implied, implied ? 0.18 : 0), 0.08, 0.82);
}

function modelPlayerCardProbability({ fixture, homeStats, awayStats, player, team, tournamentProfile, implied = 0 }) {
  const teamStats = sameTeam(team, fixture.homeTeam) ? homeStats : sameTeam(team, fixture.awayTeam) ? awayStats : {};
  const opponentStats = sameTeam(team, fixture.homeTeam) ? awayStats : sameTeam(team, fixture.awayTeam) ? homeStats : {};
  const foulPressure = mean([
    Number(teamStats.longForm?.foulsFor || teamStats.foulsFor || tournamentProfile.foulsPerMatch / 2 || 12.5),
    Number(opponentStats.longForm?.foulsWon || opponentStats.foulsAgainst || tournamentProfile.foulsPerMatch / 2 || 12.5)
  ]);
  const positionRisk = positionCardRisk(player?.position || player?.attackingRole || "");
  const roleRisk = clamp(
    positionRisk
      + (Number(player?.creativeRoleScore || 0) > 0.58 ? 0.015 : 0)
      - (Number(player?.scoringRoleScore || 0) > 0.58 ? 0.012 : 0),
    0.02,
    0.16
  );
  const marketAnchor = implied ? implied * 0.16 : 0;

  return clamp(
    0.075
      + roleRisk
      + clamp((foulPressure - 10.5) * 0.009, -0.018, 0.08)
      + clamp((Number(tournamentProfile.yellowCardsPerMatch || 4.1) - 3.8) * 0.012, -0.015, 0.04)
      + marketAnchor,
    0.055,
    0.38
  );
}

function modelPenaltyProbability({ homeStats, awayStats, tournamentProfile }) {
  const base = clamp(Number(tournamentProfile.penaltyRate || 0.23), 0.14, 0.32);
  const xgPressure = Number(homeStats.xgFor || homeStats.longForm?.xgFor || 1.25)
    + Number(awayStats.xgFor || awayStats.longForm?.xgFor || 1.25);
  const shotPressure = Number(homeStats.shotsFor || homeStats.longForm?.shotsFor || 10.5)
    + Number(awayStats.shotsFor || awayStats.longForm?.shotsFor || 10.5);
  const foulPressure = Number(homeStats.longForm?.foulsFor || homeStats.foulsFor || tournamentProfile.foulsPerMatch / 2 || 12.5)
    + Number(awayStats.longForm?.foulsFor || awayStats.foulsFor || tournamentProfile.foulsPerMatch / 2 || 12.5);

  return clamp(
    base
      + clamp((xgPressure - 2.5) * 0.035, -0.04, 0.055)
      + clamp((shotPressure - 22) * 0.004, -0.025, 0.04)
      + clamp((foulPressure - 25) * 0.0035, -0.02, 0.035),
    0.08,
    0.44
  );
}

function modelRedCardProbability({ homeStats, awayStats, tournamentProfile }) {
  const base = clamp(Number(tournamentProfile.redCardRate || 0.12), 0.06, 0.2);
  const foulPressure = Number(homeStats.longForm?.foulsFor || homeStats.foulsFor || tournamentProfile.foulsPerMatch / 2 || 12.5)
    + Number(awayStats.longForm?.foulsFor || awayStats.foulsFor || tournamentProfile.foulsPerMatch / 2 || 12.5);
  const cardClimate = clamp((Number(tournamentProfile.yellowCardsPerMatch || 4.1) - 4) * 0.018, -0.018, 0.05);

  return clamp(base + cardClimate + clamp((foulPressure - 26) * 0.004, -0.018, 0.045), 0.035, 0.32);
}

function modelCleanSheetProbability({ fixture, homeStats, awayStats, tournamentProfile, team }) {
  const teamStats = sameTeam(team, fixture.homeTeam) ? homeStats : sameTeam(team, fixture.awayTeam) ? awayStats : {};
  const opponentStats = sameTeam(team, fixture.homeTeam) ? awayStats : sameTeam(team, fixture.awayTeam) ? homeStats : {};
  const teamTournament = teamTournamentMetric(tournamentProfile, team);
  const opponentTournament = teamTournamentMetric(tournamentProfile, sameTeam(team, fixture.homeTeam) ? fixture.awayTeam : fixture.homeTeam);
  const cleanSheetRate = mean([
    Number(teamStats.longForm?.cleanSheetRate ?? teamStats.marketAngles?.cleanSheetRate ?? tournamentProfile.cleanSheetRate ?? 0.31),
    Number(teamTournament.cleanSheetRate ?? tournamentProfile.cleanSheetRate ?? 0.31)
  ]);
  const opponentFailedRate = mean([
    Number(opponentStats.longForm?.failedToScoreRate ?? opponentStats.marketAngles?.failedToScoreRate ?? 0.22),
    Number(opponentTournament.failedToScoreRate ?? 0.22)
  ]);
  const opponentXg = Number(opponentStats.xgFor || opponentStats.longForm?.xgFor || 1.25);
  const teamXgAgainst = Number(teamStats.xgAgainst || teamStats.longForm?.xgAgainst || 1.25);

  return clamp(
    0.08
      + cleanSheetRate * 0.34
      + opponentFailedRate * 0.28
      + clamp((1.18 - opponentXg) * 0.12, -0.06, 0.09)
      + clamp((1.18 - teamXgAgainst) * 0.1, -0.05, 0.08),
    0.06,
    0.72
  );
}

function modelWinToNilProbability(context) {
  const { fixture, homeStats, awayStats, team } = context;
  const teamStats = sameTeam(team, fixture.homeTeam) ? homeStats : sameTeam(team, fixture.awayTeam) ? awayStats : {};
  const opponentStats = sameTeam(team, fixture.homeTeam) ? awayStats : sameTeam(team, fixture.awayTeam) ? homeStats : {};
  const cleanSheet = modelCleanSheetProbability(context);
  const ppgGap = Number(teamStats.recentPointsPerGame || teamStats.longForm?.pointsPerGame || 1.5)
    - Number(opponentStats.recentPointsPerGame || opponentStats.longForm?.pointsPerGame || 1.5);
  const xgGap = Number(teamStats.xgFor || teamStats.longForm?.xgFor || 1.25)
    - Number(opponentStats.xgAgainst || opponentStats.longForm?.xgAgainst || 1.25);
  const ratingGap = (Number(teamStats.rating || 1600) - Number(opponentStats.rating || 1600)) / 400;
  const winChance = clamp(0.36 + ppgGap * 0.08 + xgGap * 0.07 + ratingGap * 0.12, 0.14, 0.78);

  return clamp(cleanSheet * winChance * 1.18, 0.035, 0.58);
}

function expectedTeamVolume({ team, fixture, teamStats = {}, opponentStats = {}, tournamentProfile = {}, stat }) {
  const teamTournament = teamTournamentMetric(tournamentProfile, team);
  const opponent = sameTeam(team, fixture.homeTeam) ? fixture.awayTeam : fixture.homeTeam;
  const opponentTournament = teamTournamentMetric(tournamentProfile, opponent);

  if (stat === "shots") {
    return clamp(mean([
      Number(teamStats.shotsFor || teamStats.longForm?.shotsFor || tournamentProfile.shotsPerTeam || 11.4),
      Number(opponentStats.shotsAgainst || opponentStats.longForm?.shotsAgainst || tournamentProfile.shotsPerTeam || 11.4),
      Number(teamTournament.shotsFor || tournamentProfile.shotsPerTeam || 11.4),
      Number(opponentTournament.shotsAgainst || tournamentProfile.shotsPerTeam || 11.4)
    ]), 4.5, 24);
  }

  if (stat === "shotsOnTarget") {
    return clamp(mean([
      Number(teamStats.shotsOnTargetFor || teamStats.longForm?.shotsOnTargetFor || tournamentProfile.shotsOnTargetPerTeam || 3.8),
      Number(opponentStats.shotsOnTargetAgainst || opponentStats.longForm?.shotsOnTargetAgainst || tournamentProfile.shotsOnTargetPerTeam || 3.8),
      Number(teamTournament.shotsOnTargetFor || tournamentProfile.shotsOnTargetPerTeam || 3.8),
      Number(opponentTournament.shotsOnTargetAgainst || tournamentProfile.shotsOnTargetPerTeam || 3.8)
    ]), 1.2, 9.5);
  }

  if (stat === "corners") {
    const pressure = Number(teamStats.shotsFor || teamStats.longForm?.shotsFor || tournamentProfile.shotsPerTeam || 11.4) * 0.08
      + Number(teamStats.setPieceThreat || 50) * 0.012;

    return clamp(mean([
      Number(teamTournament.cornersFor || tournamentProfile.cornersPerTeam || 4.5),
      Number(opponentTournament.cornersAgainst || tournamentProfile.cornersPerTeam || 4.5),
      Number(tournamentProfile.cornersPerTeam || 4.5)
    ]) * 0.78 + pressure, 1.5, 9.5);
  }

  if (stat === "cards") {
    const foulPressure = mean([
      Number(teamStats.longForm?.foulsFor || teamStats.foulsFor || tournamentProfile.foulsPerMatch / 2 || 12.5),
      Number(opponentStats.longForm?.foulsWon || opponentStats.foulsAgainst || tournamentProfile.foulsPerMatch / 2 || 12.5)
    ]);

    return clamp(mean([
      Number(teamTournament.cardsFor || tournamentProfile.cardsPerTeam || 2.05),
      Number(opponentTournament.cardsAgainst || tournamentProfile.cardsPerTeam || 2.05),
      Number(tournamentProfile.cardsPerTeam || 2.05)
    ]) * 0.74 + foulPressure * 0.055, 0.6, 5.8);
  }

  return Number(tournamentProfile[`${stat}PerTeam`] || 3);
}

function teamTournamentMetric(tournamentProfile = {}, team) {
  return tournamentProfile.teams?.[normalizeName(team)] || {};
}

function probabilityOverLine(expected, line, spread = 1.4) {
  const x = (Number(expected || 0) - (Number(line || 0) + 0.35)) / Math.max(0.45, Number(spread || 1.4));
  return clamp(1 / (1 + Math.exp(-x)), 0.04, 0.94);
}

function statSpread(stat) {
  if (stat === "shots") {
    return 3.9;
  }

  if (stat === "shotsOnTarget") {
    return 1.55;
  }

  if (stat === "corners") {
    return 2.1;
  }

  if (stat === "cards") {
    return 1.25;
  }

  return 1.6;
}

function fallbackLineForExpected(expected, lines = []) {
  const sorted = [...lines].map(Number).filter(Number.isFinite).sort((left, right) => left - right);

  if (!sorted.length) {
    return Math.max(0.5, Math.floor(Number(expected || 1) - 0.5) + 0.5);
  }

  return sorted.findLast((line) => probabilityOverLine(expected, line, statSpread("generic")) >= 0.58)
    ?? sorted[0];
}

function teamEvent({ fixture, market, event, outcome, probability, confidence, reason, decimalOdds = null, bookmaker = "", team = "", line = "", side = "" }) {
  return {
    id: makeId("event", [fixture.id, market, event, outcome, team, line, side]),
    event,
    outcome,
    probability: round(clamp(Number(probability || 0), 0.01, 0.99), 4),
    confidence: round(clamp(Number(confidence || 0), 0.18, 0.86), 4),
    reason: trimText(reason, 180),
    decimalOdds: decimalOdds || null,
    bookmaker,
    market,
    team,
    line,
    side
  };
}

function teamEventRank(event) {
  return Number(event.probability || 0)
    + Number(event.confidence || 0) * 0.045
    + (event.decimalOdds ? 0.015 : 0);
}

function eventOddsByFixtureMarket(oddsSnapshots = []) {
  const byFixtureMarket = new Map();

  for (const record of oddsSnapshots || []) {
    if (!EVENT_ODDS_MARKETS.includes(record.market)) {
      continue;
    }

    const key = `${record.fixtureId}|${record.market}`;
    const bucket = byFixtureMarket.get(key) || [];
    bucket.push(record);
    byFixtureMarket.set(key, bucket);
  }

  return byFixtureMarket;
}

function oddsRecordsFor(oddsByFixtureMarket, fixtureId, market) {
  return (oddsByFixtureMarket.get(`${fixtureId}|${market}`) || [])
    .filter((record) => Number(record.decimalOdds) > 1)
    .sort((left, right) => new Date(right.capturedAt || 0) - new Date(left.capturedAt || 0));
}

function bestOddsRecord(records = []) {
  if (!records.length) {
    return null;
  }

  return records.reduce((winner, record) => {
    if (!winner) {
      return record;
    }

    const reliabilityGap = Number(record.sourceReliability || 0) - Number(winner.sourceReliability || 0);

    if (Math.abs(reliabilityGap) > 0.08) {
      return reliabilityGap > 0 ? record : winner;
    }

    return new Date(record.capturedAt || 0) > new Date(winner.capturedAt || 0) ? record : winner;
  }, null);
}

function playersByTeamMap(playerStats = []) {
  const byTeam = new Map();

  for (const player of playerStats || []) {
    if (!player?.team || !player?.playerName) {
      continue;
    }

    const key = normalizeName(player.team);
    const bucket = byTeam.get(key) || [];
    bucket.push(player);
    byTeam.set(key, bucket);
  }

  return byTeam;
}

function inferPlayerTeamFromOdds({ odds, fixture, playersByTeam }) {
  if (sameTeam(odds.playerTeam, fixture.homeTeam)) {
    return fixture.homeTeam;
  }

  if (sameTeam(odds.playerTeam, fixture.awayTeam)) {
    return fixture.awayTeam;
  }

  for (const team of [fixture.homeTeam, fixture.awayTeam]) {
    if (findPlayerRecord(playersByTeam, team, odds.playerName || odds.outcome)) {
      return team;
    }
  }

  return odds.playerTeam || "";
}

function findPlayerRecord(playersByTeam, team, playerName) {
  const normalized = normalizeName(playerName);
  const surname = normalized.split(/\s+/).filter(Boolean).at(-1);

  for (const player of playersByTeam.get(normalizeName(team)) || []) {
    const candidate = normalizeName(player.playerName);

    if (candidate === normalized || candidate.endsWith(` ${normalized}`) || normalized.endsWith(` ${candidate}`)) {
      return player;
    }

    if (surname && surname.length > 3 && candidate.endsWith(` ${surname}`)) {
      return player;
    }
  }

  return null;
}

function upsertPlayerEvent(byPlayer, event) {
  if (!event.playerName) {
    return;
  }

  const key = playerEventKey(byPlayer, event);
  const existing = byPlayer.get(key);
  const normalized = {
    id: makeId("event_player", [event.market, event.team, event.playerName, event.line || "", event.side || ""]),
    playerName: event.playerName,
    team: event.team || "",
    probability: round(event.probability, 4),
    confidence: round(event.confidence, 4),
    sourceWeight: round(event.sourceWeight, 4),
    reason: trimText(event.reason, 180),
    market: event.market,
    line: event.line || "",
    side: event.side || "",
    decimalOdds: event.decimalOdds || null,
    bookmaker: event.bookmaker || "",
    source: event.source || ""
  };

  if (!existing || playerEventRank(normalized) > playerEventRank(existing)) {
    byPlayer.set(key, normalized);
  }
}

function playerEventKey(byPlayer, event) {
  const team = normalizeName(event.team);
  const playerName = normalizeName(event.playerName);

  for (const [key, existing] of byPlayer.entries()) {
    if (normalizeName(existing.team) === team && equivalentPlayerEventName(existing.playerName, event.playerName)) {
      return key;
    }
  }

  return `${team}|${playerName}`;
}

function equivalentPlayerEventName(left, right) {
  const leftName = normalizeName(left);
  const rightName = normalizeName(right);

  if (!leftName || !rightName) {
    return false;
  }

  return leftName === rightName
    || (leftName.length > 3 && rightName.endsWith(` ${leftName}`))
    || (rightName.length > 3 && leftName.endsWith(` ${rightName}`));
}

function playerEventRank(player) {
  return Number(player.probability || 0)
    + Number(player.confidence || 0) * 0.04
    + Number(player.sourceWeight || 0) * 0.035
    + (player.decimalOdds ? 0.012 : 0);
}

function attackingPlayerEvidence(player = {}) {
  return Number(player.shotsOnTarget || 0) * 1.4
    + Number(player.shots || 0) * 0.24
    + Number(player.goalsPerTwentyTeamMatches || player.goals || 0) * 0.9
    + Number(player.goalInvolvementsPerTwentyTeamMatches || 0) * 0.38
    + Number(player.scoringRoleScore || 0) * 2;
}

function cardPlayerEvidence(player = {}) {
  return positionCardRisk(player.position || player.attackingRole || "") * 10
    + Number(player.yellowCards || player.cards || 0) * 1.8
    + Number(player.redCards || 0) * 2.4
    + Number(player.playerDataCoverage || 0)
    + Number(player.creativeRoleScore || 0) * 0.35
    - Number(player.scoringRoleScore || 0) * 0.2
    + Number(player.matchesSampled || 0) * 0.005;
}

function hasCardFallbackEvidence(player = {}) {
  if (!player.playerName) {
    return false;
  }

  if (Number(player.yellowCards || player.cards || player.redCards || 0) > 0) {
    return true;
  }

  const role = normalizeName(player.position || player.attackingRole || "");

  if (!role || role === "unknown") {
    return false;
  }

  return positionCardRisk(role) >= 0.1;
}

function positionCardRisk(value) {
  const text = normalizeName(value);

  if (/\b(?:defender|centre back|center back|full back|left back|right back|cb|lb|rb)\b/.test(text)) {
    return 0.135;
  }

  if (/\b(?:defensive midfielder|midfielder|dm|cm)\b/.test(text)) {
    return 0.112;
  }

  if (/\b(?:wing back|wide midfielder)\b/.test(text)) {
    return 0.104;
  }

  if (/\b(?:forward|striker|winger|attacking)\b/.test(text)) {
    return 0.062;
  }

  return 0.085;
}

function confidenceFromPlayerEvidence({ player, odds = null, hasMarketOdds = false, fallback }) {
  const coverage = Number(player?.playerDataCoverage || 0);
  const sample = Math.min(20, Number(player?.matchesSampled || 0)) / 20;
  const marketLift = hasMarketOdds ? 0.22 : 0;
  const oddsLift = odds?.decimalOdds ? 0.06 : 0;

  return clamp(fallback + coverage * 0.18 + sample * 0.08 + marketLift + oddsLift, 0.2, 0.86);
}

function shotOnTargetReason(player = {}) {
  const sample = Number(player.matchesSampled || 20);
  const shotsOnTarget = Number(player.shotsOnTarget || 0);

  if (shotsOnTarget > 0) {
    return `${round(shotsOnTarget, 1)} shots on target in last ${sample} sampled team games`;
  }

  return `attacking-role fallback from ${round(Number(player.goalsPerTwentyTeamMatches || player.goals || 0), 1)} goals/20 and team shot volume`;
}

function cardReason({ player, team, context }) {
  const teamStats = sameTeam(team, context.fixture.homeTeam) ? context.homeStats : context.awayStats;
  const fouls = Number(teamStats.longForm?.foulsFor || teamStats.foulsFor || context.tournamentProfile.foulsPerMatch / 2 || 12.5);
  const role = player.position || player.attackingRole || "role";

  return `${role} card-risk fallback with ${round(fouls, 1)} team fouls profile; no player-card odds found`;
}

function playerShotReason(player = {}) {
  const sample = Number(player.matchesSampled || 20);
  const shots = Number(player.shots || 0);

  if (shots > 0) {
    return `${round(shots, 1)} shots in last ${sample} sampled team games`;
  }

  return `attacking-role fallback from ${round(Number(player.goalsPerTwentyTeamMatches || player.goals || 0), 1)} goals/20 and team shot volume`;
}

function blendProbability(model, market, marketWeight) {
  if (!market) {
    return model;
  }

  return clamp(model * (1 - marketWeight) + market * marketWeight, 0.01, 0.95);
}

function isYesOutcome(outcome) {
  return /^yes\b/i.test(String(outcome || ""));
}

function isNoOutcome(outcome) {
  return /^no\b/i.test(String(outcome || ""));
}

function compactFixture(fixture = {}) {
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

function fixtureLabel(fixture) {
  return `${fixture.homeTeam} vs ${fixture.awayTeam}`;
}

function teamFromOutcome(outcome, fixture) {
  const normalized = normalizeName(outcome);

  for (const team of [fixture.homeTeam, fixture.awayTeam]) {
    const teamName = normalizeName(team);

    if (normalized === teamName || normalized.includes(teamName)) {
      return team;
    }
  }

  return "";
}

function formatEventLine(value) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return String(value || "").trim();
  }

  const rounded = Math.round(numeric * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/0+$/, "").replace(/\.$/, "");
}

function capitalized(value) {
  const text = String(value || "");
  return text ? `${text.slice(0, 1).toUpperCase()}${text.slice(1).toLowerCase()}` : "";
}

function sameTeam(left, right) {
  return normalizeName(left) === normalizeName(right);
}

function dateKey(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function trimText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();

  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3)).trim()}...`;
}
