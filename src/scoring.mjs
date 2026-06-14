import { clamp, daysBetween, decimalToImpliedProbability, hoursBetween, latestBy, logistic, makeId, mean, normalizeName, round } from "./utils.mjs";
import { buildOddsMovementSummaries, outcomeLearningAdjustment } from "./intelligence-memory.mjs";
import { buildHeatImpact } from "./heat-model.mjs";

export function buildLegCandidates({ fixtures, oddsSnapshots, newsArticles, teamStats, policy, now = new Date(), outcomeLearning = null, heatSnapshots = [], squadDepthRecords = [], playerStats = [] }) {
  const statsByTeam = new Map(teamStats.map((team) => [normalizeName(team.team), team]));
  const latestOdds = bestLatestOddsByOutcome(oddsSnapshots);
  const latestOddsRecords = [...latestOdds.values()];
  const oddsMovement = buildOddsMovementSummaries(oddsSnapshots);
  const newsByTeam = buildNewsByTeam(newsArticles, policy, now);
  const heatByFixture = latestHeatByFixture(heatSnapshots);
  const squadDepthByTeam = latestSquadDepthByTeam(squadDepthRecords);
  const playerStatsByKey = latestPlayerStatsByKey(playerStats);
  const tournamentContextByFixture = buildTournamentContextByFixture(fixtures);
  const candidates = [];

  for (const fixture of fixtures) {
    const homeStats = statsByTeam.get(normalizeName(fixture.homeTeam));
    const awayStats = statsByTeam.get(normalizeName(fixture.awayTeam));

    if (!homeStats || !awayStats) {
      continue;
    }

    const model = fixtureModel({
      fixture,
      homeStats,
      awayStats,
      newsByTeam,
      marketSnapshot: fixtureMarketSnapshot({ fixture, latestOdds }),
      heatRecord: heatByFixture.get(fixture.id),
      homeSquadDepth: squadDepthByTeam.get(normalizeName(fixture.homeTeam)),
      awaySquadDepth: squadDepthByTeam.get(normalizeName(fixture.awayTeam)),
      tournamentContext: tournamentContextByFixture.get(fixture.id)
    });

    for (const market of policy.markets || []) {
      const probabilities = model.marketProbabilities[market];

      if (!probabilities) {
        continue;
      }

      const rawProbabilities = model.rawMarketProbabilities?.[market] || probabilities;

      for (const [outcome, modelProbability] of Object.entries(probabilities)) {
        const odds = latestOdds.get(outcomeKey(fixture.id, market, outcome));
        const movement = oddsMovement.get(outcomeKey(fixture.id, market, outcome));

        if (!odds) {
          continue;
        }

        const candidate = scoreLeg({
          fixture,
          market,
          outcome,
          modelProbability,
          rawModelProbability: rawProbabilities[outcome],
          odds,
          movement,
          model,
          policy,
          now,
          outcomeLearning
        });

        candidates.push(candidate);
      }
    }

    for (const scorerMarket of ["anytime_scorer", "first_goalscorer"]) {
      if (!(policy.markets || []).includes(scorerMarket)) {
        continue;
      }

      for (const odds of latestOddsRecords.filter((record) => record.fixtureId === fixture.id && record.market === scorerMarket)) {
        const scorerProbability = estimateScorerProbability({ fixture, odds, market: scorerMarket, homeStats, awayStats, model, playerStatsByKey });
        const movement = oddsMovement.get(outcomeKey(fixture.id, scorerMarket, odds.outcome));

        candidates.push(scoreLeg({
          fixture,
          market: scorerMarket,
          outcome: odds.outcome,
          modelProbability: scorerProbability.modelProbability,
          rawModelProbability: scorerProbability.rawModelProbability,
          odds: {
            ...odds,
            playerTeam: odds.playerTeam || scorerProbability.components.playerTeam
          },
          movement,
          model,
          policy,
          now,
          outcomeLearning,
          extraComponents: scorerProbability.components
        }));
      }
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

function estimateScorerProbability({ fixture, odds, market, homeStats, awayStats, model, playerStatsByKey }) {
  const implied = decimalToImpliedProbability(odds.decimalOdds);
  const playerTeam = inferPlayerTeam(odds, fixture);
  const playerName = odds.playerName || odds.outcome;
  const playerRecord = findPlayerRecord({ playerStatsByKey, team: playerTeam, playerName });
  const expectedGoals = Number(model.components.expectedGoals || 2.5);
  const homeAttack = (Number(homeStats.xgFor || 1.3) + Number(awayStats.xgAgainst || 1.2)) / 2;
  const awayAttack = (Number(awayStats.xgFor || 1.3) + Number(homeStats.xgAgainst || 1.2)) / 2;
  const teamAttack = playerTeam === fixture.homeTeam ? homeAttack : playerTeam === fixture.awayTeam ? awayAttack : mean([homeAttack, awayAttack]);
  const totalAttack = Math.max(0.2, homeAttack + awayAttack);
  const teamFirstGoalShare = playerTeam === fixture.homeTeam
    ? homeAttack / totalAttack
    : playerTeam === fixture.awayTeam
      ? awayAttack / totalAttack
      : 0.5;
  const teamGoalLikelihood = clamp(0.32 + teamAttack * 0.18 + expectedGoals * 0.045, 0.28, 0.84);
  const roleLikelihood = clamp(0.2 + implied * 0.78, 0.16, 0.62);
  const scorerSampleRate = playerRecord
    ? Number(playerRecord.goals || 0) / Math.max(1, Number(playerRecord.matchesSampled || 0))
    : 0;
  const scorerLift = playerRecord
    ? clamp(scorerSampleRate * Number(playerRecord.scorerConfidence || 0.35) * 0.16, 0, 0.075)
    : 0;
  const rawRoleLikelihood = playerRecord
    ? clamp(0.11 + scorerSampleRate * 0.85 + teamAttack * 0.035 + expectedGoals * 0.012, 0.07, 0.46)
    : clamp(0.08 + teamAttack * 0.032 + expectedGoals * 0.01, 0.06, 0.2);
  const newsLift = playerTeam === fixture.homeTeam
    ? Number(model.components.homeNewsImpact || 0) * 0.035
    : playerTeam === fixture.awayTeam
      ? Number(model.components.awayNewsImpact || 0) * 0.035
      : 0;
  const rawModelProbability = clamp(teamGoalLikelihood * rawRoleLikelihood + scorerLift + newsLift, 0.035, 0.48);
  const marketAdjustedProbability = blendProbability(rawModelProbability, implied, playerRecord ? 0.28 : 0.42);
  const firstGoalRawProbability = clamp(
    (teamGoalLikelihood * teamFirstGoalShare * rawRoleLikelihood * 0.78)
    + scorerLift * 0.42
    + newsLift * 0.55,
    0.018,
    0.28
  );
  const firstGoalAdjustedProbability = blendProbability(firstGoalRawProbability, implied, playerRecord ? 0.24 : 0.38);
  const starterLikelihood = clamp(0.26 + implied * 1.04 + scorerSampleRate * 0.32 + Number(playerRecord?.scorerConfidence || 0.28) * 0.08, 0.22, 0.9);
  const projectedMinutes = round(28 + starterLikelihood * 64, 1);
  const isFirstScorer = market === "first_goalscorer";

  return {
    rawModelProbability: round(isFirstScorer ? firstGoalRawProbability : rawModelProbability, 4),
    modelProbability: round(isFirstScorer
      ? clamp((firstGoalAdjustedProbability * 0.82) + (teamGoalLikelihood * teamFirstGoalShare * roleLikelihood * 0.18), 0.018, 0.34)
      : clamp((marketAdjustedProbability * 0.74) + (teamGoalLikelihood * roleLikelihood * 0.26), 0.04, 0.58), 4),
    components: {
      playerTeam,
      starterLikelihood: round(starterLikelihood, 4),
      projectedMinutes,
      scorerMarketType: isFirstScorer ? "first_goalscorer" : "anytime_scorer",
      teamGoalLikelihood: round(teamGoalLikelihood, 4),
      teamFirstGoalShare: round(teamFirstGoalShare, 4),
      scorerSampleRate: round(scorerSampleRate, 4),
      scorerGoalsPerTwentyTeamMatches: round(scorerSampleRate * 20, 3),
      scorerConfidence: round(Number(playerRecord?.scorerConfidence || 0), 4),
      scorerMatchesSampled: Number(playerRecord?.matchesSampled || 0),
      playerMinutesSource: playerRecord
        ? "public scorer sample plus market role estimate"
        : "market role estimate until public scorer sample improves"
    }
  };
}

function findPlayerRecord({ playerStatsByKey, team, playerName }) {
  const exact = playerStatsByKey.get(playerStatKey(team, playerName));

  if (exact) {
    return exact;
  }

  const normalizedPlayer = normalizeName(playerName);
  const tokens = normalizedPlayer.split(/\s+/).filter((part) => part.length > 2);
  const surname = tokens.at(-1);

  if (!surname) {
    return null;
  }

  for (const [key, record] of playerStatsByKey.entries()) {
    if (team && !key.startsWith(`${normalizeName(team)}|`)) {
      continue;
    }

    const recordName = normalizeName(record.playerName || "");

    if (recordName === normalizedPlayer || recordName.endsWith(` ${surname}`) || recordName === surname || normalizedPlayer.endsWith(` ${recordName}`)) {
      return record;
    }
  }

  return null;
}

function inferPlayerTeam(odds, fixture) {
  const explicit = odds.playerTeam || "";

  if (teamTextMatches(explicit, fixture.homeTeam)) {
    return fixture.homeTeam;
  }

  if (teamTextMatches(explicit, fixture.awayTeam)) {
    return fixture.awayTeam;
  }

  return "";
}

export function bestLatestOddsByOutcome(oddsSnapshots) {
  const latest = latestBy(oddsSnapshots, (record) => outcomeKey(record.fixtureId, record.market, record.outcome), "capturedAt");
  const best = new Map();

  for (const [key, latestRecord] of latest.entries()) {
    const sameMoment = oddsSnapshots.filter((record) => {
      return outcomeKey(record.fixtureId, record.market, record.outcome) === key
        && record.capturedAt === latestRecord.capturedAt;
    });
    const bestRecord = sameMoment.reduce((winner, record) => Number(record.decimalOdds) > Number(winner.decimalOdds) ? record : winner, latestRecord);
    best.set(key, bestRecord);
  }

  return best;
}

function latestHeatByFixture(heatSnapshots) {
  return latestBy(
    heatSnapshots.filter((record) => record?.fixtureId),
    (record) => record.fixtureId,
    "capturedAt"
  );
}

function latestSquadDepthByTeam(squadDepthRecords) {
  return latestBy(
    squadDepthRecords.filter((record) => record?.team),
    (record) => normalizeName(record.team),
    "capturedAt"
  );
}

function latestPlayerStatsByKey(playerStats) {
  return latestBy(
    playerStats.filter((record) => record?.team && record?.playerName),
    (record) => playerStatKey(record.team, record.playerName),
    "updatedAt"
  );
}

function fixtureMarketSnapshot({ fixture, latestOdds }) {
  const matchWinner = normalizeMatchWinnerMarket({
    home: latestOdds.get(outcomeKey(fixture.id, "match_winner", fixture.homeTeam)),
    draw: latestOdds.get(outcomeKey(fixture.id, "match_winner", "Draw")),
    away: latestOdds.get(outcomeKey(fixture.id, "match_winner", fixture.awayTeam))
  });
  const btts = normalizeTwoOutcomeMarket({
    yes: latestOdds.get(outcomeKey(fixture.id, "both_teams_to_score", "Yes")),
    no: latestOdds.get(outcomeKey(fixture.id, "both_teams_to_score", "No")),
    yesKey: "yes",
    noKey: "no"
  });
  const over25 = normalizeTwoOutcomeMarket({
    yes: latestOdds.get(outcomeKey(fixture.id, "over_2_5_goals", "Over")),
    no: latestOdds.get(outcomeKey(fixture.id, "under_2_5_goals", "Under")),
    yesKey: "over",
    noKey: "under"
  });

  return {
    matchWinner,
    btts,
    over25
  };
}

function normalizeMatchWinnerMarket({ home, draw, away }) {
  if (!home || !draw || !away) {
    return null;
  }

  const rawHome = decimalToImpliedProbability(home.decimalOdds);
  const rawDraw = decimalToImpliedProbability(draw.decimalOdds);
  const rawAway = decimalToImpliedProbability(away.decimalOdds);
  const total = rawHome + rawDraw + rawAway || 1;

  return {
    homeWin: round(rawHome / total, 4),
    draw: round(rawDraw / total, 4),
    awayWin: round(rawAway / total, 4),
    confidence: round(clamp(mean([home.sourceReliability, draw.sourceReliability, away.sourceReliability].map((value) => value ?? 0.72)), 0.4, 0.82), 4),
    bookmakerCount: new Set([home.bookmaker, draw.bookmaker, away.bookmaker].filter(Boolean)).size
  };
}

function normalizeTwoOutcomeMarket({ yes, no, yesKey, noKey }) {
  if (!yes || !no) {
    return null;
  }

  const rawYes = decimalToImpliedProbability(yes.decimalOdds);
  const rawNo = decimalToImpliedProbability(no.decimalOdds);
  const total = rawYes + rawNo || 1;

  return {
    [yesKey]: round(rawYes / total, 4),
    [noKey]: round(rawNo / total, 4),
    confidence: round(clamp(mean([yes.sourceReliability ?? 0.72, no.sourceReliability ?? 0.72]), 0.4, 0.82), 4),
    bookmakerCount: new Set([yes.bookmaker, no.bookmaker].filter(Boolean)).size
  };
}

export function buildTournamentContextByFixture(fixtures = []) {
  const byFixture = new Map();
  const groupFixtures = [...fixtures]
    .filter(isGroupStageFixture)
    .sort((left, right) => new Date(left.date || 0) - new Date(right.date || 0));
  const canonicalByPair = new Map();

  for (const fixture of groupFixtures) {
    const key = tournamentPairKey(fixture);

    if (!key || canonicalByPair.has(key)) {
      continue;
    }

    canonicalByPair.set(key, fixture);
  }

  const teamAppearances = new Map();
  const contextByPair = new Map();

  for (const fixture of [...canonicalByPair.values()].sort((left, right) => new Date(left.date || 0) - new Date(right.date || 0))) {
    const homeKey = normalizeName(fixture.homeTeam);
    const awayKey = normalizeName(fixture.awayTeam);
    const homeGroupGameNumber = (teamAppearances.get(homeKey) || 0) + 1;
    const awayGroupGameNumber = (teamAppearances.get(awayKey) || 0) + 1;
    const context = buildTournamentContext({ fixture, homeGroupGameNumber, awayGroupGameNumber });

    contextByPair.set(tournamentPairKey(fixture), context);
    teamAppearances.set(homeKey, homeGroupGameNumber);
    teamAppearances.set(awayKey, awayGroupGameNumber);
  }

  for (const fixture of fixtures) {
    if (!isGroupStageFixture(fixture)) {
      byFixture.set(fixture.id, neutralTournamentContext(fixture));
      continue;
    }

    const context = contextByPair.get(tournamentPairKey(fixture)) || neutralTournamentContext(fixture);
    byFixture.set(fixture.id, {
      ...context,
      fixtureId: fixture.id,
      sourceFixtureId: context.fixtureId,
      duplicateFixture: Boolean(context.fixtureId && context.fixtureId !== fixture.id)
    });
  }

  return byFixture;
}

function buildTournamentContext({ fixture, homeGroupGameNumber, awayGroupGameNumber }) {
  const bothOpeningGroupGame = homeGroupGameNumber === 1 && awayGroupGameNumber === 1;
  const oneOpeningGroupGame = !bothOpeningGroupGame && (homeGroupGameNumber === 1 || awayGroupGameNumber === 1);
  const maxGameNumber = Math.max(homeGroupGameNumber, awayGroupGameNumber);
  const phase = bothOpeningGroupGame
    ? "opening_group_game"
    : oneOpeningGroupGame
      ? "mixed_opening_group_game"
      : maxGameNumber >= 3
        ? "final_group_game"
        : maxGameNumber === 2
          ? "middle_group_game"
          : "group_game";
  const note = bothOpeningGroupGame
    ? "Both teams are playing their first group game, so the model adds a small don't-lose-first caution to goal-heavy bets."
    : oneOpeningGroupGame
      ? "One team is in its first group game, so the model adds a lighter opening-game caution."
      : maxGameNumber >= 3
        ? "Final group-game pressure is noted, but the model waits for live standings before forcing a tactical lean."
        : "Middle group game: no automatic opening-game caution.";

  return {
    fixtureId: fixture.id,
    phase,
    homeGroupGameNumber,
    awayGroupGameNumber,
    bothOpeningGroupGame,
    oneOpeningGroupGame,
    note
  };
}

function neutralTournamentContext(fixture = {}) {
  return {
    fixtureId: fixture.id,
    phase: isGroupStageFixture(fixture) ? "group_game" : "non_group_game",
    homeGroupGameNumber: null,
    awayGroupGameNumber: null,
    bothOpeningGroupGame: false,
    oneOpeningGroupGame: false,
    note: isGroupStageFixture(fixture)
      ? "Group context is available, but no opening-game caution applies."
      : "Tournament pressure layer inactive outside group-stage fixtures."
  };
}

function buildTournamentPressure({ context, expectedGoals, homeExpectedGoals, awayExpectedGoals }) {
  const openingCaution = context?.bothOpeningGroupGame
    ? 1
    : context?.oneOpeningGroupGame
      ? 0.58
      : 0;
  const lowerGoalThreat = Math.min(Number(homeExpectedGoals || 0), Number(awayExpectedGoals || 0));
  const goalStrengthRelief = clamp((Number(expectedGoals || 2.5) - 2.7) / 0.9, 0, 0.45);
  const balanceRelief = clamp((lowerGoalThreat - 0.95) / 0.5, 0, 0.25);
  const expectedGoalsAdjustment = openingCaution
    ? -clamp((0.13 - goalStrengthRelief * 0.055 - balanceRelief * 0.025) * openingCaution, 0.035, 0.13)
    : 0;
  const bttsAdjustment = openingCaution
    ? -clamp((0.026 - balanceRelief * 0.012) * openingCaution, 0.006, 0.026)
    : 0;
  const drawLift = openingCaution
    ? clamp(0.017 * openingCaution, 0.006, 0.018)
    : 0;

  return {
    phase: context?.phase || "unknown",
    homeGroupGameNumber: context?.homeGroupGameNumber ?? null,
    awayGroupGameNumber: context?.awayGroupGameNumber ?? null,
    bothOpeningGroupGame: Boolean(context?.bothOpeningGroupGame),
    oneOpeningGroupGame: Boolean(context?.oneOpeningGroupGame),
    openingCaution,
    expectedGoalsAdjustment: round(expectedGoalsAdjustment, 4),
    bttsAdjustment: round(bttsAdjustment, 4),
    drawLift: round(drawLift, 4),
    note: context?.note || "Tournament pressure context unavailable."
  };
}

function applyTournamentPressureToGoalShape(goalShape, tournamentPressure) {
  const adjustment = Number(tournamentPressure?.expectedGoalsAdjustment || 0);

  if (!adjustment) {
    return goalShape;
  }

  const homeExpectedGoals = Number(goalShape.homeExpectedGoals || 0);
  const awayExpectedGoals = Number(goalShape.awayExpectedGoals || 0);
  const total = Math.max(0.1, homeExpectedGoals + awayExpectedGoals);
  const homeShare = clamp(homeExpectedGoals / total, 0.22, 0.78);
  const awayShare = 1 - homeShare;

  return {
    ...goalShape,
    homeExpectedGoals: clamp(homeExpectedGoals + adjustment * homeShare, 0.18, 3.2),
    awayExpectedGoals: clamp(awayExpectedGoals + adjustment * awayShare, 0.18, 3.2),
    expectedGoals: clamp(total + adjustment, 1.25, 4.1)
  };
}

function openingOver25CautionAdjustment({ tournamentPressure, goalShape, shotShape }) {
  const openingCaution = Number(tournamentPressure?.openingCaution || 0);

  if (openingCaution <= 0) {
    return 0;
  }

  const expectedGoals = Number(goalShape?.expectedGoals || 0);
  const lowerGoalThreat = Math.min(Number(goalShape?.homeExpectedGoals || 0), Number(goalShape?.awayExpectedGoals || 0));
  const goalImbalance = Math.abs(Number(goalShape?.homeExpectedGoals || 0) - Number(goalShape?.awayExpectedGoals || 0));
  const totalShots = Math.max(1, Number(shotShape?.totalShots || 0));
  const shotImbalance = Math.abs(Number(shotShape?.homeShots || 0) - Number(shotShape?.awayShots || 0)) / totalShots;
  const baseCaution = 0.028;
  const totalGoalDrag = clamp((3.05 - expectedGoals) * 0.028, 0, 0.04);
  const lowerThreatDrag = clamp((1.06 - lowerGoalThreat) * 0.055, 0, 0.038);
  const imbalanceDrag = clamp((goalImbalance - 0.48) * 0.018 + (shotImbalance - 0.22) * 0.045, 0, 0.032);
  const strongTwoSidedRelief = clamp((expectedGoals - 3.18) * 0.02 + (lowerGoalThreat - 1.18) * 0.045, 0, 0.028);
  const penalty = clamp((baseCaution + totalGoalDrag + lowerThreatDrag + imbalanceDrag - strongTwoSidedRelief) * openingCaution, 0.012, 0.088);

  return round(-penalty, 4);
}

function isGroupStageFixture(fixture = {}) {
  const stage = String(fixture.stage || fixture.round || "").toLowerCase();

  if (/round of|quarter|semi|final|play[- ]?off|knockout/.test(stage)) {
    return false;
  }

  return !stage || /group|first stage|stage 1/.test(stage);
}

function tournamentPairKey(fixture = {}) {
  const teams = [normalizeName(fixture.homeTeam), normalizeName(fixture.awayTeam)]
    .filter(Boolean)
    .sort();

  return teams.length === 2 ? teams.join("|") : "";
}

export function fixtureModel({ fixture, homeStats, awayStats, newsByTeam, marketSnapshot = null, heatRecord = null, homeSquadDepth = null, awaySquadDepth = null, tournamentContext = null }) {
  const homeNews = newsByTeam.get(fixture.homeTeam) || neutralNews();
  const awayNews = newsByTeam.get(fixture.awayTeam) || neutralNews();
  const heat = buildHeatImpact({ fixture, heatRecord, homeSquadDepth, awaySquadDepth });
  const ratingEdge = clamp(Number(homeStats.rating || 1700) - Number(awayStats.rating || 1700), -180, 180);
  const formEdge = clamp((Number(homeStats.recentPointsPerGame || 1.4) - Number(awayStats.recentPointsPerGame || 1.4)) * 42, -75, 75);
  const xgEdge = clamp(((Number(homeStats.xgFor || 1.3) - Number(awayStats.xgAgainst || 1.2)) - (Number(awayStats.xgFor || 1.3) - Number(homeStats.xgAgainst || 1.2))) * 48, -90, 90);
  const styleDetails = styleMatchupDetails(homeStats, awayStats);
  const styleEdge = clamp(styleDetails.edge, -65, 65);
  const newsEdge = clamp((homeNews.netImpact - awayNews.netImpact) * 95, -55, 55);
  const memoryEdge = clamp((Number(homeStats.learnedEdge || 0) - Number(awayStats.learnedEdge || 0)) * 88, -45, 45);
  const marketMemoryEdge = clamp((Number(homeStats.memoryOddsPressure || 0) - Number(awayStats.memoryOddsPressure || 0)) * 28, -22, 22);
  const marketResultEdge = marketSnapshot?.matchWinner
    ? clamp((Number(marketSnapshot.matchWinner.homeWin || 0.37) - Number(marketSnapshot.matchWinner.awayWin || 0.37)) * 74 * Number(marketSnapshot.matchWinner.confidence || 0.5), -50, 50)
    : 0;
  const heatEdge = Number(heat.resultEdgeAdjustment || 0);
  const independentResultEdge = clamp(ratingEdge + formEdge + xgEdge + styleEdge + newsEdge + memoryEdge + heatEdge, -220, 220);
  const totalEdge = clamp(independentResultEdge + marketMemoryEdge + marketResultEdge, -240, 240);
  const baseGoalShape = goalShapeForFixture(homeStats, awayStats, homeNews, awayNews, heat, {
    ratingEdge,
    xgEdge,
    homeSquadDepth,
    awaySquadDepth
  });
  const tournamentPressure = buildTournamentPressure({
    context: tournamentContext,
    expectedGoals: baseGoalShape.expectedGoals,
    homeExpectedGoals: baseGoalShape.homeExpectedGoals,
    awayExpectedGoals: baseGoalShape.awayExpectedGoals
  });
  const rawDrawProbability = clamp(0.265 - Math.abs(independentResultEdge) / 2500 + defensiveDrawLift(homeStats, awayStats) + Number(heat.drawLift || 0) + Number(tournamentPressure.drawLift || 0), 0.17, 0.35);
  const drawProbability = marketSnapshot?.matchWinner
    ? blendProbability(rawDrawProbability, marketSnapshot.matchWinner.draw, 0.14 * Number(marketSnapshot.matchWinner.confidence || 0.5))
    : rawDrawProbability;
  const rawHomeShare = logistic(independentResultEdge / 210);
  const homeShare = logistic(totalEdge / 210);
  const rawHomeWin = clamp((1 - rawDrawProbability) * rawHomeShare, 0.05, 0.82);
  const rawAwayWin = clamp((1 - rawDrawProbability) * (1 - rawHomeShare), 0.05, 0.82);
  const homeWin = clamp((1 - drawProbability) * homeShare, 0.05, 0.82);
  const awayWin = clamp((1 - drawProbability) * (1 - homeShare), 0.05, 0.82);
  const rawNormalizedTotal = rawHomeWin + rawAwayWin + rawDrawProbability;
  const normalizedTotal = homeWin + awayWin + drawProbability;
  const goalShape = applyTournamentPressureToGoalShape(baseGoalShape, tournamentPressure);
  const expectedGoals = goalShape.expectedGoals;
  const shotShape = projectedShotShapeForFixture({ homeStats, awayStats, goalShape, heat });
  const rawOver15 = poissonOver(expectedGoals, 1.5);
  const baseRawOver25 = poissonOver25(expectedGoals);
  const openingOver25Adjustment = openingOver25CautionAdjustment({ tournamentPressure, goalShape, shotShape });
  const rawOver25 = clamp(baseRawOver25 + openingOver25Adjustment, 0.08, 0.78);
  const rawUnder35 = poissonUnder(expectedGoals, 3.5);
  const rawUnder45 = poissonUnder(expectedGoals, 4.5);
  const rawBttsYes = round(clamp(
    poissonBothTeamsToScore(goalShape.homeExpectedGoals, goalShape.awayExpectedGoals, heat) + Number(tournamentPressure.bttsAdjustment || 0),
    0.16,
    0.68
  ), 4);
  const over25 = marketSnapshot?.over25
    ? blendProbability(rawOver25, marketSnapshot.over25.over, 0.14 * Number(marketSnapshot.over25.confidence || 0.5))
    : rawOver25;
  const bttsYes = marketSnapshot?.btts
    ? blendProbability(rawBttsYes, marketSnapshot.btts.yes, 0.15 * Number(marketSnapshot.btts.confidence || 0.5))
    : rawBttsYes;

  return {
    fixtureId: fixture.id,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    components: {
      ratingEdge: round(ratingEdge, 2),
      formEdge: round(formEdge, 2),
      xgEdge: round(xgEdge, 2),
      styleEdge: round(styleEdge, 2),
      buildUpEdge: round(styleDetails.buildUpEdge, 2),
      pressBuildEdge: round(styleDetails.pressBuildEdge, 2),
      homeManager: homeStats.manager || "",
      awayManager: awayStats.manager || "",
      homeLikelyFormation: homeStats.tacticalProfile?.likelyFormation || "",
      awayLikelyFormation: awayStats.tacticalProfile?.likelyFormation || "",
      homeStyleOfPlay: homeStats.tacticalProfile?.styleOfPlay || "",
      awayStyleOfPlay: awayStats.tacticalProfile?.styleOfPlay || "",
      homeStyleTags: homeStats.tacticalProfile?.styleTags || [],
      awayStyleTags: awayStats.tacticalProfile?.styleTags || [],
      homePassCompletion: nullableComponent(homeStats.passCompletion || homeStats.passing?.completion),
      awayPassCompletion: nullableComponent(awayStats.passCompletion || awayStats.passing?.completion),
      homePassesAttempted: nullableComponent(homeStats.passesAttempted || homeStats.passing?.attempted),
      awayPassesAttempted: nullableComponent(awayStats.passesAttempted || awayStats.passing?.attempted),
      homeTopScorers: (homeStats.topScorers || homeStats.scorerSummary || []).slice(0, 5).map((scorer) => scorer.playerName || scorer.name).filter(Boolean),
      awayTopScorers: (awayStats.topScorers || awayStats.scorerSummary || []).slice(0, 5).map((scorer) => scorer.playerName || scorer.name).filter(Boolean),
      newsEdge: round(newsEdge, 2),
      memoryEdge: round(memoryEdge, 2),
      independentResultEdge: round(independentResultEdge, 2),
      marketMemoryEdge: round(marketMemoryEdge, 2),
      marketResultEdge: round(marketResultEdge, 2),
      marketConfidence: round(Number(marketSnapshot?.matchWinner?.confidence || 0), 4),
      marketHomeWinProbability: nullableComponent(marketSnapshot?.matchWinner?.homeWin),
      marketDrawProbability: nullableComponent(marketSnapshot?.matchWinner?.draw),
      marketAwayWinProbability: nullableComponent(marketSnapshot?.matchWinner?.awayWin),
      marketBttsYesProbability: nullableComponent(marketSnapshot?.btts?.yes),
      marketOver25Probability: nullableComponent(marketSnapshot?.over25?.over),
      heatEdge: round(heatEdge, 2),
      tournamentPhase: tournamentPressure.phase,
      homeGroupGameNumber: tournamentPressure.homeGroupGameNumber,
      awayGroupGameNumber: tournamentPressure.awayGroupGameNumber,
      bothOpeningGroupGame: tournamentPressure.bothOpeningGroupGame,
      oneOpeningGroupGame: tournamentPressure.oneOpeningGroupGame,
      openingGameCaution: round(Number(tournamentPressure.openingCaution || 0), 3),
      tournamentExpectedGoalsAdjustment: round(Number(tournamentPressure.expectedGoalsAdjustment || 0), 3),
      tournamentBttsAdjustment: round(Number(tournamentPressure.bttsAdjustment || 0), 4),
      tournamentDrawLift: round(Number(tournamentPressure.drawLift || 0), 4),
      openingOver25Adjustment: round(openingOver25Adjustment, 4),
      tournamentContextNote: tournamentPressure.note,
      qualityGapEdge: round(Number(goalShape.qualityGapEdge || 0), 2),
      qualityGapPressure: round(Number(goalShape.qualityGapPressure || 0), 4),
      homeQualityGoalAdjustment: round(Number(goalShape.homeQualityGoalAdjustment || 0), 3),
      awayQualityGoalAdjustment: round(Number(goalShape.awayQualityGoalAdjustment || 0), 3),
      expectedGoals: round(expectedGoals, 2),
      homeExpectedGoals: round(goalShape.homeExpectedGoals, 2),
      awayExpectedGoals: round(goalShape.awayExpectedGoals, 2),
      projectedShotTotal: round(shotShape.totalShots, 2),
      homeProjectedShots: round(shotShape.homeShots, 2),
      awayProjectedShots: round(shotShape.awayShots, 2),
      projectedShotsOnTargetTotal: round(shotShape.totalShotsOnTarget, 2),
      homeProjectedShotsOnTarget: round(shotShape.homeShotsOnTarget, 2),
      awayProjectedShotsOnTarget: round(shotShape.awayShotsOnTarget, 2),
      bttsShapeProbability: round(bttsYes, 4),
      over15ShapeProbability: round(rawOver15, 4),
      preOpeningOver25ShapeProbability: round(baseRawOver25, 4),
      over25ShapeProbability: round(over25, 4),
      under35ShapeProbability: round(rawUnder35, 4),
      under45ShapeProbability: round(rawUnder45, 4),
      rawHomeWinProbability: round(rawHomeWin / rawNormalizedTotal, 4),
      rawDrawProbability: round(rawDrawProbability / rawNormalizedTotal, 4),
      rawAwayWinProbability: round(rawAwayWin / rawNormalizedTotal, 4),
      rawBttsShapeProbability: round(rawBttsYes, 4),
      rawOver15ShapeProbability: round(rawOver15, 4),
      rawOver25ShapeProbability: round(rawOver25, 4),
      rawUnder35ShapeProbability: round(rawUnder35, 4),
      rawUnder45ShapeProbability: round(rawUnder45, 4),
      homeLongMatchCount: Number(homeStats.longForm?.matchCount || homeStats.sourceMatchCount || 0),
      awayLongMatchCount: Number(awayStats.longForm?.matchCount || awayStats.sourceMatchCount || 0),
      homeBttsRate: nullableComponent(homeStats.marketAngles?.bttsRate || homeStats.longForm?.bttsRate),
      awayBttsRate: nullableComponent(awayStats.marketAngles?.bttsRate || awayStats.longForm?.bttsRate),
      homeOver25Rate: nullableComponent(homeStats.marketAngles?.over25Rate || homeStats.longForm?.over25Rate),
      awayOver25Rate: nullableComponent(awayStats.marketAngles?.over25Rate || awayStats.longForm?.over25Rate),
      homeCleanSheetRate: nullableComponent(homeStats.marketAngles?.cleanSheetRate || homeStats.longForm?.cleanSheetRate),
      awayCleanSheetRate: nullableComponent(awayStats.marketAngles?.cleanSheetRate || awayStats.longForm?.cleanSheetRate),
      homeNewsImpact: round(homeNews.netImpact, 3),
      awayNewsImpact: round(awayNews.netImpact, 3),
      heatStress: round(Number(heat.heatStress || 0), 4),
      heatConfidence: round(Number(heat.confidence || 0), 4),
      heatClimateBand: heat.climateBand || "",
      heatExpectedGoalsAdjustment: round(Number(heat.expectedGoalsAdjustment || 0), 3),
      heatBttsAdjustment: round(Number(heat.bttsAdjustment || 0), 4),
      heatLocation: heat.location || "",
      heatNotes: heat.notes || "",
      homeClimateAdaptation: nullableComponent(heat.homeClimateAdaptation),
      awayClimateAdaptation: nullableComponent(heat.awayClimateAdaptation),
      homeHistoricalHeatMemory: round(Number(heat.homeHistoricalHeatMemory || 0), 4),
      awayHistoricalHeatMemory: round(Number(heat.awayHistoricalHeatMemory || 0), 4),
      homeSquadDepth: nullableComponent(heat.homeSquadDepth),
      awaySquadDepth: nullableComponent(heat.awaySquadDepth),
      squadDepthConfidence: round(Number(heat.squadDepthConfidence || 0), 4),
      heatHistoryDifferential: round(Number(heat.historyDifferential || 0), 4),
      heatSquadDepthDifferential: round(Number(heat.squadDepthDifferential || 0), 4),
      combinedHeatDifferential: round(Number(heat.combinedHeatDifferential || 0), 4),
      homeLearnedEdge: round(Number(homeStats.learnedEdge || 0), 4),
      awayLearnedEdge: round(Number(awayStats.learnedEdge || 0), 4),
      intelligenceConfidence: round(mean([
        homeStats.intelligenceConfidence || homeStats.statsCompleteness || 0.45,
        awayStats.intelligenceConfidence || awayStats.statsCompleteness || 0.45
      ]), 3),
      dataCompleteness: round(mean([
        homeStats.statsCompleteness,
        awayStats.statsCompleteness,
        homeNews.confidence,
        awayNews.confidence,
        homeStats.intelligenceConfidence,
        awayStats.intelligenceConfidence
      ]), 3)
    },
    rawMarketProbabilities: {
      match_winner: {
        [fixture.homeTeam]: round(rawHomeWin / rawNormalizedTotal, 4),
        Draw: round(rawDrawProbability / rawNormalizedTotal, 4),
        [fixture.awayTeam]: round(rawAwayWin / rawNormalizedTotal, 4)
      },
      draw_no_bet: {
        [fixture.homeTeam]: round(rawHomeWin / (rawHomeWin + rawAwayWin), 4),
        [fixture.awayTeam]: round(rawAwayWin / (rawHomeWin + rawAwayWin), 4)
      },
      double_chance: doubleChanceProbabilities({
        fixture,
        homeWin: rawHomeWin / rawNormalizedTotal,
        draw: rawDrawProbability / rawNormalizedTotal,
        awayWin: rawAwayWin / rawNormalizedTotal
      }),
      both_teams_to_score: {
        Yes: round(rawBttsYes, 4),
        No: round(1 - rawBttsYes, 4)
      },
      over_1_5_goals: {
        Over: round(rawOver15, 4)
      },
      over_2_5_goals: {
        Over: round(rawOver25, 4)
      },
      under_2_5_goals: {
        Under: round(1 - rawOver25, 4)
      },
      under_3_5_goals: {
        Under: round(rawUnder35, 4)
      },
      under_4_5_goals: {
        Under: round(rawUnder45, 4)
      }
    },
    marketProbabilities: {
      match_winner: {
        [fixture.homeTeam]: round(homeWin / normalizedTotal, 4),
        Draw: round(drawProbability / normalizedTotal, 4),
        [fixture.awayTeam]: round(awayWin / normalizedTotal, 4)
      },
      draw_no_bet: {
        [fixture.homeTeam]: round(homeWin / (homeWin + awayWin), 4),
        [fixture.awayTeam]: round(awayWin / (homeWin + awayWin), 4)
      },
      double_chance: doubleChanceProbabilities({
        fixture,
        homeWin: homeWin / normalizedTotal,
        draw: drawProbability / normalizedTotal,
        awayWin: awayWin / normalizedTotal
      }),
      both_teams_to_score: {
        Yes: round(bttsYes, 4),
        No: round(1 - bttsYes, 4)
      },
      over_1_5_goals: {
        Over: round(rawOver15, 4)
      },
      over_2_5_goals: {
        Over: round(over25, 4)
      },
      under_2_5_goals: {
        Under: round(1 - over25, 4)
      },
      under_3_5_goals: {
        Under: round(rawUnder35, 4)
      },
      under_4_5_goals: {
        Under: round(rawUnder45, 4)
      }
    }
  };
}

function scoreLeg({ fixture, market, outcome, modelProbability, rawModelProbability, odds, movement, model, policy, now, outcomeLearning, extraComponents = {} }) {
  const legModel = {
    ...model,
    components: {
      ...(model.components || {}),
      ...(extraComponents || {})
    }
  };
  const adjustedModelProbability = clamp(Number(modelProbability || 0), 0.03, 0.92);
  const independentModelProbability = clamp(Number(rawModelProbability ?? modelProbability ?? 0), 0.03, 0.92);
  const impliedProbability = decimalToImpliedProbability(odds.decimalOdds);
  const marketImpliedProbability = movement?.marketImpliedProbability || impliedProbability;
  const priceEdge = adjustedModelProbability - impliedProbability;
  const marketEdge = adjustedModelProbability - marketImpliedProbability;
  const independentEdge = independentModelProbability - marketImpliedProbability;
  const edge = independentEdge * 0.58 + priceEdge * 0.28 + marketEdge * 0.14;
  const marketBlendLift = adjustedModelProbability - independentModelProbability;
  const oddsAgeHours = hoursBetween(odds.capturedAt, now);
  const oddsFreshness = clamp(1 - oddsAgeHours / (policy.sourceRequirements?.maxOddsAgeHours || 30), 0, 1);
  const dataCompleteness = legModel.components.dataCompleteness;
  const intelligenceConfidence = legModel.components.intelligenceConfidence;
  const bookmakerCoverage = movement?.bookmakerCount || 1;
  const marketConfirmation = movement?.shortening && edge > 0 ? 1 : 0;
  const contrarianValue = movement?.drifting && edge > 0 && Number(odds.decimalOdds) >= policy.riskProfile.minDecimalOddsForRiskLeg ? 1 : 0;
  const oddsDisagreement = Math.max(0, Number(movement?.bestOverAverage || 0));
  const independentEvidence = evaluateIndependentEvidence({
    fixture,
    market,
    outcome,
    model: legModel,
    modelProbability: adjustedModelProbability,
    rawModelProbability: independentModelProbability,
    marketImpliedProbability,
    independentEdge
  });
  const preliminaryRiskTag = classifyRiskTag({
    decimalOdds: odds.decimalOdds,
    impliedProbability,
    edge,
    independentEdge,
    rawModelProbability: independentModelProbability,
    modelProbability: adjustedModelProbability,
    movement,
    contrarianValue
  });
  const learning = outcomeLearningAdjustment({ market, riskTag: preliminaryRiskTag, outcomeLearning, model: legModel });
  const marketFocus = evaluateMarketFocus({ market, outcome, model: legModel, modelProbability: adjustedModelProbability, edge, odds, policy });
  const learnedModelProbability = clamp(adjustedModelProbability + learning.adjustment * learning.confidence, 0.03, 0.92);
  const learnedIndependentProbability = clamp(independentModelProbability + learning.adjustment * learning.confidence * 0.55, 0.03, 0.92);
  const learnedEdge = learnedModelProbability - impliedProbability;
  const learnedIndependentEdge = learnedIndependentProbability - marketImpliedProbability;
  const evidenceConfidence = clamp(Number(independentEvidence.count || 0) / 4, 0, 1);
  const confidence = clamp(
    (independentModelProbability * 0.32)
    + (dataCompleteness * 0.22)
    + (intelligenceConfidence * 0.16)
    + (oddsFreshness * 0.12)
    + (evidenceConfidence * 0.12)
    + Math.min(0.04, bookmakerCoverage * 0.01)
    + marketConfirmation * Number(policy.riskProfile.marketConfirmationWeight || 0.2),
    0,
    1
  );
  const favoriteCrowdingPenalty = impliedProbability > policy.riskProfile.maxFavoriteImpliedProbability ? (impliedProbability - policy.riskProfile.maxFavoriteImpliedProbability) * 42 : 0;
  const valueOddsBonus = Number(odds.decimalOdds) >= policy.riskProfile.minDecimalOddsForRiskLeg ? 3.5 : 0;
  const oddsMovementBonus = clamp(
    marketConfirmation * 3
    + contrarianValue * Number(policy.riskProfile.contrarianWeight || 0.1) * 12
    + oddsDisagreement * Number(policy.riskProfile.valueHuntingWeight || 0.2) * 28,
    -4,
    8
  );
  const intelligenceBonus = clamp((intelligenceConfidence - 0.5) * 12 + (dataCompleteness - 0.55) * 7, -8, 9);
  const marketFocusBonus = marketFocus.score;
  const evidenceBonus = clamp(Number(independentEvidence.count || 0) * 2.1 + Number(independentEvidence.strength || 0) * 2.5, 0, 11);
  const marketBlendPenalty = clamp(Math.max(0, marketBlendLift - 0.04) * 55, 0, 9);
  const edgeScore = clamp(edge * 0.64 + learnedEdge * 0.18 + learnedIndependentEdge * 0.18, -0.05, 0.2) * 100;
  const independentEdgeScore = clamp(learnedIndependentEdge, -0.05, 0.16) * 92;
  const probabilityScore = learnedModelProbability * 23;
  const confidenceScore = confidence * 18;
  const rawScore = 28 + edgeScore + independentEdgeScore + probabilityScore + confidenceScore + evidenceBonus + valueOddsBonus + oddsMovementBonus + intelligenceBonus + marketFocusBonus - favoriteCrowdingPenalty - marketBlendPenalty;
  const score = clamp(compressTopScore(rawScore), 0, 100);
  const hardBlocks = [];

  if (edge < policy.riskProfile.minLegEdge) {
    hardBlocks.push("edge_below_policy_minimum");
  }

  if (independentEdge < Number(policy.riskProfile.minIndependentEdge ?? 0)) {
    hardBlocks.push("independent_edge_below_policy_minimum");
  }

  if (Number(independentEvidence.count || 0) < Number(policy.riskProfile.minNonMarketSignals || 2)) {
    hardBlocks.push("insufficient_non_market_evidence");
  }

  if (confidence < policy.riskProfile.minLegConfidence) {
    hardBlocks.push("confidence_below_policy_minimum");
  }

  if (intelligenceConfidence < Number(policy.riskProfile.minIntelligenceConfidence || 0)) {
    hardBlocks.push("intelligence_memory_below_risk_profile_minimum");
  }

  if (bookmakerCoverage < Number(policy.riskProfile.minBookmakerCount || 1)) {
    hardBlocks.push("not_enough_bookie_coverage");
  }

  if (marketFocus.score < -6 && confidence < 0.76) {
    hardBlocks.push("market_does_not_match_evidence");
  }

  if (market === "match_winner" && outcome === "Draw") {
    if (independentModelProbability < Number(policy.riskProfile.minDrawModelProbability || 0.22)) {
      hardBlocks.push("draw_probability_below_model_floor");
    }

    if (Math.abs(Number(legModel.components.independentResultEdge || 0)) > Number(policy.riskProfile.maxDrawIndependentResultEdge || 58)) {
      hardBlocks.push("draw_without_enough_balance");
    }
  }

  if (Number(odds.decimalOdds) >= 4 || preliminaryRiskTag === "longshot_value") {
    const scorerLongshotFloor = market === "first_goalscorer" ? 0.07 : market === "anytime_scorer" ? 0.14 : null;
    const longshotModelFloor = scorerLongshotFloor ?? Number(policy.riskProfile.minLongshotModelProbability || 0.18);
    const longshotSignalFloor = isScorerMarket(market) ? 3 : Number(policy.riskProfile.minLongshotSignals || 3);

    if (independentModelProbability < longshotModelFloor) {
      hardBlocks.push("longshot_probability_below_model_floor");
    }

    if (Number(independentEvidence.count || 0) < longshotSignalFloor) {
      hardBlocks.push("longshot_without_enough_independent_signals");
    }

    if (
      market === "match_winner"
      && marketImpliedProbability < 0.18
      && independentEdge > 0.2
      && Math.abs(Number(legModel.components.independentResultEdge || 0)) < Number(policy.riskProfile.minLongshotResultEdgeForce || 48)
    ) {
      hardBlocks.push("longshot_market_disagreement_too_large");
    }
  }

  if (
    market === "match_winner"
    && outcome !== "Draw"
    && Number(odds.decimalOdds) > Number(policy.riskProfile.maxResultLongshotDecimalOdds || 16)
  ) {
    hardBlocks.push("result_longshot_above_risk_price_cap");
  }

  if (market === "both_teams_to_score" && outcome === "Yes") {
    const lowerTeamExpectedGoals = Math.min(Number(legModel.components.homeExpectedGoals || 0), Number(legModel.components.awayExpectedGoals || 0));

    if (independentModelProbability < Number(policy.riskProfile.minBttsYesRawProbability || 0.46)) {
      hardBlocks.push("btts_yes_raw_probability_below_floor");
    }

    if (lowerTeamExpectedGoals < Number(policy.riskProfile.minBttsLowerTeamExpectedGoals || 0.78)) {
      hardBlocks.push("btts_yes_one_team_goal_threat_too_low");
    }
  }

  if (
    Number(legModel.components.openingGameCaution || 0) >= 0.75
    && (market === "over_2_5_goals" || (market === "both_teams_to_score" && outcome === "Yes"))
    && Number(legModel.components.expectedGoals || 0) < 2.82
    && independentEdge < 0.04
  ) {
    hardBlocks.push("opening_group_game_goal_market_edge_not_strong_enough");
  }

  if (Number(legModel.components.openingGameCaution || 0) >= 0.75 && market === "over_2_5_goals") {
    const lowerTeamExpectedGoals = Math.min(Number(legModel.components.homeExpectedGoals || 0), Number(legModel.components.awayExpectedGoals || 0));
    const projectedShotTotal = Number(legModel.components.projectedShotTotal || 0);
    const openingPenalty = Math.abs(Number(legModel.components.openingOver25Adjustment || 0));
    const strongOpeningTotal = Number(legModel.components.expectedGoals || 0) >= 3.12
      && lowerTeamExpectedGoals >= 1.08
      && projectedShotTotal >= 24.5;

    if (!strongOpeningTotal && (independentEdge < 0.075 || openingPenalty >= 0.04)) {
      hardBlocks.push("opening_group_over25_requires_stronger_total_edge");
    }
  }

  if (oddsAgeHours > (policy.sourceRequirements?.maxOddsAgeHours || 30)) {
    hardBlocks.push("odds_snapshot_stale");
  }

  return {
    id: makeId("leg", [fixture.id, market, outcome, odds.bookmaker, odds.capturedAt]),
    createdAt: now.toISOString(),
    fixtureId: fixture.id,
    fixtureDate: fixture.date,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    market,
    outcome,
    playerName: odds.playerName,
    playerTeam: odds.playerTeam,
    selectionLabel: selectionLabel({ fixture, market, outcome }),
    bookmaker: odds.bookmaker,
    decimalOdds: Number(odds.decimalOdds),
    modelProbability: round(adjustedModelProbability, 4),
    rawModelProbability: round(independentModelProbability, 4),
    impliedProbability: round(impliedProbability, 4),
    marketImpliedProbability: round(marketImpliedProbability, 4),
    independentEdge: round(independentEdge, 4),
    edge: round(edge, 4),
    priceEdge: round(priceEdge, 4),
    marketEdge: round(marketEdge, 4),
    confidence: round(confidence, 4),
    score: round(score, 2),
    riskTag: preliminaryRiskTag,
    hardBlocks,
    components: {
      ...legModel.components,
      oddsAgeHours: round(oddsAgeHours, 2),
      oddsFreshness: round(oddsFreshness, 3),
      bookmakerCoverage,
      marketAverageOdds: movement?.averageDecimalOdds || Number(odds.decimalOdds),
      oddsMovement: round(Number(movement?.movement || 0), 4),
      oddsShortening: movement?.shortening || false,
      oddsDrifting: movement?.drifting || false,
      bestOverAverage: round(oddsDisagreement, 4),
      independentEdge: round(independentEdge, 4),
      marketBlendLift: round(marketBlendLift, 4),
      nonMarketSignalCount: independentEvidence.count,
      nonMarketSignals: independentEvidence.signals,
      independentEvidenceStrength: round(independentEvidence.strength, 4),
      intelligenceConfidence: round(intelligenceConfidence, 4),
      oddsMovementBonus: round(oddsMovementBonus, 2),
      intelligenceBonus: round(intelligenceBonus, 2),
      marketFocusBonus: round(marketFocusBonus, 2),
      evidenceBonus: round(evidenceBonus, 2),
      marketBlendPenalty: round(marketBlendPenalty, 2),
      marketFocusReasons: marketFocus.reasons,
      outcomeLearningAdjustment: learning.adjustment,
      outcomeLearningConfidence: learning.confidence,
      outcomeLearningReasons: learning.reasons,
      outcomeLearningBaseAdjustment: learning.outcomeAdjustment,
      predictionReflectionAdjustment: learning.reflectionAdjustment,
      predictionReflectionConfidence: learning.reflectionConfidence,
      predictionReflectionReasons: learning.reflectionReasons,
      confidenceReasons: buildConfidenceReasons({
        confidence,
        dataCompleteness,
        intelligenceConfidence,
        oddsFreshness,
        bookmakerCoverage,
        independentEvidence,
        marketBlendLift,
        learning,
        marketFocus
      }),
      favoriteCrowdingPenalty: round(favoriteCrowdingPenalty, 2),
      valueOddsBonus
    },
    thesis: buildLegThesis({
      fixture,
      market,
      outcome,
      edge,
      independentEdge,
      rawModelProbability: independentModelProbability,
      modelProbability: adjustedModelProbability,
      marketImpliedProbability,
      odds,
      movement,
      model: legModel,
      confidence,
      independentEvidence,
      marketFocus,
      learning
    })
  };
}

function buildNewsByTeam(newsArticles, policy, now) {
  const maxAgeDays = policy.sourceRequirements?.maxNewsAgeDays || 10;
  const byTeam = new Map();

  for (const article of newsArticles) {
    if (daysBetween(article.publishedAt || article.createdAt, now) > maxAgeDays) {
      continue;
    }

    for (const team of article.teamTags || []) {
      const existing = byTeam.get(team) || [];
      existing.push(article);
      byTeam.set(team, existing);
    }
  }

  const aggregates = new Map();

  for (const [team, articles] of byTeam.entries()) {
    aggregates.set(team, aggregateNews(articles, team));
  }

  return aggregates;
}

function buildConfidenceReasons({ confidence, dataCompleteness, intelligenceConfidence, oddsFreshness, bookmakerCoverage, independentEvidence, marketBlendLift, learning, marketFocus }) {
  const reasons = [];

  if (confidence >= 0.78) {
    reasons.push("high combined confidence");
  } else if (confidence < 0.6) {
    reasons.push("thin confidence, use cautiously");
  }

  if (dataCompleteness >= 0.75) {
    reasons.push("strong team-data completeness");
  }

  if (intelligenceConfidence >= 0.72) {
    reasons.push("team intelligence memory is mature");
  }

  if (oddsFreshness >= 0.85) {
    reasons.push("fresh odds snapshot");
  } else if (oddsFreshness < 0.45) {
    reasons.push("odds are ageing");
  }

  if (bookmakerCoverage >= 3) {
    reasons.push(`${bookmakerCoverage} bookie samples`);
  }

  if (Number(independentEvidence?.count || 0) >= 5) {
    reasons.push("many non-market signals agree");
  }

  if (Number(marketBlendLift || 0) > 0.04) {
    reasons.push("market lift capped to avoid bookie-following");
  }

  if (Number(learning?.confidence || 0) > 0.2) {
    reasons.push("settled-outcome learning active");
  }

  if (Number(learning?.reflectionConfidence || 0) > 0.2) {
    reasons.push("post-match xG/shot reflection active");
  }

  if (Number(marketFocus?.score || 0) >= 6) {
    reasons.push("market type fits the football evidence");
  }

  return reasons.slice(0, 7);
}

function aggregateNews(articles, team) {
  const accepted = articles.filter((article) => article.acceptedSource !== false);
  const usable = accepted
    .map((article) => ({ article, weight: newsRelevanceWeight(article, team) }))
    .filter((item) => item.weight >= 0.5);

  if (!usable.length) {
    return {
      ...neutralNews(),
      contextArticleCount: accepted.length,
      rejectedArticleCount: articles.length - accepted.length
    };
  }

  const reliabilityWeighted = usable.reduce((total, item) => total + weightedNewsReliability(item), 0) || 1;
  const weightedSentiment = usable.reduce((total, item) => total + Number(item.article.sentiment || 0) * weightedNewsReliability(item), 0) / reliabilityWeighted;
  const injuryDrag = usable.reduce((total, item) => total + Number(item.article.signals?.injury || 0) * weightedNewsReliability(item), 0) / reliabilityWeighted;
  const tacticalLift = usable.reduce((total, item) => total + Number(item.article.signals?.tacticalFit || 0.45) * weightedNewsReliability(item), 0) / reliabilityWeighted;
  const lineupLift = usable.reduce((total, item) => total + Number(item.article.signals?.lineupClarity || 0.45) * weightedNewsReliability(item), 0) / reliabilityWeighted;
  const rotationDrag = usable.reduce((total, item) => total + Number(item.article.signals?.rotationRisk || 0.2) * weightedNewsReliability(item), 0) / reliabilityWeighted;
  const sourceDiversity = new Set(usable.map((item) => item.article.source || item.article.provider)).size;
  const confidence = clamp(0.34 + sourceDiversity * 0.11 + mean(usable.map((item) => Number(item.article.sourceReliability || 0.5) * item.weight)) * 0.35, 0, 1);
  const netImpact = clamp(weightedSentiment * 0.5 + tacticalLift * 0.18 + lineupLift * 0.16 - injuryDrag * 0.3 - rotationDrag * 0.15, -0.6, 0.6);

  return {
    articleCount: usable.length,
    contextArticleCount: accepted.length - usable.length,
    rejectedArticleCount: articles.length - accepted.length,
    sourceDiversity,
    confidence,
    netImpact
  };
}

function weightedNewsReliability(item) {
  return Number(item.article.sourceReliability || 0.5) * Number(item.weight || 0);
}

function newsRelevanceWeight(article, team) {
  const keys = teamIdentityKeys(team);
  const headline = normalizeName(`${article.title || ""} ${article.description || ""}`);
  const body = normalizeName(article.bodySnippet || "");
  const tags = article.teamTags || [];
  const taggedTeamCount = tags.length;
  const headlineMatch = keys.some((key) => headline.includes(key));
  const bodyMatch = keys.some((key) => body.includes(key));

  if (!headline && !body && tags.some((tag) => normalizeName(tag) === normalizeName(team))) {
    return 0.65;
  }

  if (headlineMatch) {
    return taggedTeamCount > 5 ? 0.72 : 1;
  }

  if (bodyMatch) {
    return taggedTeamCount > 5 ? 0.28 : 0.42;
  }

  return 0;
}

function neutralNews() {
  return {
    articleCount: 0,
    sourceDiversity: 0,
    confidence: 0.35,
    netImpact: 0
  };
}

function teamIdentityKeys(team) {
  const key = normalizeName(team);
  const aliases = {
    usa: ["united states", "united states mens", "united states men s", "usmnt"],
    "united states": ["usa", "united states mens", "united states men s", "usmnt"],
    czechia: ["czech republic"],
    "czech republic": ["czechia"],
    turkiye: ["turkey"],
    turkey: ["turkiye"],
    "bosnia and herzegovina": ["bosnia"],
    bosnia: ["bosnia and herzegovina"],
    "south korea": ["korea republic", "republic of korea"],
    "korea republic": ["south korea", "republic of korea"],
    "ivory coast": ["cote d ivoire"],
    "cote d ivoire": ["ivory coast"]
  };

  return [...new Set([key, ...(aliases[key] || []).map(normalizeName)])].filter(Boolean);
}

function styleMatchupDetails(homeStats, awayStats) {
  const homePressVsAwayBuild = (Number(homeStats.highPressIndex || 55) - Number(awayStats.possession || 50)) * 0.6;
  const awayPressVsHomeBuild = (Number(awayStats.highPressIndex || 55) - Number(homeStats.possession || 50)) * 0.6;
  const pressBuildEdge = homePressVsAwayBuild - awayPressVsHomeBuild;
  const setPieceEdge = (Number(homeStats.setPieceThreat || 55) - Number(awayStats.setPieceThreat || 55)) * 0.35;
  const transitionEdge = (Number(homeStats.transitionThreat || 55) - Number(awayStats.transitionThreat || 55)) * 0.32;
  const keeperEdge = (Number(homeStats.keeperForm || 55) - Number(awayStats.keeperForm || 55)) * 0.4;
  const homeBuildQuality = buildUpQuality(homeStats);
  const awayBuildQuality = buildUpQuality(awayStats);
  const buildUpEdge = (homeBuildQuality - awayBuildQuality) * 0.42;

  return {
    edge: pressBuildEdge + setPieceEdge + transitionEdge + keeperEdge + buildUpEdge,
    pressBuildEdge,
    buildUpEdge
  };
}

function buildUpQuality(stats) {
  const passCompletion = Number(stats.passCompletion || stats.passing?.completion || 0.815);
  const passesAttempted = Number(stats.passesAttempted || stats.passing?.attempted || 420);
  const possession = Number(stats.possession || 50);
  const styleTags = stats.tacticalProfile?.styleTags || [];
  const patientBuild = styleTags.some((tag) => /possession|build/i.test(tag)) ? 2.5 : 0;

  return clamp(
    ((passCompletion - 0.8) * 95)
    + ((passesAttempted - 420) * 0.035)
    + ((possession - 50) * 0.18)
    + patientBuild,
    -18,
    22
  );
}

function defensiveDrawLift(homeStats, awayStats) {
  const defensiveStrength = 2.3 - (Number(homeStats.xgAgainst || 1.2) + Number(awayStats.xgAgainst || 1.2));
  return clamp(defensiveStrength * 0.025, -0.025, 0.04);
}

function goalShapeForFixture(homeStats, awayStats, homeNews, awayNews, heat, matchup = {}) {
  const homeAttack = (Number(homeStats.xgFor || 1.35) + Number(awayStats.xgAgainst || 1.2)) / 2;
  const awayAttack = (Number(awayStats.xgFor || 1.35) + Number(homeStats.xgAgainst || 1.2)) / 2;
  const homeNewsLift = Number(homeNews.netImpact || 0) * 0.08;
  const awayNewsLift = Number(awayNews.netImpact || 0) * 0.08;
  const homeInjuryDrag = Number(homeStats.injuryBurden || 0) * 0.08;
  const awayInjuryDrag = Number(awayStats.injuryBurden || 0) * 0.08;
  const heatGoalDrag = Number(heat.expectedGoalsAdjustment || 0) / 2;
  const heatShareShift = Number(heat.goalShareAdjustment || 0);
  const homeExpectedGoals = clamp(homeAttack + homeNewsLift - homeInjuryDrag + heatGoalDrag + heatShareShift, 0.28, 2.95);
  const awayExpectedGoals = clamp(awayAttack + awayNewsLift - awayInjuryDrag + heatGoalDrag - heatShareShift, 0.28, 2.95);
  const adjusted = applyOpponentQualityGoalAdjustment({
    homeExpectedGoals,
    awayExpectedGoals,
    homeStats,
    awayStats,
    ratingEdge: matchup.ratingEdge,
    xgEdge: matchup.xgEdge,
    homeSquadDepth: matchup.homeSquadDepth,
    awaySquadDepth: matchup.awaySquadDepth
  });

  return {
    ...adjusted,
    expectedGoals: clamp(adjusted.homeExpectedGoals + adjusted.awayExpectedGoals, 1.25, 4.1)
  };
}

function projectedShotShapeForFixture({ homeStats, awayStats, goalShape, heat }) {
  const homeBaseShots = mean([
    Number(homeStats.shotsFor || homeStats.longForm?.shotsFor || 10.5),
    Number(awayStats.shotsAgainst || awayStats.longForm?.shotsAgainst || 10.5)
  ]);
  const awayBaseShots = mean([
    Number(awayStats.shotsFor || awayStats.longForm?.shotsFor || 10.5),
    Number(homeStats.shotsAgainst || homeStats.longForm?.shotsAgainst || 10.5)
  ]);
  const homeBaseSot = mean([
    Number(homeStats.shotsOnTargetFor || homeStats.longForm?.shotsOnTargetFor || 3.6),
    Number(awayStats.shotsOnTargetAgainst || awayStats.longForm?.shotsOnTargetAgainst || 3.6)
  ]);
  const awayBaseSot = mean([
    Number(awayStats.shotsOnTargetFor || awayStats.longForm?.shotsOnTargetFor || 3.6),
    Number(homeStats.shotsOnTargetAgainst || homeStats.longForm?.shotsOnTargetAgainst || 3.6)
  ]);
  const heatTempo = Number(heat.expectedGoalsAdjustment || 0) * 1.35;
  const homeXgLift = (Number(goalShape.homeExpectedGoals || 1.2) - 1.25) * 2.15;
  const awayXgLift = (Number(goalShape.awayExpectedGoals || 1.2) - 1.25) * 2.15;
  const homeShots = clamp(homeBaseShots + homeXgLift + heatTempo / 2, 5.2, 23.5);
  const awayShots = clamp(awayBaseShots + awayXgLift + heatTempo / 2, 5.2, 23.5);
  const homeShotsOnTarget = clamp(homeBaseSot + homeXgLift * 0.48 + heatTempo * 0.18, 1.2, 9.5);
  const awayShotsOnTarget = clamp(awayBaseSot + awayXgLift * 0.48 + heatTempo * 0.18, 1.2, 9.5);

  return {
    homeShots,
    awayShots,
    totalShots: homeShots + awayShots,
    homeShotsOnTarget,
    awayShotsOnTarget,
    totalShotsOnTarget: homeShotsOnTarget + awayShotsOnTarget
  };
}

function applyOpponentQualityGoalAdjustment({ homeExpectedGoals, awayExpectedGoals, homeStats, awayStats, ratingEdge = 0, xgEdge = 0, homeSquadDepth = null, awaySquadDepth = null }) {
  const depthEdge = (squadDepthValue(homeSquadDepth) - squadDepthValue(awaySquadDepth)) * 75;
  const qualityGapEdge = clamp(Number(ratingEdge || 0) + Number(xgEdge || 0) * 0.45 + depthEdge, -220, 220);
  const rawQualityGapPressure = clamp((Math.abs(qualityGapEdge) - 42) / 135, 0, 1);
  const evidenceConfidence = mean([rateEvidenceConfidence(homeStats), rateEvidenceConfidence(awayStats)]);
  const qualityGapPressure = evidenceConfidence >= 0.45
    ? rawQualityGapPressure * clamp(0.3 + evidenceConfidence * 0.7, 0.3, 1)
    : 0;

  if (qualityGapPressure <= 0) {
    return {
      homeExpectedGoals,
      awayExpectedGoals,
      qualityGapEdge,
      qualityGapPressure: 0,
      homeQualityGoalAdjustment: 0,
      awayQualityGoalAdjustment: 0
    };
  }

  const homeFavoured = qualityGapEdge > 0;
  const weakStats = homeFavoured ? awayStats : homeStats;
  const strongStats = homeFavoured ? homeStats : awayStats;
  const weakExpectedGoals = homeFavoured ? awayExpectedGoals : homeExpectedGoals;
  const strongExpectedGoals = homeFavoured ? homeExpectedGoals : awayExpectedGoals;
  const weakScoringRate = scoringReliabilityAgainstStrongerTeam(weakStats, strongStats, qualityGapPressure);
  const weakScoringGoalCap = clamp(-Math.log(Math.max(0.08, 1 - weakScoringRate)) + 0.12, 0.42, 2.05);
  const capReduction = Math.max(0, weakExpectedGoals - weakScoringGoalCap);
  const capWeight = clamp(0.5 + qualityGapPressure * 0.3, 0.5, 0.82);
  const weakReliance = clamp((weakExpectedGoals - 0.82) / 1.15, 0, 1);
  const percentageReduction = weakExpectedGoals * qualityGapPressure * weakReliance * 0.12;
  const weakReduction = clamp(capReduction * capWeight + percentageReduction, 0, weakExpectedGoals - 0.32);
  const strongRebound = clamp(weakReduction * (0.22 + qualityGapPressure * 0.12), 0, 0.18);
  const adjustedWeak = clamp(weakExpectedGoals - weakReduction, 0.28, 2.95);
  const adjustedStrong = clamp(strongExpectedGoals + strongRebound, 0.28, 3.08);

  if (homeFavoured) {
    return {
      homeExpectedGoals: adjustedStrong,
      awayExpectedGoals: adjustedWeak,
      qualityGapEdge,
      qualityGapPressure,
      homeQualityGoalAdjustment: adjustedStrong - homeExpectedGoals,
      awayQualityGoalAdjustment: adjustedWeak - awayExpectedGoals
    };
  }

  return {
    homeExpectedGoals: adjustedWeak,
    awayExpectedGoals: adjustedStrong,
    qualityGapEdge,
    qualityGapPressure,
    homeQualityGoalAdjustment: adjustedWeak - homeExpectedGoals,
    awayQualityGoalAdjustment: adjustedStrong - awayExpectedGoals
  };
}

function scoringReliabilityAgainstStrongerTeam(weakStats, strongStats, pressure) {
  const weakScoringRate = rateFromStats(weakStats, "scoringGameRate", 1 - rateFromStats(weakStats, "failedToScoreRate", 0.5));
  const strongConcedeRate = rateFromStats(strongStats, "concedeGameRate", 1 - rateFromStats(strongStats, "cleanSheetRate", 0.5));
  const baseReliability = mean([weakScoringRate, strongConcedeRate]);

  return clamp(baseReliability - Number(pressure || 0) * 0.14, 0.22, 0.9);
}

function rateFromStats(stats, key, fallback) {
  const marketValue = Number(stats?.marketAngles?.[key]);
  const longFormValue = Number(stats?.longForm?.[key]);

  if (Number.isFinite(marketValue)) {
    return clamp(marketValue, 0, 1);
  }

  if (Number.isFinite(longFormValue)) {
    return clamp(longFormValue, 0, 1);
  }

  return clamp(Number(fallback ?? 0.5), 0, 1);
}

function rateEvidenceConfidence(stats) {
  const hasMarketAngles = Number.isFinite(Number(stats?.marketAngles?.scoringGameRate))
    || Number.isFinite(Number(stats?.marketAngles?.failedToScoreRate))
    || Number.isFinite(Number(stats?.marketAngles?.cleanSheetRate))
    || Number.isFinite(Number(stats?.marketAngles?.concedeGameRate));
  const hasLongFormAngles = Number.isFinite(Number(stats?.longForm?.scoringGameRate))
    || Number.isFinite(Number(stats?.longForm?.failedToScoreRate))
    || Number.isFinite(Number(stats?.longForm?.cleanSheetRate))
    || Number.isFinite(Number(stats?.longForm?.concedeGameRate));
  const matchCount = Number(stats?.longForm?.matchCount || stats?.sourceMatchCount || stats?.matchCount || 0);

  if (hasMarketAngles || hasLongFormAngles) {
    return clamp(0.45 + Math.min(matchCount, 20) / 20 * 0.55, 0.45, 1);
  }

  return clamp(matchCount / 20, 0, 0.35);
}

function squadDepthValue(record) {
  const value = Number(record?.depthScore ?? record?.score);

  return Number.isFinite(value) ? clamp(value, 0.25, 0.94) : 0.5;
}

function doubleChanceProbabilities({ fixture, homeWin, draw, awayWin }) {
  return {
    [`${fixture.homeTeam} or Draw`]: round(homeWin + draw, 4),
    [`Draw or ${fixture.awayTeam}`]: round(draw + awayWin, 4),
    [`${fixture.homeTeam} or ${fixture.awayTeam}`]: round(homeWin + awayWin, 4)
  };
}

function poissonOver25(expectedGoals) {
  return poissonOver(expectedGoals, 2.5);
}

function poissonOver(expectedGoals, line) {
  const lambda = clamp(Number(expectedGoals || 2.4), 0.8, 4.2);
  const floor = Math.floor(Number(line || 2.5));
  const underOrEqualLine = poissonCumulative(lambda, floor);
  const max = line <= 1.5 ? 0.92 : 0.82;
  const min = line <= 1.5 ? 0.42 : 0.18;

  return round(clamp(1 - underOrEqualLine, min, max), 4);
}

function poissonUnder(expectedGoals, line) {
  const lambda = clamp(Number(expectedGoals || 2.4), 0.8, 4.2);
  const floor = Math.floor(Number(line || 2.5));
  const max = line >= 4.5 ? 0.96 : line >= 3.5 ? 0.92 : 0.82;
  const min = line >= 4.5 ? 0.52 : line >= 3.5 ? 0.38 : 0.18;

  return round(clamp(poissonCumulative(lambda, floor), min, max), 4);
}

function poissonCumulative(lambda, maxGoals) {
  let total = 0;

  for (let goals = 0; goals <= maxGoals; goals += 1) {
    total += Math.exp(-lambda) * (lambda ** goals) / factorial(goals);
  }

  return total;
}

function factorial(value) {
  let result = 1;

  for (let index = 2; index <= value; index += 1) {
    result *= index;
  }

  return result;
}

function poissonBothTeamsToScore(homeExpectedGoals, awayExpectedGoals, heat) {
  const homeScores = 1 - Math.exp(-clamp(Number(homeExpectedGoals || 1.1), 0.05, 3.2));
  const awayScores = 1 - Math.exp(-clamp(Number(awayExpectedGoals || 1.1), 0.05, 3.2));
  const balancePenalty = clamp((Math.abs(homeExpectedGoals - awayExpectedGoals) - 0.75) * 0.035, 0, 0.045);
  const heatAdjustment = Number(heat.bttsAdjustment || 0);

  return round(clamp(homeScores * awayScores - balancePenalty + heatAdjustment, 0.16, 0.68), 4);
}

function compressTopScore(score) {
  const value = Number(score || 0);

  if (value <= 86) {
    return value;
  }

  return 86 + Math.sqrt(Math.max(0, value - 86)) * 2.5;
}

function evaluateIndependentEvidence({ fixture, market, outcome, model, rawModelProbability, marketImpliedProbability, independentEdge }) {
  const components = model.components || {};
  const signals = [];
  const strengths = [];
  const expectedGoals = Number(components.expectedGoals || 2.5);
  const homeExpectedGoals = Number(components.homeExpectedGoals || expectedGoals / 2);
  const awayExpectedGoals = Number(components.awayExpectedGoals || expectedGoals / 2);
  const lowerTeamExpectedGoals = Math.min(homeExpectedGoals, awayExpectedGoals);
  const independentResultEdge = Number(components.independentResultEdge || 0);
  const openingCaution = Number(components.openingGameCaution || 0);
  const direction = outcome === fixture.homeTeam ? 1 : outcome === fixture.awayTeam ? -1 : 0;
  const directional = (value) => Number(value || 0) * direction;
  const add = (condition, label, strength = 0.55) => {
    if (!condition || signals.includes(label)) {
      return;
    }

    signals.push(label);
    strengths.push(clamp(strength, 0.1, 1));
  };

  add(independentEdge >= 0.012, "raw AI probability beats market", clamp(independentEdge / 0.08, 0.25, 1));
  add(Number(components.homeLongMatchCount || 0) >= 10 && Number(components.awayLongMatchCount || 0) >= 10, "20-match team sample", 0.62);

  if (market === "match_winner" || market === "draw_no_bet" || market === "double_chance") {
    if (outcome === "Draw") {
      const cleanSheetProfile = mean([
        Number(components.homeCleanSheetRate || 0.28),
        Number(components.awayCleanSheetRate || 0.28)
      ]);

      add(Math.abs(independentResultEdge) <= 34, "balanced team-strength profile", 0.72);
      add(Math.abs(Number(components.formEdge || 0)) <= 20 && Math.abs(Number(components.xgEdge || 0)) <= 22, "form and xG are close", 0.58);
      add(expectedGoals <= 2.42, "tight expected-goals profile", 0.55);
      add(cleanSheetProfile >= 0.33, "clean-sheet history supports draw shape", 0.48);
      add(openingCaution >= 0.75, "opening group-game caution supports draw cover", 0.42);
    } else if (direction) {
      add(directional(components.ratingEdge) >= 32, "team rating edge", clamp(Math.abs(Number(components.ratingEdge || 0)) / 130, 0.3, 1));
      add(directional(components.formEdge) >= 12, "recent form edge", clamp(Math.abs(Number(components.formEdge || 0)) / 58, 0.25, 1));
      add(directional(components.xgEdge) >= 10, "xG attack-defense edge", clamp(Math.abs(Number(components.xgEdge || 0)) / 55, 0.25, 1));
      add(directional(components.styleEdge) >= 10, "style matchup edge", clamp(Math.abs(Number(components.styleEdge || 0)) / 45, 0.25, 1));
      add(directional(components.newsEdge) >= 8, "team news edge", clamp(Math.abs(Number(components.newsEdge || 0)) / 55, 0.22, 1));
      add(directional(components.memoryEdge) >= 7, "local intelligence memory edge", clamp(Math.abs(Number(components.memoryEdge || 0)) / 40, 0.22, 1));
      add(directional(components.heatEdge) >= 3, "heat and squad-depth edge", clamp(Math.abs(Number(components.heatEdge || 0)) / 20, 0.2, 0.8));
    }

    if (market === "double_chance") {
      const coversHome = outcome.includes(fixture.homeTeam);
      const coversAway = outcome.includes(fixture.awayTeam);
      const coversDraw = /draw/i.test(outcome);
      const protectedFavourite = (coversHome && independentResultEdge >= 12) || (coversAway && independentResultEdge <= -12);

      add(rawModelProbability >= 0.66, "raw double-chance survival profile", clamp((rawModelProbability - 0.58) / 0.24, 0.25, 1));
      add(protectedFavourite, "result edge protected by draw cover", clamp(Math.abs(independentResultEdge) / 120, 0.25, 1));
      add(coversDraw && openingCaution >= 0.55, "opening-game caution supports draw cover", 0.45);
      add(!coversDraw && expectedGoals >= 2.62, "draw risk is lower in a livelier goal profile", 0.38);
    }
  }

  if (market === "both_teams_to_score") {
    const bttsHistory = mean([
      Number(components.homeBttsRate || 0.48),
      Number(components.awayBttsRate || 0.48)
    ]);

    if (outcome === "Yes") {
      add(rawModelProbability >= 0.52, "raw BTTS model is positive", clamp((rawModelProbability - 0.45) / 0.18, 0.25, 1));
      add(homeExpectedGoals >= 0.85 && awayExpectedGoals >= 0.85, "both teams carry scoring threat", 0.72);
      add(expectedGoals >= 2.45, "goals environment supports BTTS", 0.58);
      add(bttsHistory >= 0.52, "20-match BTTS history", clamp((bttsHistory - 0.45) / 0.2, 0.2, 1));
      add(Number(components.heatStress || 0) < 0.72 || Number(components.heatConfidence || 0) < 0.35, "heat does not strongly suppress tempo", 0.35);
    } else {
      const cleanSheetHistory = mean([
        Number(components.homeCleanSheetRate || 0.28),
        Number(components.awayCleanSheetRate || 0.28)
      ]);

      add(rawModelProbability >= 0.52, "raw BTTS-no model is positive", clamp((rawModelProbability - 0.45) / 0.18, 0.25, 1));
      add(lowerTeamExpectedGoals <= 0.78, "one team goal threat is low", 0.7);
      add(cleanSheetHistory >= 0.34, "clean-sheet history supports BTTS-no", 0.55);
      add(expectedGoals <= 2.35, "tight goals environment", 0.5);
      add(openingCaution >= 0.75 && expectedGoals <= 2.55, "opening group-game caution trims BTTS", 0.42);
    }
  }

  if (market === "over_2_5_goals") {
    const overHistory = mean([
      Number(components.homeOver25Rate || 0.48),
      Number(components.awayOver25Rate || 0.48)
    ]);

    add(rawModelProbability >= 0.53, "raw over-2.5 model is positive", clamp((rawModelProbability - 0.45) / 0.2, 0.25, 1));
    add(expectedGoals >= 2.58, "expected-goals model is high", clamp((expectedGoals - 2.25) / 0.85, 0.25, 1));
    add(overHistory >= 0.52, "20-match over history", clamp((overHistory - 0.44) / 0.22, 0.2, 1));
    add(lowerTeamExpectedGoals >= 0.75, "second team adds goal pressure", 0.45);
  }

  if (market === "over_1_5_goals") {
    const overHistory = mean([
      Number(components.homeOver25Rate || 0.48),
      Number(components.awayOver25Rate || 0.48)
    ]);

    add(rawModelProbability >= 0.68, "raw over-1.5 model clears survival line", clamp((rawModelProbability - 0.6) / 0.24, 0.25, 1));
    add(expectedGoals >= 2.18, "expected-goals base supports two goals", clamp((expectedGoals - 1.95) / 0.9, 0.25, 1));
    add(overHistory >= 0.44, "20-match goals history is not dead", clamp((overHistory - 0.36) / 0.28, 0.2, 1));
    add(lowerTeamExpectedGoals >= 0.65 || expectedGoals >= 2.45, "second goal can arrive from either match shape", 0.44);
    add(openingCaution < 0.75 || expectedGoals >= 2.38, "opening caution still leaves a two-goal route", 0.35);
  }

  if (market === "under_2_5_goals") {
    const overHistory = mean([
      Number(components.homeOver25Rate || 0.48),
      Number(components.awayOver25Rate || 0.48)
    ]);

    add(rawModelProbability >= 0.53, "raw under-2.5 model is positive", clamp((rawModelProbability - 0.45) / 0.2, 0.25, 1));
    add(expectedGoals <= 2.34, "expected-goals model is tight", clamp((2.58 - expectedGoals) / 0.78, 0.25, 1));
    add(overHistory <= 0.42, "20-match over history is modest", clamp((0.5 - overHistory) / 0.22, 0.2, 1));
    add(Number(components.heatExpectedGoalsAdjustment || 0) < -0.02, "heat layer trims goal tempo", 0.42);
    add(openingCaution >= 0.75 && expectedGoals <= 2.55, "opening group-game caution supports unders", 0.42);
  }

  if (market === "under_3_5_goals" || market === "under_4_5_goals") {
    const line = market === "under_4_5_goals" ? 4.5 : 3.5;
    const overHistory = mean([
      Number(components.homeOver25Rate || 0.48),
      Number(components.awayOver25Rate || 0.48)
    ]);

    add(rawModelProbability >= (line === 4.5 ? 0.78 : 0.66), `raw under-${line} model clears survival line`, clamp((rawModelProbability - (line === 4.5 ? 0.68 : 0.58)) / 0.24, 0.25, 1));
    add(expectedGoals <= (line === 4.5 ? 3.55 : 3.0), `expected-goals model stays below under-${line} danger zone`, clamp(((line === 4.5 ? 3.9 : 3.25) - expectedGoals) / 1.1, 0.25, 1));
    add(overHistory <= 0.62 || line === 4.5, "20-match goal history is survivable for the line", 0.42);
    add(openingCaution >= 0.55, "opening group-game caution supports lower ceiling", 0.4);
    add(Number(components.heatExpectedGoalsAdjustment || 0) < -0.015, "heat layer trims goal tempo", 0.35);
  }

  if (isScorerMarket(market)) {
    add(independentEdge >= 0.01, "raw scorer probability beats market", clamp(independentEdge / 0.06, 0.25, 1));
    add(expectedGoals >= 2.55, "team goals environment is live", 0.5);
    add(rawModelProbability >= (market === "first_goalscorer" ? 0.08 : 0.18), "scorer raw probability clears floor", clamp((rawModelProbability - (market === "first_goalscorer" ? 0.05 : 0.12)) / 0.22, 0.25, 1));
    add(Number(components.starterLikelihood || 0) >= 0.55, "starter/minutes projection is healthy", clamp(Number(components.starterLikelihood || 0), 0.25, 0.9));
    add(Number(components.scorerGoalsPerTwentyTeamMatches || 0) >= 3, "20-match scorer memory", clamp(Number(components.scorerGoalsPerTwentyTeamMatches || 0) / 8, 0.25, 1));
    add(market === "first_goalscorer" && Number(components.teamFirstGoalShare || 0) >= 0.46, "team first-goal share is credible", 0.42);
  }

  return {
    count: signals.length,
    signals,
    strength: signals.length ? mean(strengths) : 0
  };
}

function classifyRiskTag({ decimalOdds, impliedProbability, edge, independentEdge, rawModelProbability, modelProbability, movement, contrarianValue }) {
  if (contrarianValue) {
    return "contrarian_value";
  }

  if (decimalOdds >= 4 && edge > 0.04 && independentEdge > 0.018 && rawModelProbability >= 0.18) {
    return "longshot_value";
  }

  if (decimalOdds >= 2.05 && edge > 0.022 && independentEdge > 0) {
    return "calculated_risk";
  }

  if (decimalOdds >= 1.85 && edge > 0.032 && independentEdge > 0.02) {
    return "calculated_risk";
  }

  if (impliedProbability > 0.68 && edge > 0.025 && modelProbability > 0.72) {
    return "value_favourite";
  }

  if (movement?.shortening && edge > 0.02 && independentEdge > -0.005) {
    return "market_confirmed_edge";
  }

  return "steady_edge";
}

function buildLegThesis({ fixture, market, outcome, edge, independentEdge, rawModelProbability, modelProbability, marketImpliedProbability, odds, movement, model, confidence, independentEvidence, marketFocus, learning }) {
  const movementText = movement?.previousAverageDecimalOdds
    ? `Market average moved from ${movement.previousAverageDecimalOdds} to ${movement.averageDecimalOdds}; best price is ${round(Number(movement.bestOverAverage || 0) * 100, 2)}% over average.`
    : `No prior market movement yet; this scan becomes part of the local memory.`;
  const heatText = Number(model.components.heatConfidence || 0) > 0.18
    ? `Heat layer: ${model.components.heatLocation || "venue"} ${model.components.heatClimateBand || "weather"} stress ${round(Number(model.components.heatStress || 0) * 100, 1)}%, xG adjustment ${model.components.heatExpectedGoalsAdjustment}, result edge ${model.components.heatEdge}; climate/history/depth differential ${model.components.combinedHeatDifferential}.`
    : "";
  const tacticalText = model.components.homeLikelyFormation || model.components.awayLikelyFormation
    ? `Tactical memory: ${fixture.homeTeam} ${model.components.homeLikelyFormation || "shape unknown"} (${model.components.homeStyleOfPlay || "style mixed"}) vs ${fixture.awayTeam} ${model.components.awayLikelyFormation || "shape unknown"} (${model.components.awayStyleOfPlay || "style mixed"}); build-up edge ${model.components.buildUpEdge}.`
    : "";
  const scorerText = (model.components.homeTopScorers?.length || model.components.awayTopScorers?.length)
    ? `Scorer memory: ${fixture.homeTeam} top recent scorers ${formatNames(model.components.homeTopScorers)}; ${fixture.awayTeam} top recent scorers ${formatNames(model.components.awayTopScorers)}.`
    : "";
  const tournamentText = model.components.tournamentPhase
    ? `Tournament context: ${model.components.tournamentContextNote || model.components.tournamentPhase}; group-game numbers ${model.components.homeGroupGameNumber ?? "?"}-${model.components.awayGroupGameNumber ?? "?"}; xG adjustment ${model.components.tournamentExpectedGoalsAdjustment}, BTTS adjustment ${model.components.tournamentBttsAdjustment}, draw lift ${model.components.tournamentDrawLift}.`
    : "";
  const reflectionText = learning.reflectionReasons?.length
    ? `Post-match reflection: ${learning.reflectionReasons.join("; ")}.`
    : "";
  const notes = [
    `${selectionLabel({ fixture, market, outcome })} is priced at ${odds.decimalOdds}; raw AI probability ${round(rawModelProbability * 100, 1)}%, market-adjusted probability ${round(modelProbability * 100, 1)}%, market view ${round(marketImpliedProbability * 100, 1)}%.`,
    `Independent edge ${round(independentEdge * 100, 2)}%, final value edge ${round(edge * 100, 2)}%, backed by ${independentEvidence.count} non-market signal(s): ${independentEvidence.signals.join(", ") || "none yet"}.`,
    `Fixture model: expected goals ${model.components.expectedGoals} (${model.components.homeExpectedGoals}-${model.components.awayExpectedGoals}), rating edge ${model.components.ratingEdge}, style edge ${model.components.styleEdge}, memory edge ${model.components.memoryEdge}.`,
    `Odds intelligence is capped: market result edge ${model.components.marketResultEdge}, consensus probability ${model.components.marketHomeWinProbability ?? model.components.marketAwayWinProbability ?? "n/a"} where available.`,
    `News impact is ${model.components.homeNewsImpact} for ${fixture.homeTeam} and ${model.components.awayNewsImpact} for ${fixture.awayTeam}.`,
    tacticalText,
    scorerText,
    heatText,
    tournamentText,
    `Market focus: ${marketFocus.reasons.join("; ") || "general value check"}.`,
    learning.reasons.length ? `Outcome learning: ${learning.reasons.join("; ")}.` : "Outcome learning: waiting for enough settled bets before adjusting.",
    reflectionText,
    movementText,
    `Confidence ${round(confidence * 100, 1)}% after odds freshness and data completeness checks.`
  ].filter(Boolean);

  return notes.join(" ");
}

function selectionLabel({ fixture, market, outcome }) {
  const marketLabels = {
    match_winner: `${outcome} to win`,
    draw_no_bet: `${outcome} draw no bet`,
    anytime_scorer: `${outcome} anytime scorer`,
    first_goalscorer: `${outcome} first goalscorer`,
    both_teams_to_score: `Both teams to score: ${outcome}`,
    double_chance: `Double chance: ${outcome}`,
    over_1_5_goals: `${outcome} 1.5 goals`,
    over_2_5_goals: `${outcome} 2.5 goals`,
    under_2_5_goals: `${outcome} 2.5 goals`,
    under_3_5_goals: `${outcome} 3.5 goals`,
    under_4_5_goals: `${outcome} 4.5 goals`
  };

  return `${fixture.homeTeam} vs ${fixture.awayTeam}: ${marketLabels[market] || `${market} ${outcome}`}`;
}

function formatNames(names = []) {
  const cleaned = names.filter(Boolean).slice(0, 3);
  return cleaned.length ? cleaned.join(", ") : "not enough scorer data yet";
}

function outcomeKey(fixtureId, market, outcome) {
  return `${fixtureId}|${market}|${outcome}`;
}

function evaluateMarketFocus({ market, outcome, model, modelProbability, edge, odds, policy }) {
  const expectedGoals = Number(model.components.expectedGoals || 2.5);
  const homeExpectedGoals = Number(model.components.homeExpectedGoals || expectedGoals / 2);
  const awayExpectedGoals = Number(model.components.awayExpectedGoals || expectedGoals / 2);
  const lowerTeamExpectedGoals = Math.min(homeExpectedGoals, awayExpectedGoals);
  const styleEdge = Math.abs(Number(model.components.styleEdge || 0));
  const memoryEdge = Math.abs(Number(model.components.memoryEdge || 0));
  const dataCompleteness = Number(model.components.dataCompleteness || 0);
  const heatStress = Number(model.components.heatStress || 0);
  const heatConfidence = Number(model.components.heatConfidence || 0);
  const openingCaution = Number(model.components.openingGameCaution || 0);
  const bothOpeningGroupGame = Boolean(model.components.bothOpeningGroupGame);
  const appetite = riskAppetite(policy);
  const reasons = [];
  let score = 0;

  if (market === "over_2_5_goals") {
    if (expectedGoals >= 2.68) {
      score += 5;
      reasons.push(`goal model likes the game at ${expectedGoals} expected goals`);
    } else if (expectedGoals < 2.28) {
      score -= 8;
      reasons.push(`goal model is low at ${expectedGoals} expected goals`);
    }

    if (openingCaution > 0 && expectedGoals < 2.92) {
      score -= bothOpeningGroupGame ? 4 : 2;
      reasons.push("opening group-game caution cools marginal over-2.5 bets");
    } else if (openingCaution > 0 && expectedGoals >= 3.05) {
      reasons.push("goal case remains strong after opening-game caution");
    }
  }

  if (market === "over_1_5_goals") {
    if (expectedGoals >= 2.25) {
      score += 5;
      reasons.push(`safer two-goal line has ${expectedGoals} expected-goals support`);
    } else if (expectedGoals < 1.95) {
      score -= 7;
      reasons.push(`two-goal line is thin at ${expectedGoals} expected goals`);
    }

    if (openingCaution > 0 && expectedGoals < 2.35) {
      score -= bothOpeningGroupGame ? 2.5 : 1;
      reasons.push("opening group-game caution trims marginal over-1.5 bets");
    }
  }

  if (market === "both_teams_to_score" && outcome === "Yes") {
    const bttsHistory = mean([Number(model.components.homeBttsRate || 0.48), Number(model.components.awayBttsRate || 0.48)]);

    if (expectedGoals >= 2.55 && lowerTeamExpectedGoals >= 0.9) {
      score += 6;
      reasons.push(`BTTS shape is balanced at ${homeExpectedGoals.toFixed(2)}-${awayExpectedGoals.toFixed(2)} expected goals`);
    } else if (lowerTeamExpectedGoals < 0.72) {
      score -= 9;
      reasons.push(`BTTS shape is one-sided at ${homeExpectedGoals.toFixed(2)}-${awayExpectedGoals.toFixed(2)} expected goals`);
    } else if (expectedGoals < 2.25) {
      score -= 7;
      reasons.push(`BTTS total-goals base is low at ${expectedGoals} expected goals`);
    }

    if (bttsHistory >= 0.56) {
      score += 3;
      reasons.push(`20-match BTTS history is lively at ${round(bttsHistory * 100, 1)}%`);
    } else if (bttsHistory <= 0.36) {
      score -= 4;
      reasons.push(`20-match BTTS history is low at ${round(bttsHistory * 100, 1)}%`);
    }

    if (openingCaution > 0 && expectedGoals < 2.85) {
      score -= bothOpeningGroupGame ? 5 : 2.5;
      reasons.push("opening group-game caution asks BTTS to clear a higher bar");
    } else if (openingCaution > 0 && lowerTeamExpectedGoals >= 1 && expectedGoals >= 2.95) {
      reasons.push("BTTS survives opening-game caution because both sides still project scoring threat");
    }
  }

  if (market === "under_2_5_goals" || (market === "both_teams_to_score" && outcome === "No")) {
    const overHistory = mean([Number(model.components.homeOver25Rate || 0.48), Number(model.components.awayOver25Rate || 0.48)]);
    const cleanSheetHistory = mean([Number(model.components.homeCleanSheetRate || 0.28), Number(model.components.awayCleanSheetRate || 0.28)]);

    if (expectedGoals <= 2.34) {
      score += 5;
      reasons.push(`goal model expects a tighter game at ${expectedGoals} expected goals`);
    } else if (expectedGoals > 2.75) {
      score -= 8;
      reasons.push(`goal model is too open for this angle at ${expectedGoals} expected goals`);
    }

    if (market === "under_2_5_goals" && overHistory <= 0.42) {
      score += 3;
      reasons.push(`20-match over-2.5 history is modest at ${round(overHistory * 100, 1)}%`);
    }

    if (market === "both_teams_to_score" && outcome === "No" && cleanSheetHistory >= 0.36) {
      score += 3;
      reasons.push(`20-match clean-sheet signal is useful at ${round(cleanSheetHistory * 100, 1)}%`);
    }

    if (openingCaution > 0 && expectedGoals <= 2.58) {
      score += bothOpeningGroupGame ? 3 : 1.5;
      reasons.push("opening group-game caution supports a tighter first-game angle");
    }
  }

  if (market === "under_3_5_goals" || market === "under_4_5_goals") {
    const line = market === "under_4_5_goals" ? 4.5 : 3.5;
    const ceiling = line === 4.5 ? 3.65 : 3.05;

    if (expectedGoals <= ceiling) {
      score += line === 4.5 ? 4 : 5;
      reasons.push(`goal model keeps under-${line} below its danger zone at ${expectedGoals} expected goals`);
    } else if (expectedGoals > (line === 4.5 ? 4.0 : 3.35)) {
      score -= 7;
      reasons.push(`goal model is too open for under-${line} at ${expectedGoals} expected goals`);
    }

    if (openingCaution > 0) {
      score += bothOpeningGroupGame ? 2.5 : 1;
      reasons.push("opening group-game caution helps a safer goals ceiling");
    }

    if (heatStress >= 0.45 && heatConfidence >= 0.35) {
      score += 1.5;
      reasons.push("heat layer modestly supports a lower game tempo");
    }
  }

  if (market === "match_winner") {
    if (outcome === "Draw" && openingCaution > 0 && Math.abs(Number(model.components.independentResultEdge || 0)) <= 42) {
      score += bothOpeningGroupGame ? 3 : 1.5;
      reasons.push("opening group-game caution gives the draw a small tournament-pressure lift");
    }

    if (styleEdge >= 18 || memoryEdge >= 10) {
      score += 4;
      reasons.push("team/result market backed by style or memory edge");
    }

    if (heatStress >= 0.45 && heatConfidence >= 0.35 && Math.abs(Number(model.components.heatEdge || 0)) >= 4) {
      score += 2;
      reasons.push("heat layer gives a small adaptation edge");
    }

    if (Number(odds.decimalOdds) < 1.55 && appetite > 0.45) {
      score -= 7;
      reasons.push("short favourite price is not interesting for this risk profile");
    }
  }

  if (market === "draw_no_bet") {
    if (appetite < 0.45 && modelProbability >= 0.57) {
      score += 5;
      reasons.push("draw-no-bet suits lower risk and decent model probability");
    } else if (appetite > 0.7 && Number(odds.decimalOdds) < 1.45) {
      score -= 5;
      reasons.push("draw-no-bet is too conservative for bold mode at this price");
    }
  }

  if (market === "double_chance") {
    const shortPrice = Number(odds.decimalOdds) < 1.22;

    if (modelProbability >= 0.68) {
      score += 5;
      reasons.push(`double chance suits survival with model probability ${round(modelProbability * 100, 1)}%`);
    } else if (modelProbability < 0.58) {
      score -= 6;
      reasons.push("double chance does not clear the survival bar");
    }

    if (/draw/i.test(outcome) && openingCaution > 0) {
      score += bothOpeningGroupGame ? 2 : 1;
      reasons.push("draw cover fits the don't-lose-first tournament layer");
    }

    if (shortPrice && appetite > 0.58) {
      score -= 3;
      reasons.push("double chance price is very short for bold risk settings");
    }
  }

  if (isScorerMarket(market)) {
    if (expectedGoals >= 2.65) {
      score += 4;
      reasons.push(`goals environment is live at ${expectedGoals} expected goals`);
    } else if (expectedGoals <= 2.15) {
      score -= 5;
      reasons.push(`goals environment is thin at ${expectedGoals} expected goals`);
    }

    if (Number(odds.decimalOdds) < 1.75 && appetite > 0.45) {
      score -= 5;
      reasons.push("scorer price is too short for this risk setting");
    }

    if (Number(odds.decimalOdds) >= 3 && appetite >= 0.45 && modelProbability >= (market === "first_goalscorer" ? 0.08 : 0.2)) {
      score += 3;
      reasons.push("scorer price gives the betslip a higher-upside angle");
    }

    if (market === "first_goalscorer" && appetite < 0.55) {
      score -= 4;
      reasons.push("first goalscorer is reserved for bolder risk settings");
    }
  }

  if (edge > 0.055 && dataCompleteness >= 0.62) {
    score += 4;
    reasons.push("edge is strong enough to justify focus");
  }

  if (modelProbability < 0.38 && Number(odds.decimalOdds) < 2.2) {
    score -= 5;
    reasons.push("probability/price shape is not attractive");
  }

  return {
    score: clamp(score, -12, 12),
    reasons
  };
}

function riskAppetite(policy) {
  const maxCombinedOdds = Number(policy.riskProfile?.maxCombinedOdds || 45);
  return clamp((maxCombinedOdds - 22) / 58, 0, 1);
}

function nullableComponent(value) {
  if (value == null || value === "") {
    return null;
  }

  return Number.isFinite(Number(value)) ? round(Number(value), 4) : null;
}

function teamTextMatches(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

function playerStatKey(team, playerName) {
  return `${normalizeName(team)}|${normalizeName(playerName)}`;
}

function isScorerMarket(market) {
  return market === "anytime_scorer" || market === "first_goalscorer";
}

function blendProbability(modelProbability, marketProbability, weight) {
  if (!Number.isFinite(Number(marketProbability))) {
    return modelProbability;
  }

  return round(clamp(Number(modelProbability || 0) * (1 - weight) + Number(marketProbability || 0) * weight, 0.03, 0.92), 4);
}
