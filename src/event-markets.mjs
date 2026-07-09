import { clamp, decimalToImpliedProbability, makeId, mean, normalizeName, round } from "./utils.mjs";

export const EVENT_MARKETS = {
  playerShotsOnTarget: {
    key: "playerShotsOnTarget",
    label: "Player 1+ shot on target"
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
        playerShotsOnTarget: [],
        playerCards: [],
        penalties: [],
        redCards: []
      };
    }

    grouped[key].playerShotsOnTarget.push({
      fixture: fixtureShell,
      fixtureLabel: fixtureLabel(fixture),
      players: buildPlayerShotOnTargetCandidates(context).slice(0, playerLimit)
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

  return {
    matchCount: count,
    penaltyRate: count ? round(penaltyCount / count, 4) : 0.23,
    redCardRate: count ? round(redCardCount / count, 4) : 0.12,
    yellowCardsPerMatch: count ? round(totalYellowCards / count, 3) : 4.1,
    redCardsPerMatch: count ? round(totalRedCards / count, 3) : 0.14,
    foulsPerMatch: count ? round(totalFouls / count, 2) : 25.5,
    cardDataMatchCount: yellowCardGames.length
  };
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

function eventOddsByFixtureMarket(oddsSnapshots = []) {
  const byFixtureMarket = new Map();

  for (const record of oddsSnapshots || []) {
    if (!["player_shot_on_target", "player_card", "penalty_awarded", "red_card"].includes(record.market)) {
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
    id: makeId("event_player", [event.market, event.team, event.playerName]),
    playerName: event.playerName,
    team: event.team || "",
    probability: round(event.probability, 4),
    confidence: round(event.confidence, 4),
    sourceWeight: round(event.sourceWeight, 4),
    reason: trimText(event.reason, 180),
    market: event.market,
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
