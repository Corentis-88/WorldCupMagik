import { appendJsonRecords, readJson, upsertJsonRecords, writeJson } from "./db.mjs";
import { clamp, decimalToImpliedProbability, makeId, mean, round } from "./utils.mjs";

export async function loadIntelligenceState() {
  const [matchHistory, teamIntelligence, observations] = await Promise.all([
    readJson(["data", "team-match-history.json"], []),
    readJson(["data", "team-intelligence-latest.json"], []),
    readJson(["data", "intelligence-observations.json"], [])
  ]);

  return {
    matchHistory,
    teamIntelligence,
    observations
  };
}

export async function loadOutcomeLearning() {
  const outcomes = await readJson(["data", "bet-outcomes.json"], []);
  return buildOutcomeLearning(outcomes);
}

export function buildOutcomeLearning(outcomes = []) {
  const settled = outcomes.filter((outcome) => outcome.status === "won" || outcome.status === "lost");
  const byMarket = new Map();
  const byRiskTag = new Map();

  for (const outcome of settled) {
    incrementLearning(byMarket, outcome.market || outcome.type || "unknown", outcome.status);

    for (const tag of outcome.riskTags || [outcome.riskTag].filter(Boolean)) {
      incrementLearning(byRiskTag, tag, outcome.status);
    }
  }

  return {
    outcomeCount: settled.length,
    market: Object.fromEntries([...byMarket.entries()].map(([key, value]) => [key, finalizeLearning(value)])),
    riskTag: Object.fromEntries([...byRiskTag.entries()].map(([key, value]) => [key, finalizeLearning(value)]))
  };
}

export function outcomeLearningAdjustment({ market, riskTag, outcomeLearning }) {
  if (!outcomeLearning || outcomeLearning.outcomeCount < 8) {
    return {
      adjustment: 0,
      confidence: 0,
      reasons: []
    };
  }

  const marketLearning = outcomeLearning.market?.[market];
  const tagLearning = outcomeLearning.riskTag?.[riskTag];
  const marketAdjustment = marketLearning ? learningToAdjustment(marketLearning) : 0;
  const tagAdjustment = tagLearning ? learningToAdjustment(tagLearning) : 0;
  const adjustment = clamp(marketAdjustment * 0.65 + tagAdjustment * 0.35, -0.08, 0.08);
  const confidence = clamp(mean([
    marketLearning ? Math.min(1, marketLearning.count / 20) : 0,
    tagLearning ? Math.min(1, tagLearning.count / 20) : 0
  ]), 0, 1);
  const reasons = [];

  if (marketLearning) {
    reasons.push(`${market} historical strike ${round(marketLearning.winRate * 100, 1)}% over ${marketLearning.count}`);
  }

  if (tagLearning) {
    reasons.push(`${riskTag} historical strike ${round(tagLearning.winRate * 100, 1)}% over ${tagLearning.count}`);
  }

  return {
    adjustment: round(adjustment, 4),
    confidence: round(confidence, 4),
    reasons
  };
}

export function buildTeamStatsWithIntelligence({ baseStats, matchHistory = [], teamIntelligence = [], now = new Date() }) {
  const memoryByTeam = new Map(teamIntelligence.map((item) => [item.team, item]));

  return baseStats.map((team) => {
    const form = deriveTeamForm(matchHistory, team.team, now);
    const memory = memoryByTeam.get(team.team) || {};
    const formXgFor = form.matchCount ? form.xgFor : Number(team.xgFor || 1.35);
    const formXgAgainst = form.matchCount ? form.xgAgainst : Number(team.xgAgainst || 1.2);
    const formPossession = form.matchCount ? form.possession : Number(team.possession || 50);
    const formShotsFor = form.matchCount ? form.shotsFor : Number(team.shotsFor || 10);
    const formShotsAgainst = form.matchCount ? form.shotsAgainst : Number(team.shotsAgainst || 10);
    const memoryScore = Number(memory.learnedEdge || 0);
    const memoryConfidence = Number(memory.dataConfidence || 0);

    return {
      ...team,
      recentPointsPerGame: round(blend(Number(team.recentPointsPerGame || 1.4), form.pointsPerGame, form.matchCount ? 0.46 : 0), 3),
      xgFor: round(blend(Number(team.xgFor || 1.35), formXgFor, form.matchCount ? 0.34 : 0), 3),
      xgAgainst: round(blend(Number(team.xgAgainst || 1.2), formXgAgainst, form.matchCount ? 0.34 : 0), 3),
      shotsFor: round(blend(Number(team.shotsFor || 10), formShotsFor, form.matchCount ? 0.28 : 0), 2),
      shotsAgainst: round(blend(Number(team.shotsAgainst || 10), formShotsAgainst, form.matchCount ? 0.28 : 0), 2),
      possession: round(blend(Number(team.possession || 50), formPossession, form.matchCount ? 0.2 : 0), 1),
      rating: round(Number(team.rating || 1700) + form.formMomentum * 22 + memoryScore * 24, 1),
      statsCompleteness: round(clamp(mean([
        team.statsCompleteness || 0.5,
        form.matchCount ? 0.72 + Math.min(0.18, form.matchCount * 0.03) : 0.4,
        memoryConfidence || 0.42
      ]), 0, 1), 3),
      formMemory: form,
      learnedEdge: round(memoryScore, 4),
      intelligenceConfidence: round(memoryConfidence, 4),
      memoryNewsImpact: round(Number(memory.news?.impact || 0), 4),
      memoryOddsPressure: round(Number(memory.market?.pressure || 0), 4),
      memoryConsensusOdds: memory.market?.consensusOdds || null,
      memoryReasons: memory.reasons || []
    };
  });
}

export function buildScanIntelligence({ fixtures, oddsRecords, allOddsSnapshots, newsArticles, teamStats, matchHistory, previousTeamIntelligence = [], now = new Date() }) {
  const teams = [...new Set(fixtures.flatMap((fixture) => [fixture.homeTeam, fixture.awayTeam]))];
  const previousByTeam = new Map(previousTeamIntelligence.map((item) => [item.team, item]));
  const newsByTeam = aggregateNewsByTeam(newsArticles, teams, now);
  const movementByOutcome = buildOddsMovementSummaries(allOddsSnapshots.length ? allOddsSnapshots : oddsRecords);
  const statsByTeam = new Map(teamStats.map((team) => [team.team, team]));
  const observations = [];
  const teamIntelligence = [];

  for (const team of teams) {
    const form = deriveTeamForm(matchHistory, team, now);
    const news = newsByTeam.get(team) || neutralNews();
    const market = marketPressureForTeam({ team, fixtures, movementByOutcome });
    const previous = previousByTeam.get(team);
    const previousEdge = Number(previous?.learnedEdge || 0);
    const stats = statsByTeam.get(team) || {};
    const learnedEdge = clamp(
      previousEdge * 0.48
      + form.formMomentum * 0.2
      + news.impact * 0.28
      + market.pressure * 0.18
      + (Number(stats.learnedEdge || 0) * 0.12),
      -0.65,
      0.65
    );
    const dataConfidence = clamp(mean([
      form.confidence,
      news.confidence,
      market.confidence,
      Number(stats.statsCompleteness || 0.5),
      previous?.dataConfidence || 0.42
    ]), 0, 1);
    const reasons = buildReasons({ form, news, market, learnedEdge });
    const item = {
      team,
      updatedAt: now.toISOString(),
      learnedEdge: round(learnedEdge, 4),
      dataConfidence: round(dataConfidence, 4),
      form,
      news,
      market,
      reasons
    };

    teamIntelligence.push(item);
    observations.push({
      id: makeId("intel_obs", [now.toISOString(), team, JSON.stringify(item)]),
      createdAt: now.toISOString(),
      team,
      learnedEdge: item.learnedEdge,
      dataConfidence: item.dataConfidence,
      articleCount: news.articleCount,
      oddsPressure: market.pressure,
      formMomentum: form.formMomentum,
      reasons
    });
  }

  return {
    createdAt: now.toISOString(),
    teamIntelligence,
    observations,
    marketMovements: [...movementByOutcome.values()]
  };
}

export async function persistScanIntelligence(intelligence) {
  await writeJson(["data", "team-intelligence-latest.json"], intelligence.teamIntelligence);
  await upsertJsonRecords(["data", "intelligence-observations.json"], intelligence.observations, (item) => item.id, 5000);
  await appendJsonRecords(["data", "team-intelligence-history.json"], [{
    id: makeId("intel_run", [intelligence.createdAt, intelligence.teamIntelligence.length]),
    createdAt: intelligence.createdAt,
    teamCount: intelligence.teamIntelligence.length,
    teams: intelligence.teamIntelligence
  }], 1000);
  await appendJsonRecords(["data", "market-movement-observations.json"], intelligence.marketMovements, 10000);
}

export function deriveTeamForm(matchHistory, team, now = new Date(), limit = 6) {
  const matches = matchHistory
    .filter((match) => new Date(match.date) < now)
    .filter((match) => match.homeTeam === team || match.awayTeam === team)
    .sort((left, right) => new Date(right.date) - new Date(left.date))
    .slice(0, limit);

  if (!matches.length) {
    return {
      matchCount: 0,
      pointsPerGame: 1.4,
      goalsFor: 1.2,
      goalsAgainst: 1.1,
      xgFor: 1.35,
      xgAgainst: 1.2,
      shotsFor: 10,
      shotsAgainst: 10,
      possession: 50,
      formMomentum: 0,
      confidence: 0.35
    };
  }

  const rows = matches.map((match) => {
    const isHome = match.homeTeam === team;
    const goalsFor = Number(isHome ? match.homeGoals : match.awayGoals);
    const goalsAgainst = Number(isHome ? match.awayGoals : match.homeGoals);
    const points = goalsFor > goalsAgainst ? 3 : goalsFor === goalsAgainst ? 1 : 0;

    return {
      points,
      goalsFor,
      goalsAgainst,
      xgFor: Number(isHome ? match.homeXg : match.awayXg),
      xgAgainst: Number(isHome ? match.awayXg : match.homeXg),
      shotsFor: Number(isHome ? match.homeShots : match.awayShots),
      shotsAgainst: Number(isHome ? match.awayShots : match.homeShots),
      possession: Number(isHome ? match.homePossession : match.awayPossession)
    };
  });
  const latestThree = rows.slice(0, 3);
  const priorThree = rows.slice(3, 6);
  const latestPpg = mean(latestThree.map((row) => row.points));
  const priorPpg = priorThree.length ? mean(priorThree.map((row) => row.points)) : 1.4;
  const xgDelta = mean(latestThree.map((row) => row.xgFor - row.xgAgainst));
  const formMomentum = clamp(((latestPpg - priorPpg) / 3) + xgDelta * 0.12, -0.55, 0.55);

  return {
    matchCount: rows.length,
    pointsPerGame: round(mean(rows.map((row) => row.points)), 3),
    goalsFor: round(mean(rows.map((row) => row.goalsFor)), 3),
    goalsAgainst: round(mean(rows.map((row) => row.goalsAgainst)), 3),
    xgFor: round(mean(rows.map((row) => row.xgFor)), 3),
    xgAgainst: round(mean(rows.map((row) => row.xgAgainst)), 3),
    shotsFor: round(mean(rows.map((row) => row.shotsFor)), 2),
    shotsAgainst: round(mean(rows.map((row) => row.shotsAgainst)), 2),
    possession: round(mean(rows.map((row) => row.possession)), 1),
    formMomentum: round(formMomentum, 4),
    confidence: round(clamp(0.42 + rows.length * 0.08, 0, 0.86), 3)
  };
}

export function buildOddsMovementSummaries(oddsSnapshots) {
  const grouped = new Map();

  for (const record of oddsSnapshots) {
    const key = outcomeKey(record.fixtureId, record.market, record.outcome);
    const existing = grouped.get(key) || [];
    existing.push(record);
    grouped.set(key, existing);
  }

  const summaries = new Map();

  for (const [key, records] of grouped.entries()) {
    const byCapture = new Map();

    for (const record of records) {
      const bucket = byCapture.get(record.capturedAt) || [];
      bucket.push(record);
      byCapture.set(record.capturedAt, bucket);
    }

    const captures = [...byCapture.entries()]
      .map(([capturedAt, items]) => ({
        capturedAt,
        records: items,
        averageDecimalOdds: round(mean(items.map((item) => item.decimalOdds)), 4),
        best: items.reduce((winner, item) => Number(item.decimalOdds) > Number(winner.decimalOdds) ? item : winner, items[0]),
        bookmakerCount: new Set(items.map((item) => item.bookmaker)).size
      }))
      .sort((left, right) => new Date(right.capturedAt) - new Date(left.capturedAt));

    const latest = captures[0];
    const previous = captures.find((capture) => capture.capturedAt !== latest.capturedAt);
    const movement = previous ? round((latest.averageDecimalOdds - previous.averageDecimalOdds) / previous.averageDecimalOdds, 4) : 0;
    const bestOverAverage = latest.averageDecimalOdds > 0 ? round((Number(latest.best.decimalOdds) - latest.averageDecimalOdds) / latest.averageDecimalOdds, 4) : 0;

    summaries.set(key, {
      key,
      fixtureId: latest.best.fixtureId,
      market: latest.best.market,
      outcome: latest.best.outcome,
      capturedAt: latest.capturedAt,
      bestRecord: latest.best,
      averageDecimalOdds: latest.averageDecimalOdds,
      bookmakerCount: latest.bookmakerCount,
      previousAverageDecimalOdds: previous?.averageDecimalOdds || null,
      movement,
      shortening: movement < -0.015,
      drifting: movement > 0.015,
      bestOverAverage,
      marketImpliedProbability: round(decimalToImpliedProbability(latest.averageDecimalOdds), 4)
    });
  }

  return summaries;
}

function aggregateNewsByTeam(newsArticles, teams, now) {
  const byTeam = new Map();

  for (const article of newsArticles) {
    for (const team of article.teamTags || []) {
      if (!teams.includes(team)) {
        continue;
      }

      const existing = byTeam.get(team) || [];
      existing.push(article);
      byTeam.set(team, existing);
    }
  }

  const result = new Map();

  for (const team of teams) {
    result.set(team, aggregateNews(byTeam.get(team) || [], now));
  }

  return result;
}

function aggregateNews(articles) {
  if (!articles.length) {
    return neutralNews();
  }

  const usable = articles.filter((article) => article.acceptedSource !== false);
  const weighted = usable.length ? usable : articles;
  const totalReliability = weighted.reduce((total, article) => total + Number(article.sourceReliability || 0.5), 0) || 1;
  const sentiment = weighted.reduce((total, article) => total + Number(article.sentiment || 0) * Number(article.sourceReliability || 0.5), 0) / totalReliability;
  const injury = weighted.reduce((total, article) => total + Number(article.signals?.injury || 0) * Number(article.sourceReliability || 0.5), 0) / totalReliability;
  const tacticalFit = weighted.reduce((total, article) => total + Number(article.signals?.tacticalFit || 0.45) * Number(article.sourceReliability || 0.5), 0) / totalReliability;
  const lineupClarity = weighted.reduce((total, article) => total + Number(article.signals?.lineupClarity || 0.45) * Number(article.sourceReliability || 0.5), 0) / totalReliability;
  const rotationRisk = weighted.reduce((total, article) => total + Number(article.signals?.rotationRisk || 0.18) * Number(article.sourceReliability || 0.5), 0) / totalReliability;
  const sourceDiversity = new Set(weighted.map((article) => article.source || article.provider)).size;
  const impact = clamp(sentiment * 0.5 + tacticalFit * 0.14 + lineupClarity * 0.12 - injury * 0.32 - rotationRisk * 0.12, -0.6, 0.6);

  return {
    articleCount: weighted.length,
    sourceDiversity,
    sentiment: round(sentiment, 4),
    injury: round(injury, 4),
    tacticalFit: round(tacticalFit, 4),
    lineupClarity: round(lineupClarity, 4),
    rotationRisk: round(rotationRisk, 4),
    impact: round(impact, 4),
    confidence: round(clamp(0.32 + sourceDiversity * 0.1 + mean(weighted.map((article) => article.sourceReliability || 0.5)) * 0.38, 0, 0.92), 4),
    topSignals: topNewsSignals(weighted)
  };
}

function marketPressureForTeam({ team, fixtures, movementByOutcome }) {
  const movements = [];

  for (const fixture of fixtures) {
    if (![fixture.homeTeam, fixture.awayTeam].includes(team)) {
      continue;
    }

    const matchWinner = movementByOutcome.get(outcomeKey(fixture.id, "match_winner", team));
    const drawNoBet = movementByOutcome.get(outcomeKey(fixture.id, "draw_no_bet", team));
    movements.push(...[matchWinner, drawNoBet].filter(Boolean));
  }

  if (!movements.length) {
    return {
      pressure: 0,
      confidence: 0.28,
      consensusOdds: null,
      movement: 0,
      bookmakerCount: 0
    };
  }

  const movement = mean(movements.map((item) => Number(item.movement || 0)));
  const pressure = clamp(-movement * 4.5, -0.45, 0.45);
  const bookmakerCount = Math.max(...movements.map((item) => Number(item.bookmakerCount || 0)));

  return {
    pressure: round(pressure, 4),
    confidence: round(clamp(0.34 + bookmakerCount * 0.08 + movements.length * 0.06, 0, 0.9), 4),
    consensusOdds: round(mean(movements.map((item) => item.averageDecimalOdds)), 3),
    movement: round(movement, 4),
    bookmakerCount
  };
}

function neutralNews() {
  return {
    articleCount: 0,
    sourceDiversity: 0,
    sentiment: 0,
    injury: 0,
    tacticalFit: 0.45,
    lineupClarity: 0.45,
    rotationRisk: 0.18,
    impact: 0,
    confidence: 0.32,
    topSignals: []
  };
}

function topNewsSignals(articles) {
  const signals = [];
  const text = articles.map((article) => `${article.title || ""} ${article.description || ""}`).join(" ").toLowerCase();

  if (/injur|doubt|suspend|fatigue/.test(text)) {
    signals.push("availability risk");
  }

  if (/lineup|formation|shape|system/.test(text)) {
    signals.push("lineup/tactical clue");
  }

  if (/fit|return|available|training/.test(text)) {
    signals.push("positive availability");
  }

  if (/set piece|press|counter|transition/.test(text)) {
    signals.push("style clue");
  }

  return signals.slice(0, 4);
}

function buildReasons({ form, news, market, learnedEdge }) {
  const reasons = [];

  if (form.matchCount) {
    reasons.push(`recent form ${form.pointsPerGame} PPG, xG ${form.xgFor}-${form.xgAgainst}`);
  }

  if (Math.abs(form.formMomentum) >= 0.08) {
    reasons.push(form.formMomentum > 0 ? "recent form improving" : "recent form cooling");
  }

  if (news.articleCount) {
    reasons.push(`${news.articleCount} news item(s), news impact ${news.impact}`);
  }

  if (market.bookmakerCount) {
    reasons.push(`market movement ${round(market.movement * 100, 2)}% across ${market.bookmakerCount} bookie(s)`);
  }

  if (Math.abs(learnedEdge) >= 0.08) {
    reasons.push(learnedEdge > 0 ? "memory currently leans positive" : "memory currently leans negative");
  }

  return reasons;
}

function blend(base, overlay, overlayWeight) {
  return base * (1 - overlayWeight) + Number(overlay || 0) * overlayWeight;
}

function outcomeKey(fixtureId, market, outcome) {
  return `${fixtureId}|${market}|${outcome}`;
}

function incrementLearning(map, key, status) {
  const item = map.get(key) || { count: 0, wins: 0, losses: 0 };
  item.count += 1;

  if (status === "won") {
    item.wins += 1;
  } else {
    item.losses += 1;
  }

  map.set(key, item);
}

function finalizeLearning(item) {
  return {
    ...item,
    winRate: item.count ? round(item.wins / item.count, 4) : 0
  };
}

function learningToAdjustment(item) {
  const sampleWeight = clamp(item.count / 30, 0, 1);
  return (item.winRate - 0.5) * 0.16 * sampleWeight;
}
