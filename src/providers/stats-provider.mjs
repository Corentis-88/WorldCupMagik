import { clamp, makeId, mean, normalizeName, round } from "../utils.mjs";
import {
  cleanTeamName,
  decodeEntities,
  extractHtmlTables,
  fetchPublicText,
  parseDate,
  sourceDiagnostic,
  teamNameMatches,
  uniqueBy
} from "./public-source.mjs";

const DEFAULT_ALIASES = {
  "USA": "United States men's",
  "United States": "United States men's",
  "Czechia": "Czech Republic",
  "Turkiye": "Turkey",
  "Türkiye": "Turkey",
  "DR Congo": "DR Congo",
  "Congo DR": "DR Congo",
  "Ivory Coast": "Ivory Coast",
  "South Korea": "South Korea",
  "Saudi Arabia": "Saudi Arabia",
  "New Zealand": "New Zealand",
  "Cape Verde": "Cape Verde",
  "Bosnia": "Bosnia and Herzegovina"
};

export async function fetchTeamStats({ providerConfig, fixtures = [], now = new Date() }) {
  const result = await fetchTeamStatsWithDiagnostics({ providerConfig, fixtures, now });
  return result.records;
}

export async function fetchTeamStatsWithDiagnostics({ providerConfig, fixtures = [], now = new Date() }) {
  const mode = providerConfig?.mode || "self-gather";

  if (mode !== "self-gather") {
    throw new Error(`Unsupported stats provider mode: ${mode}. WorldCupMagik stats use public web pages only.`);
  }

  const teams = [...new Set(fixtures.flatMap((fixture) => [fixture.homeTeam, fixture.awayTeam]).filter(Boolean))];
  const aliases = { ...DEFAULT_ALIASES, ...(providerConfig?.teamAliases || {}) };
  const matchHistory = [];
  const diagnostics = [];

  for (const team of teams) {
    const sources = teamSources(team, aliases, providerConfig);
    let teamMatches = [];

    for (const source of sources) {
      try {
        const html = await fetchPublicText(source.url, providerConfig);
        const extracted = extractTeamMatches({ html, team, source, now });
        teamMatches.push(...extracted);
        diagnostics.push(sourceDiagnostic({
          kind: "stats",
          source,
          status: extracted.length ? "ok" : "empty",
          records: extracted.length,
          reason: extracted.length ? "" : `Fetched public team page but found no completed result rows for ${team}.`,
          now
        }));

        if (extracted.length >= Number(providerConfig?.targetRecentMatches || 3)) {
          break;
        }
      } catch (error) {
        diagnostics.push(sourceDiagnostic({
          kind: "stats",
          source,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
          now
        }));
      }
    }

    teamMatches = uniqueBy(teamMatches, matchHistoryKey)
      .sort((left, right) => new Date(right.date) - new Date(left.date))
      .slice(0, Number(providerConfig?.maxRecentMatches || 20));
    matchHistory.push(...teamMatches);
  }

  const dedupedMatchHistory = uniqueBy(matchHistory, matchHistoryKey);
  const records = teams.map((team) => deriveTeamStats(team, dedupedMatchHistory, now, providerConfig));

  return {
    records,
    matchHistory: dedupedMatchHistory,
    playerStats: derivePlayerStats(teams, dedupedMatchHistory, now, providerConfig),
    diagnostics
  };
}

function teamSources(team, aliases, providerConfig) {
  const sourceTemplates = providerConfig?.sourceTemplates || [
    "https://en.wikipedia.org/wiki/{slug}_national_football_team_results_(2020%E2%80%93present)",
    "https://en.wikipedia.org/wiki/{slug}_national_soccer_team_results_(2020%E2%80%93present)",
    "https://en.wikipedia.org/wiki/{slug}_men%27s_national_soccer_team_results_(2020%E2%80%93present)"
  ];
  const canonical = aliases[team] || team;
  const slug = encodeURIComponent(canonical.replace(/\s+/g, "_"));

  return sourceTemplates.map((template, index) => ({
    name: `${team} public results ${index + 1}`,
    url: template.replace("{slug}", slug),
    matchNames: matchNameVariants(team, canonical),
    reliability: index === 0 ? 0.78 : 0.7
  }));
}

function extractTeamMatches({ html, team, source, now }) {
  const tables = extractHtmlTables(html);
  const matches = [];

  for (const table of tables) {
    const firstRow = table[0] || [];

    if (firstRow.length < 4) {
      continue;
    }

    const row = firstRow.map((cell) => cleanCell(cell));
    const parsed = parseResultRow(row, team, source, now);

    if (parsed) {
      const detailScorers = extractScorersFromDetailRow((table[1] || []).map((cell) => cleanCell(cell)));
      parsed.homeScorers = detailScorers.home.length ? detailScorers.home : parsed.homeScorers;
      parsed.awayScorers = detailScorers.away.length ? detailScorers.away : parsed.awayScorers;
      matches.push(parsed);
    }
  }

  return matches;
}

function parseResultRow(row, team, source, now) {
  const date = parseDate(row[0], now.getFullYear());
  const scoreIndex = row.findIndex((cell) => /^\d+\s*[\u2010-\u2015-]\s*\d+$/.test(cell));

  if (!date || scoreIndex < 1 || new Date(date) >= now) {
    return null;
  }

  const homeTeam = cleanTeamName(row[scoreIndex - 1]);
  const awayTeam = cleanTeamName(row[scoreIndex + 1]);
  const score = row[scoreIndex].match(/(\d+)\s*[\u2010-\u2015-]\s*(\d+)/);

  if (!homeTeam || !awayTeam || !score) {
    return null;
  }

  const matchNames = source.matchNames || [team];

  if (!teamMatchesAny(homeTeam, matchNames) && !teamMatchesAny(awayTeam, matchNames)) {
    return null;
  }

  const homeGoals = Number(score[1]);
  const awayGoals = Number(score[2]);

  return {
    id: makeId("match", [date.toISOString(), homeTeam, awayTeam, homeGoals, awayGoals]),
    createdAt: now.toISOString(),
    date: date.toISOString(),
    homeTeam,
    awayTeam,
    homeGoals,
    awayGoals,
    homeXg: estimateXg(homeGoals),
    awayXg: estimateXg(awayGoals),
    homeShots: estimateShots(homeGoals),
    awayShots: estimateShots(awayGoals),
    homeShotsOnTarget: estimateShotsOnTarget(homeGoals),
    awayShotsOnTarget: estimateShotsOnTarget(awayGoals),
    homePossession: 50 + possessionNudge(homeGoals, awayGoals),
    awayPossession: 50 - possessionNudge(homeGoals, awayGoals),
    homeScorers: extractScorersFromRow(row, scoreIndex, "home"),
    awayScorers: extractScorersFromRow(row, scoreIndex, "away"),
    competition: cleanCompetition(row[0]),
    metricSource: "score-derived-estimates",
    capturedMetricFields: ["date", "homeTeam", "awayTeam", "homeGoals", "awayGoals"],
    source: source.name,
    sourceUrl: source.url,
    sourceType: "public-web"
  };
}

function deriveTeamStats(team, matchHistory, now, providerConfig = {}) {
  const maxMatches = Number(providerConfig?.maxRecentMatches || 20);
  const shortWindowSize = Number(providerConfig?.formWindows?.short || 6);
  const longWindowSize = Number(providerConfig?.formWindows?.long || maxMatches);
  const matchNames = teamMatchNames(team, providerConfig);
  const matches = matchHistory
    .filter((match) => new Date(match.date) < now)
    .filter((match) => teamMatchesAny(match.homeTeam, matchNames) || teamMatchesAny(match.awayTeam, matchNames))
    .sort((left, right) => new Date(right.date) - new Date(left.date))
    .slice(0, maxMatches);

  if (!matches.length) {
    return {
      team,
      updatedAt: now.toISOString(),
      provider: "public-web",
      recentPointsPerGame: 1.35,
      xgFor: 1.25,
      xgAgainst: 1.25,
      shotsFor: 10,
      shotsAgainst: 10,
      shotsOnTargetFor: 3.5,
      shotsOnTargetAgainst: 3.5,
      possession: 50,
      highPressIndex: 50,
      setPieceThreat: 50,
      transitionThreat: 50,
      keeperForm: 50,
      rating: 1650,
      statsCompleteness: 0.22,
      sourceMatchCount: 0,
      sourceReliability: 0
    };
  }

  const rows = matches.map((match) => teamMatchRow(match, matchNames));
  const shortRows = rows.slice(0, shortWindowSize);
  const longRows = rows.slice(0, longWindowSize);
  const shortForm = summarizeRows(shortRows);
  const longForm = summarizeRows(longRows);
  const priorRows = rows.slice(shortWindowSize, Math.min(rows.length, shortWindowSize + 8));
  const priorForm = priorRows.length ? summarizeRows(priorRows) : longForm;
  const pointsPerGame = blend(shortForm.pointsPerGame, longForm.pointsPerGame, 0.42);
  const xgFor = blend(shortForm.xgFor, longForm.xgFor, 0.46);
  const xgAgainst = blend(shortForm.xgAgainst, longForm.xgAgainst, 0.46);
  const shotsFor = blend(shortForm.shotsFor, longForm.shotsFor, 0.46);
  const shotsAgainst = blend(shortForm.shotsAgainst, longForm.shotsAgainst, 0.46);
  const shotsOnTargetFor = blend(shortForm.shotsOnTargetFor, longForm.shotsOnTargetFor, 0.46);
  const shotsOnTargetAgainst = blend(shortForm.shotsOnTargetAgainst, longForm.shotsOnTargetAgainst, 0.46);
  const possession = blend(shortForm.possession, longForm.possession, 0.36);
  const goalDiff = blend(shortForm.goalDifference, longForm.goalDifference, 0.5);
  const xgDiff = xgFor - xgAgainst;
  const formTrend = clamp((shortForm.pointsPerGame - priorForm.pointsPerGame) / 3 + (shortForm.xgDifference - priorForm.xgDifference) * 0.12, -0.55, 0.55);
  const scorerSummary = summarizeTeamScorers(matches, matchNames);

  return {
    team,
    updatedAt: now.toISOString(),
    provider: "public-web",
    recentPointsPerGame: round(pointsPerGame, 3),
    xgFor: round(xgFor, 3),
    xgAgainst: round(xgAgainst, 3),
    shotsFor: round(shotsFor, 2),
    shotsAgainst: round(shotsAgainst, 2),
    shotsOnTargetFor: round(shotsOnTargetFor, 2),
    shotsOnTargetAgainst: round(shotsOnTargetAgainst, 2),
    possession: round(possession, 1),
    highPressIndex: round(clamp(50 + (shotsFor - shotsAgainst) * 2.2 + possession * 0.18 - 9, 30, 78), 1),
    setPieceThreat: round(clamp(49 + longForm.goalsFor * 4 + Math.max(0, shotsFor - 9) * 0.8, 30, 78), 1),
    transitionThreat: round(clamp(50 + goalDiff * 7 + Math.max(0, xgDiff) * 8, 30, 80), 1),
    keeperForm: round(clamp(52 - longForm.goalsAgainst * 4.5 + Math.max(0, 11 - shotsAgainst) * 1.5, 30, 80), 1),
    rating: round(1650 + pointsPerGame * 34 + goalDiff * 24 + xgDiff * 18 + formTrend * 28, 1),
    statsCompleteness: round(clamp(0.32 + matches.length * 0.035, 0, 0.92), 3),
    sourceMatchCount: matches.length,
    sourceMatchTarget: maxMatches,
    sourceReliability: 0.75,
    metricSource: "score-derived-estimates",
    capturedMetricFields: ["date", "homeTeam", "awayTeam", "homeGoals", "awayGoals"],
    derivedMetricFields: ["xgFor", "xgAgainst", "shotsFor", "shotsAgainst", "shotsOnTargetFor", "shotsOnTargetAgainst", "possession"],
    recentForm: {
      ...shortForm,
      window: shortRows.length
    },
    longForm: {
      ...longForm,
      window: longRows.length
    },
    formTrend: round(formTrend, 4),
    marketAngles: {
      cleanSheetRate: longForm.cleanSheetRate,
      failedToScoreRate: longForm.failedToScoreRate,
      bttsRate: longForm.bttsRate,
      over25Rate: longForm.over25Rate,
      scoringGameRate: longForm.scoringGameRate,
      concedeGameRate: longForm.concedeGameRate
    },
    scorerSummary,
    recentMatches: matches.map((match) => ({
      date: match.date,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      score: `${match.homeGoals}-${match.awayGoals}`,
      homeScorers: match.homeScorers || [],
      awayScorers: match.awayScorers || [],
      source: match.source
    }))
  };
}

function teamMatchRow(match, matchNames) {
  const isHome = teamMatchesAny(match.homeTeam, matchNames);
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
    shotsOnTargetFor: Number(isHome ? match.homeShotsOnTarget : match.awayShotsOnTarget),
    shotsOnTargetAgainst: Number(isHome ? match.awayShotsOnTarget : match.homeShotsOnTarget),
    possession: Number(isHome ? match.homePossession : match.awayPossession)
  };
}

function summarizeRows(rows) {
  const safeRows = rows.length ? rows : [{
    points: 1.4,
    goalsFor: 1.2,
    goalsAgainst: 1.1,
    xgFor: 1.35,
    xgAgainst: 1.2,
    shotsFor: 10,
    shotsAgainst: 10,
    shotsOnTargetFor: 3.5,
    shotsOnTargetAgainst: 3.5,
    possession: 50
  }];
  const goalsFor = mean(safeRows.map((row) => row.goalsFor));
  const goalsAgainst = mean(safeRows.map((row) => row.goalsAgainst));
  const xgFor = mean(safeRows.map((row) => row.xgFor));
  const xgAgainst = mean(safeRows.map((row) => row.xgAgainst));

  return {
    matchCount: rows.length,
    pointsPerGame: round(mean(safeRows.map((row) => row.points)), 3),
    goalsFor: round(goalsFor, 3),
    goalsAgainst: round(goalsAgainst, 3),
    goalDifference: round(goalsFor - goalsAgainst, 3),
    xgFor: round(xgFor, 3),
    xgAgainst: round(xgAgainst, 3),
    xgDifference: round(xgFor - xgAgainst, 3),
    shotsFor: round(mean(safeRows.map((row) => row.shotsFor)), 2),
    shotsAgainst: round(mean(safeRows.map((row) => row.shotsAgainst)), 2),
    shotsOnTargetFor: round(mean(safeRows.map((row) => row.shotsOnTargetFor)), 2),
    shotsOnTargetAgainst: round(mean(safeRows.map((row) => row.shotsOnTargetAgainst)), 2),
    possession: round(mean(safeRows.map((row) => row.possession)), 1),
    cleanSheetRate: round(safeRows.filter((row) => row.goalsAgainst === 0).length / safeRows.length, 3),
    failedToScoreRate: round(safeRows.filter((row) => row.goalsFor === 0).length / safeRows.length, 3),
    bttsRate: round(safeRows.filter((row) => row.goalsFor > 0 && row.goalsAgainst > 0).length / safeRows.length, 3),
    over25Rate: round(safeRows.filter((row) => row.goalsFor + row.goalsAgainst > 2.5).length / safeRows.length, 3),
    scoringGameRate: round(safeRows.filter((row) => row.goalsFor > 0).length / safeRows.length, 3),
    concedeGameRate: round(safeRows.filter((row) => row.goalsAgainst > 0).length / safeRows.length, 3)
  };
}

function summarizeTeamScorers(matches, matchNames) {
  const byPlayer = new Map();

  for (const match of matches) {
    const scorers = teamMatchesAny(match.homeTeam, matchNames) ? match.homeScorers : teamMatchesAny(match.awayTeam, matchNames) ? match.awayScorers : [];

    for (const scorer of scorers || []) {
      const key = normalizeName(scorer.name);
      if (!key) {
        continue;
      }

      const record = byPlayer.get(key) || { playerName: scorer.name, goals: 0, appearancesSampled: 0 };
      record.goals += Number(scorer.goals || 1);
      byPlayer.set(key, record);
    }
  }

  return [...byPlayer.values()]
    .sort((left, right) => right.goals - left.goals || normalizeName(left.playerName).localeCompare(normalizeName(right.playerName)))
    .slice(0, 8)
    .map((record) => ({
      playerName: record.playerName,
      goals: record.goals,
      goalsPerTwentyTeamMatches: round(record.goals / Math.max(1, matches.length) * 20, 3)
    }));
}

function derivePlayerStats(teams, matchHistory, now, providerConfig = {}) {
  const teamByAlias = teamAliasMap(teams, providerConfig);
  const byPlayer = new Map();

  for (const match of matchHistory.filter((item) => new Date(item.date) < now)) {
    for (const side of ["home", "away"]) {
      const sourceTeam = side === "home" ? match.homeTeam : match.awayTeam;
      const team = teamByAlias.get(normalizeName(sourceTeam));

      if (!team) {
        continue;
      }

      const scorers = side === "home" ? match.homeScorers : match.awayScorers;

      for (const scorer of scorers || []) {
        const playerName = scorer.name;
        const key = `${normalizeName(team)}|${normalizeName(playerName)}`;
        const record = byPlayer.get(key) || {
          id: makeId("player_stat", [team, playerName]),
          team,
          playerName,
          updatedAt: now.toISOString(),
          provider: "public-web",
          sourceType: "public-web",
          goals: 0,
          matchesSampled: 0,
          scorerSource: "public result rows"
        };
        record.goals += Number(scorer.goals || 1);
        record.matchesSampled += 1;
        byPlayer.set(key, record);
      }
    }
  }

  return [...byPlayer.values()]
    .map((record) => ({
      ...record,
      goalsPerMatchSample: round(record.goals / Math.max(1, record.matchesSampled), 3),
      scorerConfidence: round(clamp(0.28 + record.matchesSampled * 0.05, 0.28, 0.76), 3)
    }))
    .sort((left, right) => right.goals - left.goals || normalizeName(left.playerName).localeCompare(normalizeName(right.playerName)));
}

function cleanCell(value) {
  return decodeEntities(value)
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCompetition(value) {
  return cleanCell(value)
    .replace(/^\d{1,2}\s+\w+\s+\d{4}\s*/, "")
    .replace(/^\d{1,2}\s+\w+\s*/, "")
    .trim();
}

function estimateXg(goals) {
  return round(clamp(Number(goals) * 0.72 + 0.55, 0.35, 4.2), 2);
}

function estimateShots(goals) {
  return round(clamp(8 + Number(goals) * 3.1, 4, 24), 1);
}

function estimateShotsOnTarget(goals) {
  return round(clamp(2.4 + Number(goals) * 1.35, 1, 12), 1);
}

function possessionNudge(homeGoals, awayGoals) {
  return clamp((Number(homeGoals) - Number(awayGoals)) * 2.5, -8, 8);
}

function extractScorersFromRow(row, scoreIndex, side) {
  const tail = row.slice(scoreIndex + 2).join(" | ");

  if (!/(\d{1,3}\s*(?:'|′|min)|pen\.?|og\b)/i.test(tail)) {
    return [];
  }

  const sidePattern = side === "home"
    ? /(?:home|scorers?|goals?)[:\s-]+([^|]+)/i
    : /(?:away|opponents?|scorers?|goals?)[:\s-]+([^|]+)/i;
  const targeted = tail.match(sidePattern)?.[1] || tail;
  return extractScorersFromText(targeted);
}

function extractScorersFromDetailRow(row) {
  const reportIndex = row.findIndex((cell) => /^report$/i.test(cell) || /\breport\b/i.test(cell));
  const homeText = reportIndex > 0 ? row[reportIndex - 1] : row[1] || "";
  const awayText = reportIndex >= 0 ? row[reportIndex + 1] || "" : row[3] || "";

  return {
    home: extractScorersFromText(homeText),
    away: extractScorersFromText(awayText)
  };
}

function extractScorersFromText(value) {
  const text = cleanCell(value);

  if (!/(\d{1,3}\s*(?:'|′|min)|pen\.?|og\b)/i.test(text)) {
    return [];
  }

  const names = [...text.matchAll(/([A-ZÀ-Ý][A-Za-zÀ-ÿ'.-]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'.-]+){0,3})\s*(?:\d{1,3}\s*(?:'|′|min)|pen\.?|og\b)/g)]
    .map((match) => cleanScorerName(match[1]))
    .filter(Boolean)
    .filter((name) => normalizeName(name).length >= 3 && normalizeName(name) !== "co")
    .filter((name) => !/stadium|attendance|referee|friendly|qualification|league|cup/i.test(name));
  const byName = new Map();

  for (const name of names) {
    const key = normalizeName(name);
    const existing = byName.get(key) || { name, goals: 0 };
    existing.goals += 1;
    byName.set(key, existing);
  }

  return [...byName.values()];
}

function cleanScorerName(value) {
  return cleanCell(value)
    .replace(/\b(?:pen|og|own goal|goal|scorer|scorers)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchNameVariants(team, canonical) {
  const variants = new Set([team, canonical]);

  if (team === "USA" || /United States/i.test(canonical)) {
    variants.add("United States");
    variants.add("United States men's");
    variants.add("USMNT");
  }

  if (team === "Czechia" || /Czech Republic/i.test(canonical)) {
    variants.add("Czech Republic");
    variants.add("Czechia");
  }

  if (team === "Turkiye" || /Turkey/i.test(canonical)) {
    variants.add("Turkey");
    variants.add("Türkiye");
    variants.add("Turkiye");
  }

  variants.add(String(canonical).replace(/\bmen'?s\b/gi, " ").replace(/\s+/g, " ").trim());

  return [...variants].filter(Boolean);
}

function teamMatchNames(team, providerConfig = {}) {
  const configuredAliases = providerConfig?.teamAliases || {};
  const canonical = configuredAliases[team] || DEFAULT_ALIASES[team] || team;
  return matchNameVariants(team, canonical);
}

function teamAliasMap(teams, providerConfig = {}) {
  const byAlias = new Map();

  for (const team of teams) {
    for (const alias of teamMatchNames(team, providerConfig)) {
      byAlias.set(normalizeName(alias), team);
    }
  }

  return byAlias;
}

function teamMatchesAny(value, candidates) {
  return candidates.some((candidate) => teamNameMatches(value, candidate));
}

function matchHistoryKey(match) {
  return `${match.date}|${normalizeName(match.homeTeam)}|${normalizeName(match.awayTeam)}|${match.homeGoals}-${match.awayGoals}`;
}

function blend(base, overlay, overlayWeight) {
  return Number(base || 0) * (1 - overlayWeight) + Number(overlay || 0) * overlayWeight;
}
