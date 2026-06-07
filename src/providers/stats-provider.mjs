import { readJson } from "../db.mjs";
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

    teamMatches = uniqueBy(teamMatches, (match) => `${match.date}|${normalizeName(match.homeTeam)}|${normalizeName(match.awayTeam)}|${match.homeGoals}-${match.awayGoals}`)
      .sort((left, right) => new Date(right.date) - new Date(left.date))
      .slice(0, Number(providerConfig?.maxRecentMatches || 6));
    matchHistory.push(...teamMatches);
  }

  const dedupedMatchHistory = uniqueBy(matchHistory, (match) => `${match.date}|${normalizeName(match.homeTeam)}|${normalizeName(match.awayTeam)}|${match.homeGoals}-${match.awayGoals}`);

  return {
    records: teams.map((team) => deriveTeamStats(team, dedupedMatchHistory, now)),
    matchHistory: dedupedMatchHistory,
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

  if (!teamNameMatches(homeTeam, team) && !teamNameMatches(awayTeam, team)) {
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
    homePossession: 50 + possessionNudge(homeGoals, awayGoals),
    awayPossession: 50 - possessionNudge(homeGoals, awayGoals),
    competition: cleanCompetition(row[0]),
    source: source.name,
    sourceUrl: source.url,
    sourceType: "public-web"
  };
}

function deriveTeamStats(team, matchHistory, now) {
  const matches = matchHistory
    .filter((match) => new Date(match.date) < now)
    .filter((match) => teamNameMatches(match.homeTeam, team) || teamNameMatches(match.awayTeam, team))
    .sort((left, right) => new Date(right.date) - new Date(left.date))
    .slice(0, 3);

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

  const rows = matches.map((match) => {
    const isHome = teamNameMatches(match.homeTeam, team);
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
  const pointsPerGame = mean(rows.map((row) => row.points));
  const goalDiff = mean(rows.map((row) => row.goalsFor - row.goalsAgainst));
  const xgDiff = mean(rows.map((row) => row.xgFor - row.xgAgainst));
  const possession = mean(rows.map((row) => row.possession));
  const shotsFor = mean(rows.map((row) => row.shotsFor));
  const shotsAgainst = mean(rows.map((row) => row.shotsAgainst));

  return {
    team,
    updatedAt: now.toISOString(),
    provider: "public-web",
    recentPointsPerGame: round(pointsPerGame, 3),
    xgFor: round(mean(rows.map((row) => row.xgFor)), 3),
    xgAgainst: round(mean(rows.map((row) => row.xgAgainst)), 3),
    shotsFor: round(shotsFor, 2),
    shotsAgainst: round(shotsAgainst, 2),
    possession: round(possession, 1),
    highPressIndex: round(clamp(50 + (shotsFor - shotsAgainst) * 2.2 + possession * 0.18 - 9, 30, 78), 1),
    setPieceThreat: round(clamp(49 + mean(rows.map((row) => row.goalsFor)) * 5 + Math.max(0, shotsFor - 9) * 0.8, 30, 78), 1),
    transitionThreat: round(clamp(50 + goalDiff * 7 + Math.max(0, xgDiff) * 8, 30, 80), 1),
    keeperForm: round(clamp(52 - mean(rows.map((row) => row.goalsAgainst)) * 5 + Math.max(0, 11 - shotsAgainst) * 1.5, 30, 80), 1),
    rating: round(1650 + pointsPerGame * 48 + goalDiff * 34 + xgDiff * 25, 1),
    statsCompleteness: round(clamp(0.34 + matches.length * 0.18, 0, 0.82), 3),
    sourceMatchCount: matches.length,
    sourceReliability: 0.75,
    recentMatches: matches.map((match) => ({
      date: match.date,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      score: `${match.homeGoals}-${match.awayGoals}`,
      source: match.source
    }))
  };
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

function possessionNudge(homeGoals, awayGoals) {
  return clamp((Number(homeGoals) - Number(awayGoals)) * 2.5, -8, 8);
}
