import { clamp, makeId, mean, normalizeName, round } from "../utils.mjs";
import {
  cleanTeamName,
  decodeEntities,
  extractHtmlTables,
  fetchPublicText,
  htmlToLines,
  parseDate,
  sourceDiagnostic,
  stripTags,
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
  const profilesByTeam = new Map();
  const supplementalPlayerStats = [];

  for (const team of teams) {
    const sources = teamSources(team, aliases, providerConfig);
    let teamMatches = [];

    for (const source of sources) {
      try {
        const html = await fetchPublicText(source.url, providerConfig);
        const extracted = extractTeamMatches({ html, team, source, now });
        teamMatches.push(...extracted.matches);
        supplementalPlayerStats.push(...extracted.playerStats);
        diagnostics.push(sourceDiagnostic({
          kind: "stats",
          source,
          status: extracted.matches.length ? "ok" : "empty",
          records: extracted.matches.length,
          reason: extracted.matches.length ? "" : `Fetched public team page but found no completed result rows for ${team}.`,
          now
        }));

        if (teamMatches.length >= Number(providerConfig?.targetRecentMatches || 3)) {
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

    for (const source of supplementalPlayerSources(team, aliases, providerConfig)) {
      try {
        const html = await fetchPublicText(source.url, providerConfig);
        const extracted = extractSupplementalPlayerStats({ html, team, source, now });
        supplementalPlayerStats.push(...extracted);
        diagnostics.push(sourceDiagnostic({
          kind: "player_stats",
          source,
          status: extracted.length ? "ok" : "empty",
          records: extracted.length,
          reason: extracted.length ? "" : `Fetched public player-stat page but found no usable player rows for ${team}.`,
          now
        }));
      } catch (error) {
        diagnostics.push(sourceDiagnostic({
          kind: "player_stats",
          source,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
          now
        }));
      }
    }

    teamMatches = uniqueBy(teamMatches.filter(isSaneMatchRecord), matchHistoryKey)
      .sort((left, right) => new Date(right.date) - new Date(left.date))
      .slice(0, Number(providerConfig?.maxRecentMatches || 20));
    matchHistory.push(...teamMatches);
    const profile = await fetchTeamProfile({ team, aliases, providerConfig, now, diagnostics });
    profilesByTeam.set(team, profile);
  }

  const dedupedMatchHistory = uniqueBy(matchHistory.filter(isSaneMatchRecord), matchHistoryKey);
  const supplementalScorers = aggregateSupplementalPlayerStats(supplementalPlayerStats, teams, dedupedMatchHistory, now, providerConfig);
  const scorerByTeam = new Map();

  for (const scorer of supplementalScorers) {
    const bucket = scorerByTeam.get(normalizeName(scorer.team)) || [];
    bucket.push(scorer);
    scorerByTeam.set(normalizeName(scorer.team), bucket);
  }

  const records = teams
    .map((team) => deriveTeamStats(team, dedupedMatchHistory, now, providerConfig, profilesByTeam.get(team)))
    .map((record) => enrichTeamStatsWithSupplementalScorers(record, scorerByTeam.get(normalizeName(record.team)) || []));
  const playerStats = mergePlayerStats(derivePlayerStats(teams, dedupedMatchHistory, now, providerConfig), supplementalScorers);

  return {
    records,
    matchHistory: dedupedMatchHistory,
    playerStats,
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

  const sources = sourceTemplates.map((template, index) => ({
    name: `${team} public results ${index + 1}`,
    url: template.replace("{slug}", slug),
    matchNames: matchNameVariants(team, canonical),
    reliability: index === 0 ? 0.78 : 0.7
  }));

  const nftSources = providerConfig?.nationalFootballTeams?.[team]?.urls || [];

  for (const [index, url] of nftSources.entries()) {
    sources.push({
      name: `${team} National Football Teams ${index + 1}`,
      url,
      matchNames: matchNameVariants(team, canonical),
      reliability: 0.66,
      parser: "national-football-teams"
    });
  }

  return sources;
}

function supplementalPlayerSources(team, aliases, providerConfig) {
  const config = providerConfig?.playerStatSources;

  if (config?.enabled === false) {
    return [];
  }

  const templates = Array.isArray(config?.templates) ? config.templates : [];
  const canonical = aliases[team] || team;
  const teamSlug = playerStatsTeamSlug(canonical);

  return templates
    .filter((template) => template?.enabled !== false && template.urlTemplate)
    .map((template, index) => ({
      name: `${team} ${template.name || `player stat source ${index + 1}`}`,
      url: String(template.urlTemplate)
        .replace(/\{teamSlug\}/g, teamSlug)
        .replace(/\{team\}/g, encodeURIComponent(team)),
      matchNames: matchNameVariants(team, canonical),
      reliability: Number(template.reliability || 0.5),
      parser: template.parser || "playerstats-football",
      statType: template.statType || "goals_assists"
    }));
}

function playerStatsTeamSlug(value) {
  return normalizeName(value)
    .replace(/\bmen s\b/g, "")
    .replace(/\bmens\b/g, "")
    .replace(/\bunited states\b/g, "usa")
    .replace(/\bczech republic\b/g, "czechia")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fetchTeamProfile({ team, aliases, providerConfig, now, diagnostics }) {
  const sources = teamProfileSources(team, aliases, providerConfig);

  for (const source of sources) {
    try {
      const html = await fetchPublicText(source.url, providerConfig);
      const profile = extractTeamProfile({ html, team, source, now });
      diagnostics.push(sourceDiagnostic({
        kind: "team_profile",
        source,
        status: profile.manager || profile.nickname ? "ok" : "empty",
        records: profile.manager || profile.nickname ? 1 : 0,
        reason: profile.manager || profile.nickname ? "" : `Fetched public team page but found no manager/profile fields for ${team}.`,
        now
      }));

      if (profile.manager || profile.nickname) {
        return profile;
      }
    } catch (error) {
      diagnostics.push(sourceDiagnostic({
        kind: "team_profile",
        source,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
        now
      }));
    }
  }

  return neutralTeamProfile(team, now);
}

function teamProfileSources(team, aliases, providerConfig) {
  const sourceTemplates = providerConfig?.profileSourceTemplates || [
    "https://en.wikipedia.org/wiki/{slug}_national_football_team",
    "https://en.wikipedia.org/wiki/{slug}_national_soccer_team",
    "https://en.wikipedia.org/wiki/{slug}_men%27s_national_soccer_team"
  ];
  const canonical = aliases[team] || team;
  const slug = encodeURIComponent(canonical.replace(/\s+/g, "_"));

  return sourceTemplates.map((template, index) => ({
    name: `${team} public profile ${index + 1}`,
    url: template.replace("{slug}", slug),
    reliability: index === 0 ? 0.72 : 0.64
  }));
}

function extractTeamProfile({ html, team, source, now }) {
  const manager = extractInfoboxField(html, ["Head coach", "Coach", "Manager"]);
  const nickname = extractInfoboxField(html, ["Nickname(s)", "Nickname"]);
  const captain = extractInfoboxField(html, ["Captain"]);

  return {
    team,
    updatedAt: now.toISOString(),
    manager: manager || "",
    captain: captain || "",
    nickname: nickname || "",
    source: source.name,
    sourceUrl: source.url,
    sourceType: "public-web",
    profileConfidence: manager ? source.reliability : 0.25
  };
}

function extractInfoboxField(html, labels) {
  for (const label of labels) {
    const pattern = new RegExp(`<tr[^>]*>\\s*<th[^>]*>\\s*${escapeRegExp(label)}\\s*<\\/th>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>\\s*<\\/tr>`, "i");
    const match = html.match(pattern);

    if (match) {
      return cleanProfileText(match[1]);
    }
  }

  return "";
}

function cleanProfileText(value) {
  return cleanCell(String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<sup[\s\S]*?<\/sup>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " "));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function neutralTeamProfile(team, now) {
  return {
    team,
    updatedAt: now.toISOString(),
    manager: "",
    captain: "",
    nickname: "",
    source: "public profile unavailable",
    sourceUrl: "",
    sourceType: "public-web",
    profileConfidence: 0.2
  };
}

function extractTeamMatches({ html, team, source, now }) {
  const tables = extractHtmlTables(html);
  const matches = [];
  const playerStats = [];

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

  for (const table of extractHtmlTablesPreservingEmptyCells(html)) {
    matches.push(...extractIndexedTeamResults({ table, team, source, now }));
  }

  matches.push(...extractFootballBoxResults({ html, team, source, now }));
  matches.push(...extractNationalFootballTeamsResults({ tables, team, source, now }));
  playerStats.push(...extractNationalFootballTeamsPlayerStats({ tables, team, source, now }));

  return {
    matches,
    playerStats
  };
}

function extractSupplementalPlayerStats({ html, team, source, now }) {
  if (source.parser === "playerstats-football" || /playerstats\.football/i.test(source.url || "")) {
    return extractPlayerStatsFootballStats({ html, team, source, now });
  }

  if (source.parser === "statbunker-player-stats" || /statbunker/i.test(source.url || "")) {
    return extractStatBunkerPlayerStats({ html, team, source, now });
  }

  return [];
}

function extractPlayerStatsFootballStats({ html, team, source, now }) {
  const records = [
    ...extractPlayerStatTables({ html, team, source, now }),
    ...extractPlayerStatsFootballSummary({ html, team, source, now })
  ];

  return uniqueBy(records, (record) => `${normalizeName(record.team)}|${normalizeName(record.playerName)}|${record.source}|${record.statType || ""}`);
}

function extractPlayerStatTables({ html, team, source, now }) {
  const records = [];

  for (const table of extractHtmlTables(html)) {
    const headerIndex = table.findIndex((row) => row.some((cell) => /players?|name/i.test(cell)));

    if (headerIndex < 0) {
      continue;
    }

    const headers = table[headerIndex].map(normalizeHeaderCell);
    const playerIndex = headers.findIndex((cell) => /players?|name/.test(cell));
    const positionIndex = headers.findIndex((cell) => /position|pos/.test(cell));
    const startIndex = headers.findIndex((cell) => /^start|starts/.test(cell));
    const goalsIndex = headers.findIndex((cell) => /^g$|goals?/.test(cell));
    const assistsIndex = headers.findIndex((cell) => /^a$|assists?/.test(cell));
    const shotsIndex = headers.findIndex((cell) => /shots?$|total shots|sh$/.test(cell));
    const shotsOnTargetIndex = headers.findIndex((cell) => /sot|shots on target/.test(cell));

    if (playerIndex < 0) {
      continue;
    }

    for (const row of table.slice(headerIndex + 1)) {
      const playerName = cleanNationalFootballTeamsPlayerName(row[playerIndex]);

      if (!playerName) {
        continue;
      }

      const goals = numberCell(row[goalsIndex]);
      const assists = numberCell(row[assistsIndex]);
      const starts = numberCell(row[startIndex]);
      const shots = numberCell(row[shotsIndex]);
      const shotsOnTarget = numberCell(row[shotsOnTargetIndex]);

      if (![goals, assists, starts, shots, shotsOnTarget].some((value) => Number(value || 0) > 0)) {
        continue;
      }

      records.push(playerStatRecord({
        team,
        playerName,
        now,
        source,
        statType: source.statType,
        goals,
        assists,
        starts,
        shots,
        shotsOnTarget,
        position: row[positionIndex] || ""
      }));
    }
  }

  return records;
}

function extractStatBunkerPlayerStats({ html, team, source, now }) {
  return extractPlayerStatTables({ html, team, source, now });
}

function extractPlayerStatsFootballSummary({ html, team, source, now }) {
  const lines = htmlToLines(html);
  const text = lines.join(" ");
  const records = [];
  const assistSummary = text.match(/([A-ZÀ-Ý][A-Za-zÀ-ÿ'. -]+(?:\s*,\s*[A-ZÀ-Ý][A-Za-zÀ-ÿ'. -]+)*)\s+recorded\s+the\s+most\s+assists?\s+with\s+(\d+)\s+each/i);

  if (assistSummary) {
    const assists = Number(assistSummary[2]);

    for (const name of assistSummary[1].split(/\s*,\s*|\s+\band\b\s+/i)) {
      const playerName = cleanPlayerStatsSummaryName(name);

      if (playerName && assists > 0) {
        records.push(playerStatRecord({
          team,
          playerName,
          now,
          source,
          statType: source.statType,
          assists,
          assistMatches: 1,
          supplementalMatchSample: 1,
          scorerSource: `${source.name}; public assists summary`
        }));
      }
    }
  }

  return records;
}

function playerStatRecord({ team, playerName, now, source, statType = "", goals = 0, assists = 0, assistMatches = 0, starts = 0, shots = 0, shotsOnTarget = 0, position = "", supplementalMatchSample = 0, scorerSource = "" }) {
  const role = playerRoleProfile(position);

  return {
    id: makeId("player_stat", [team, playerName, source.url, statType]),
    team,
    playerName,
    updatedAt: now.toISOString(),
    provider: "public-web",
    sourceType: "public-web",
    goals: Number(goals || 0),
    assists: Number(assists || 0),
    assistMatches: Number(assistMatches || (Number(assists || 0) > 0 ? 1 : 0)),
    shots: Number(shots || 0),
    shotsOnTarget: Number(shotsOnTarget || 0),
    seasonAppearances: Number(starts || 0),
    starts: Number(starts || 0),
    matchesSampled: Number(supplementalMatchSample || 0),
    scoringMatches: Number(goals || 0) > 0 ? 1 : 0,
    position: cleanCell(position),
    attackingRole: role.attackingRole,
    creativeRoleScore: role.creativeRoleScore,
    scoringRoleScore: role.scoringRoleScore,
    statType,
    scorerSource: scorerSource || source.name,
    assistSource: source.name,
    source: source.name,
    sourceUrl: source.url
  };
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

  return buildEstimatedMatchRecord({
    date,
    homeTeam,
    awayTeam,
    homeGoals,
    awayGoals,
    homeScorers: extractScorersFromRow(row, scoreIndex, "home"),
    awayScorers: extractScorersFromRow(row, scoreIndex, "away"),
    competition: cleanCompetition(row[0]),
    source,
    now
  });
}

function extractHtmlTablesPreservingEmptyCells(html) {
  const tables = [];
  const tableBlocks = [...String(html || "").matchAll(/<table\b[\s\S]*?<\/table>/gi)];

  for (const tableBlock of tableBlocks) {
    const rows = [];
    const rowBlocks = [...tableBlock[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)];

    for (const rowBlock of rowBlocks) {
      const cells = [...rowBlock[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((cell) => cleanCell(stripTags(cell[1])));

      if (cells.some(Boolean)) {
        rows.push(cells);
      }
    }

    if (rows.length) {
      tables.push(rows);
    }
  }

  return tables;
}

function extractIndexedTeamResults({ table, team, source, now }) {
  const headerIndex = table.findIndex((row) => {
    const normalized = row.map(normalizeHeaderCell);
    return normalized.some((cell) => cell === "date")
      && normalized.some((cell) => /opponents?/.test(cell))
      && normalized.some((cell) => cell === "score" || cell === "result");
  });

  if (headerIndex < 0) {
    return [];
  }

  const headers = table[headerIndex].map(normalizeHeaderCell);
  const indexes = {
    date: headers.findIndex((cell) => cell === "date"),
    venue: headers.findIndex((cell) => /venue|stadium/.test(cell)),
    opponent: headers.findIndex((cell) => /opponents?/.test(cell)),
    score: headers.findIndex((cell) => cell === "score" || cell === "result"),
    competition: headers.findIndex((cell) => /competition|tournament/.test(cell)),
    teamScorers: headers.findIndex((cell) => /scorers?/.test(cell) && !/opposition|opponents?/.test(cell)),
    oppositionScorers: headers.findIndex((cell) => /opposition scorers?|opponents? scorers?/.test(cell))
  };

  if (indexes.date < 0 || indexes.opponent < 0 || indexes.score < 0) {
    return [];
  }

  return table
    .slice(headerIndex + 1)
    .map((row) => parseIndexedTeamResultRow({ row, team, source, now, indexes }))
    .filter(Boolean);
}

function parseIndexedTeamResultRow({ row, team, source, now, indexes }) {
  const date = parseDate(row[indexes.date], now.getFullYear());
  const score = String(row[indexes.score] || "").match(/(\d+)\s*[\u2010-\u2015-]\s*(\d+)/);
  const opponent = cleanTeamName(row[indexes.opponent]);

  if (!date || new Date(date) >= now || !score || !opponent) {
    return null;
  }

  const teamGoals = Number(score[1]);
  const opponentGoals = Number(score[2]);
  const venueText = String(row[indexes.venue] || "");
  const teamAway = /\(\s*A\s*\)|\baway\b/i.test(venueText);
  const teamScorers = extractScorersFromScorerCell(row[indexes.teamScorers] || "", teamGoals);
  const oppositionScorers = extractScorersFromScorerCell(row[indexes.oppositionScorers] || "", opponentGoals);

  return buildEstimatedMatchRecord({
    date,
    homeTeam: teamAway ? opponent : team,
    awayTeam: teamAway ? team : opponent,
    homeGoals: teamAway ? opponentGoals : teamGoals,
    awayGoals: teamAway ? teamGoals : opponentGoals,
    homeScorers: teamAway ? oppositionScorers : teamScorers,
    awayScorers: teamAway ? teamScorers : oppositionScorers,
    competition: cleanCompetition(row[indexes.competition] || ""),
    source,
    now
  });
}

function normalizeHeaderCell(value) {
  return normalizeName(value);
}

function extractFootballBoxResults({ html, team, source, now }) {
  const starts = [...String(html || "").matchAll(/<div\b[^>]*class=["'][^"']*\bfootballbox\b[^"']*["'][^>]*>/gi)]
    .map((match) => match.index)
    .filter((index) => Number.isInteger(index));
  const matches = [];

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = starts[index + 1] || html.length;
    const block = html.slice(start, Math.min(end, start + 12000));
    const parsed = parseFootballBoxResult({ block, team, source, now });

    if (parsed) {
      matches.push(parsed);
    }
  }

  return matches;
}

function parseFootballBoxResult({ block, team, source, now }) {
  const datetime = block.match(/<time\b[^>]*datetime=["']([^"']+)["']/i)?.[1];
  const dateText = extractClassText(block, "fdate");
  const date = datetime ? new Date(datetime) : parseDate(dateText, now.getFullYear());
  const homeTeam = cleanTeamName(extractClassText(block, "fhome"));
  const awayTeam = cleanTeamName(extractClassText(block, "faway"));
  const scoreText = extractClassText(block, "fscore");
  const score = scoreText.match(/(\d+)\s*[\u2010-\u2015-]\s*(\d+)/);
  const matchNames = source.matchNames || [team];

  if (
    !date
    || Number.isNaN(new Date(date).getTime())
    || new Date(date) >= now
    || !homeTeam
    || !awayTeam
    || !score
    || (!teamMatchesAny(homeTeam, matchNames) && !teamMatchesAny(awayTeam, matchNames))
  ) {
    return null;
  }

  return buildEstimatedMatchRecord({
    date: new Date(date),
    homeTeam,
    awayTeam,
    homeGoals: Number(score[1]),
    awayGoals: Number(score[2]),
    homeScorers: extractScorersFromText(extractClassText(block, "fhgoal")),
    awayScorers: extractScorersFromText(extractClassText(block, "fagoal")),
    competition: cleanCompetition(extractNearbyCompetition(block)),
    source,
    now
  });
}

function extractClassText(html, className) {
  const pattern = new RegExp(`<[^>]*class=["'][^"']*\\b${escapeRegExp(className)}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:td|th|div)>`, "i");
  const match = String(html || "").match(pattern);

  return match ? cleanCell(stripTags(match[1]).replace(/\bGoal\b/gi, " ")) : "";
}

function extractNearbyCompetition(block) {
  const links = [...String(block || "").matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((match) => cleanCell(stripTags(match[1])))
    .filter((text) => /world cup|qualification|qualifier|cup|championship|nations|friendly|copa|gold cup|asian cup|afcon|concacaf/i.test(text));

  return links[0] || "";
}

function extractNationalFootballTeamsResults({ tables, team, source, now }) {
  if (source.parser !== "national-football-teams" && !/national-football-teams\.com/i.test(source.url || "")) {
    return [];
  }

  const matches = [];

  for (const table of tables) {
    const headerIndex = table.findIndex((row) => {
      const headers = row.map(normalizeHeaderCell);
      return headers.includes("date")
        && headers.includes("home team")
        && headers.includes("away team")
        && headers.includes("result");
    });

    if (headerIndex < 0) {
      continue;
    }

    const headers = table[headerIndex].map(normalizeHeaderCell);
    const indexes = {
      date: headers.indexOf("date"),
      home: headers.indexOf("home team"),
      away: headers.indexOf("away team"),
      result: headers.indexOf("result"),
      event: headers.indexOf("event")
    };

    for (const row of table.slice(headerIndex + 1)) {
      const parsed = parseNationalFootballTeamsResultRow({ row, team, source, now, indexes });

      if (parsed) {
        matches.push(parsed);
      }
    }
  }

  return matches;
}

function parseNationalFootballTeamsResultRow({ row, team, source, now, indexes }) {
  const date = parseDate(row[indexes.date], now.getFullYear());
  const homeTeam = cleanTeamName(row[indexes.home]);
  const awayTeam = cleanTeamName(row[indexes.away]);
  const score = String(row[indexes.result] || "").match(/(\d+)\s*:\s*(\d+)/);
  const matchNames = source.matchNames || [team];

  if (
    !date
    || new Date(date) >= now
    || !homeTeam
    || !awayTeam
    || !score
    || (!teamMatchesAny(homeTeam, matchNames) && !teamMatchesAny(awayTeam, matchNames))
  ) {
    return null;
  }

  return buildEstimatedMatchRecord({
    date,
    homeTeam,
    awayTeam,
    homeGoals: Number(score[1]),
    awayGoals: Number(score[2]),
    competition: cleanCompetition(row[indexes.event] || ""),
    source,
    now
  });
}

function extractNationalFootballTeamsPlayerStats({ tables, team, source, now }) {
  if (source.parser !== "national-football-teams" && !/national-football-teams\.com/i.test(source.url || "")) {
    return [];
  }

  const records = [];

  for (const table of tables) {
    const headerIndex = table.findIndex((row) => {
      const headers = row.map(normalizeHeaderCell);
      return headers.includes("name")
        && headers.includes("position")
        && headers.includes("current club")
        && headers.filter((cell) => cell === "g").length >= 1;
    });

    if (headerIndex < 0) {
      continue;
    }

    for (const row of table.slice(headerIndex + 1)) {
      const playerName = cleanNationalFootballTeamsPlayerName(row[0]);
      const goals = Number(row[6] || 0);
      const appearances = Number(row[4] || 0);
      const position = row[2] || "";
      const role = playerRoleProfile(position);

      if (!playerName || appearances <= 0) {
        continue;
      }

      records.push({
        id: makeId("player_stat", [team, playerName, source.url]),
        team,
        playerName,
        updatedAt: now.toISOString(),
        provider: "public-web",
        sourceType: "public-web",
        goals,
        seasonAppearances: appearances,
        starts: appearances,
        matchesSampled: 0,
        scoringMatches: 0,
        assists: 0,
        assistMatches: 0,
        position: cleanCell(position),
        attackingRole: role.attackingRole,
        creativeRoleScore: role.creativeRoleScore,
        scoringRoleScore: role.scoringRoleScore,
        scorerSource: source.name,
        source: source.name,
        sourceUrl: source.url
      });
    }
  }

  return records;
}

function cleanNationalFootballTeamsPlayerName(value) {
  const text = cleanCell(value);
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);

  if (parts.length >= 2) {
    return `${parts.slice(1).join(" ")} ${parts[0]}`.replace(/\s+/g, " ").trim();
  }

  return text;
}

function cleanPlayerStatsSummaryName(value) {
  return cleanCell(value)
    .replace(/\b(?:recorded|most|assists?|with|each|and)\b/gi, " ")
    .replace(/^[^A-Za-zÀ-ÿ]+|[^A-Za-zÀ-ÿ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function numberCell(value) {
  if (value == null) {
    return 0;
  }

  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function playerRoleProfile(position = "") {
  const text = normalizeName(position);

  if (!text) {
    return { attackingRole: "unknown", creativeRoleScore: 0.36, scoringRoleScore: 0.34 };
  }

  if (/goalkeeper|\bgk\b/.test(text)) {
    return { attackingRole: "goalkeeper", creativeRoleScore: 0.03, scoringRoleScore: 0.02 };
  }

  if (/wing|wide|attacking midfielder|\bam\b|\bcam\b|\blam\b|\bram\b|\blw\b|\brw\b/.test(text)) {
    return { attackingRole: "creator", creativeRoleScore: 0.82, scoringRoleScore: 0.58 };
  }

  if (/forward|striker|\bst\b|\bcf\b/.test(text)) {
    return { attackingRole: "forward", creativeRoleScore: 0.48, scoringRoleScore: 0.78 };
  }

  if (/midfielder|\bcm\b|\bdm\b|\blcm\b|\brcm\b|\blm\b|\brm\b/.test(text)) {
    return { attackingRole: "midfielder", creativeRoleScore: 0.62, scoringRoleScore: 0.42 };
  }

  if (/back|defender|\bcb\b|\blb\b|\brb\b|\bdf\b/.test(text)) {
    return { attackingRole: "defender", creativeRoleScore: 0.24, scoringRoleScore: 0.16 };
  }

  return { attackingRole: "unknown", creativeRoleScore: 0.36, scoringRoleScore: 0.34 };
}

function buildEstimatedMatchRecord({ date, homeTeam, awayTeam, homeGoals, awayGoals, homeScorers = [], awayScorers = [], competition = "", source, now }) {
  if (!isSaneGoalCount(homeGoals) || !isSaneGoalCount(awayGoals)) {
    return null;
  }

  const homePossession = 50 + possessionNudge(homeGoals, awayGoals);
  const awayPossession = 50 - possessionNudge(homeGoals, awayGoals);
  const homeShots = estimateShots(homeGoals);
  const awayShots = estimateShots(awayGoals);
  const homePassCompletion = estimatePassCompletion(homePossession, homeShots);
  const awayPassCompletion = estimatePassCompletion(awayPossession, awayShots);
  const homePassesAttempted = estimatePassesAttempted({ goalsFor: homeGoals, goalsAgainst: awayGoals, possession: homePossession, shots: homeShots });
  const awayPassesAttempted = estimatePassesAttempted({ goalsFor: awayGoals, goalsAgainst: homeGoals, possession: awayPossession, shots: awayShots });

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
    homeShots,
    awayShots,
    homeShotsOnTarget: estimateShotsOnTarget(homeGoals),
    awayShotsOnTarget: estimateShotsOnTarget(awayGoals),
    homePossession,
    awayPossession,
    homePassesAttempted,
    awayPassesAttempted,
    homeCompletedPasses: Math.round(homePassesAttempted * homePassCompletion),
    awayCompletedPasses: Math.round(awayPassesAttempted * awayPassCompletion),
    homePassCompletion,
    awayPassCompletion,
    homeScorers,
    awayScorers,
    competition,
    metricSource: "score-derived-estimates",
    capturedMetricFields: ["date", "homeTeam", "awayTeam", "homeGoals", "awayGoals"],
    derivedMetricFields: ["xg", "shots", "shotsOnTarget", "possession", "passes", "completedPasses"],
    source: source.name,
    sourceUrl: source.url,
    sourceType: "public-web"
  };
}

function isSaneGoalCount(value) {
  const goals = Number(value);
  return Number.isInteger(goals) && goals >= 0 && goals <= 15;
}

function isSaneMatchRecord(match = {}) {
  return isSaneGoalCount(match.homeGoals)
    && isSaneGoalCount(match.awayGoals)
    && isSaneEventValue(match.homeXg, 0, 6)
    && isSaneEventValue(match.awayXg, 0, 6)
    && isSaneEventValue(match.homeShots, 0, 40)
    && isSaneEventValue(match.awayShots, 0, 40)
    && isSaneEventValue(match.homeShotsOnTarget, 0, 18)
    && isSaneEventValue(match.awayShotsOnTarget, 0, 18);
}

function isSaneEventValue(value, min, max) {
  const number = Number(value);
  return !Number.isFinite(number) || (number >= min && number <= max);
}

function deriveTeamStats(team, matchHistory, now, providerConfig = {}, profile = null) {
  const maxMatches = Number(providerConfig?.maxRecentMatches || 20);
  const shortWindowSize = Number(providerConfig?.formWindows?.short || 6);
  const longWindowSize = Number(providerConfig?.formWindows?.long || maxMatches);
  const matchNames = teamMatchNames(team, providerConfig);
  const matches = matchHistory
    .filter(isSaneMatchRecord)
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
      passesAttempted: 420,
      completedPasses: 342,
      passCompletion: 0.815,
      highPressIndex: 50,
      setPieceThreat: 50,
      transitionThreat: 50,
      keeperForm: 50,
      rating: 1650,
      statsCompleteness: 0.22,
      sourceMatchCount: 0,
      sourceReliability: 0,
      manager: profile?.manager || "",
      captain: profile?.captain || "",
      tacticalProfile: inferTacticalProfile({
        possession: 50,
        shotsFor: 10,
        shotsAgainst: 10,
        xgFor: 1.25,
        xgAgainst: 1.25,
        highPressIndex: 50,
        setPieceThreat: 50,
        transitionThreat: 50,
        passCompletion: 0.815
      }),
      topScorers: [],
      intelligenceCoverage: intelligenceCoverage({ matchCount: 0, maxMatches, profile })
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
  const passesAttempted = blend(shortForm.passesAttempted, longForm.passesAttempted, 0.36);
  const completedPasses = blend(shortForm.completedPasses, longForm.completedPasses, 0.36);
  const passCompletion = completedPasses / Math.max(1, passesAttempted);
  const goalDiff = blend(shortForm.goalDifference, longForm.goalDifference, 0.5);
  const xgDiff = xgFor - xgAgainst;
  const formTrend = clamp((shortForm.pointsPerGame - priorForm.pointsPerGame) / 3 + (shortForm.xgDifference - priorForm.xgDifference) * 0.12, -0.55, 0.55);
  const scorerSummary = summarizeTeamScorers(matches, matchNames);
  const tacticalProfile = inferTacticalProfile({
    possession,
    shotsFor,
    shotsAgainst,
    xgFor,
    xgAgainst,
    highPressIndex: clamp(50 + (shotsFor - shotsAgainst) * 2.2 + possession * 0.18 - 9, 30, 78),
    setPieceThreat: clamp(49 + longForm.goalsFor * 4 + Math.max(0, shotsFor - 9) * 0.8, 30, 78),
    transitionThreat: clamp(50 + goalDiff * 7 + Math.max(0, xgDiff) * 8, 30, 80),
    passCompletion
  });

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
    passesAttempted: round(passesAttempted, 1),
    completedPasses: round(completedPasses, 1),
    passCompletion: round(passCompletion, 3),
    highPressIndex: round(clamp(50 + (shotsFor - shotsAgainst) * 2.2 + possession * 0.18 - 9, 30, 78), 1),
    setPieceThreat: round(clamp(49 + longForm.goalsFor * 4 + Math.max(0, shotsFor - 9) * 0.8, 30, 78), 1),
    transitionThreat: round(clamp(50 + goalDiff * 7 + Math.max(0, xgDiff) * 8, 30, 80), 1),
    keeperForm: round(clamp(52 - longForm.goalsAgainst * 4.5 + Math.max(0, 11 - shotsAgainst) * 1.5, 30, 80), 1),
    rating: round(1650 + pointsPerGame * 34 + goalDiff * 24 + xgDiff * 18 + formTrend * 28, 1),
    statsCompleteness: round(clamp(0.32 + matches.length * 0.035, 0, 0.92), 3),
    sourceMatchCount: matches.length,
    sourceMatchTarget: maxMatches,
    sourceReliability: 0.75,
    manager: profile?.manager || "",
    captain: profile?.captain || "",
    profileSource: profile?.source || "",
    profileSourceUrl: profile?.sourceUrl || "",
    profileConfidence: round(Number(profile?.profileConfidence || 0.2), 3),
    metricSource: "score-derived-estimates",
    capturedMetricFields: ["date", "homeTeam", "awayTeam", "homeGoals", "awayGoals"],
    derivedMetricFields: ["xgFor", "xgAgainst", "shotsFor", "shotsAgainst", "shotsOnTargetFor", "shotsOnTargetAgainst", "possession", "passesAttempted", "completedPasses", "passCompletion", "formation", "styleOfPlay"],
    tacticalProfile,
    passing: {
      attempted: round(passesAttempted, 1),
      completed: round(completedPasses, 1),
      completion: round(passCompletion, 3),
      source: "score-and-possession-derived estimate"
    },
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
    topScorers: scorerSummary,
    intelligenceCoverage: intelligenceCoverage({ matchCount: matches.length, maxMatches, profile }),
    recentMatches: matches.map((match) => ({
      date: match.date,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      score: `${match.homeGoals}-${match.awayGoals}`,
      teamPerspective: teamMatchesAny(match.homeTeam, matchNames) ? "home" : "away",
      shotsFor: teamMatchesAny(match.homeTeam, matchNames) ? match.homeShots : match.awayShots,
      shotsOnTargetFor: teamMatchesAny(match.homeTeam, matchNames) ? match.homeShotsOnTarget : match.awayShotsOnTarget,
      possession: teamMatchesAny(match.homeTeam, matchNames) ? match.homePossession : match.awayPossession,
      passesAttempted: teamMatchesAny(match.homeTeam, matchNames) ? match.homePassesAttempted : match.awayPassesAttempted,
      completedPasses: teamMatchesAny(match.homeTeam, matchNames) ? match.homeCompletedPasses : match.awayCompletedPasses,
      passCompletion: teamMatchesAny(match.homeTeam, matchNames) ? match.homePassCompletion : match.awayPassCompletion,
      homeScorers: match.homeScorers || [],
      awayScorers: match.awayScorers || [],
      metricSource: match.metricSource,
      source: match.source
    }))
  };
}

function teamMatchRow(match, matchNames) {
  const isHome = teamMatchesAny(match.homeTeam, matchNames);
  const goalsFor = Number(isHome ? match.homeGoals : match.awayGoals);
  const goalsAgainst = Number(isHome ? match.awayGoals : match.homeGoals);
  const points = goalsFor > goalsAgainst ? 3 : goalsFor === goalsAgainst ? 1 : 0;
  const possession = Number(isHome ? match.homePossession : match.awayPossession) || 50;
  const shotsFor = Number(isHome ? match.homeShots : match.awayShots) || estimateShots(goalsFor);
  const shotsAgainst = Number(isHome ? match.awayShots : match.homeShots) || estimateShots(goalsAgainst);
  const passCompletion = Number(isHome ? match.homePassCompletion : match.awayPassCompletion)
    || estimatePassCompletion(possession, shotsFor);
  const passesAttempted = Number(isHome ? match.homePassesAttempted : match.awayPassesAttempted)
    || estimatePassesAttempted({ goalsFor, goalsAgainst, possession, shots: shotsFor });

  return {
    points,
    goalsFor,
    goalsAgainst,
    xgFor: Number(isHome ? match.homeXg : match.awayXg),
    xgAgainst: Number(isHome ? match.awayXg : match.homeXg),
    shotsFor,
    shotsAgainst,
    shotsOnTargetFor: Number(isHome ? match.homeShotsOnTarget : match.awayShotsOnTarget),
    shotsOnTargetAgainst: Number(isHome ? match.awayShotsOnTarget : match.homeShotsOnTarget),
    possession,
    passesAttempted,
    completedPasses: Number(isHome ? match.homeCompletedPasses : match.awayCompletedPasses) || Math.round(passesAttempted * passCompletion),
    passCompletion
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
    possession: 50,
    passesAttempted: 420,
    completedPasses: 342,
    passCompletion: 0.815
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
    passesAttempted: round(mean(safeRows.map((row) => row.passesAttempted)), 1),
    completedPasses: round(mean(safeRows.map((row) => row.completedPasses)), 1),
    passCompletion: round(mean(safeRows.map((row) => row.passCompletion)), 3),
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

      const record = byPlayer.get(key) || { playerName: scorer.name, goals: 0, assists: 0, appearancesSampled: 0 };
      record.goals += Number(scorer.goals || 1);
      byPlayer.set(key, record);

      for (const assistName of scorer.assists || []) {
        const assistKey = normalizeName(assistName);

        if (!assistKey) {
          continue;
        }

        const assistRecord = byPlayer.get(assistKey) || { playerName: assistName, goals: 0, assists: 0, appearancesSampled: 0 };
        assistRecord.assists += Number(scorer.goals || 1);
        byPlayer.set(assistKey, assistRecord);
      }
    }
  }

  return [...byPlayer.values()]
    .filter((record) => Number(record.goals || 0) > 0)
    .sort((left, right) => right.goals - left.goals || normalizeName(left.playerName).localeCompare(normalizeName(right.playerName)))
    .slice(0, 8)
    .map((record) => ({
      playerName: record.playerName,
      goals: record.goals,
      assists: record.assists,
      goalsPerTwentyTeamMatches: round(record.goals / Math.max(1, matches.length) * 20, 3),
      assistsPerTwentyTeamMatches: round(Number(record.assists || 0) / Math.max(1, matches.length) * 20, 3)
    }));
}

function derivePlayerStats(teams, matchHistory, now, providerConfig = {}) {
  const teamByAlias = teamAliasMap(teams, providerConfig);
  const teamMatchCounts = teamSampleCounts(teams, matchHistory, now, providerConfig);
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
          assists: 0,
          matchesSampled: 0,
          scoringMatches: 0,
          assistMatches: 0,
          shots: 0,
          shotsOnTarget: 0,
          starts: 0,
          seasonAppearances: 0,
          position: "",
          attackingRole: "unknown",
          creativeRoleScore: 0.36,
          scoringRoleScore: 0.34,
          scorerSource: "public result rows"
        };
        record.goals += Number(scorer.goals || 1);
        record.scoringMatches += 1;
        record.matchesSampled = teamMatchCounts.get(normalizeName(team)) || record.matchesSampled || 1;
        byPlayer.set(key, record);

        for (const assistName of scorer.assists || []) {
          const assistKey = `${normalizeName(team)}|${normalizeName(assistName)}`;

          if (!normalizeName(assistName)) {
            continue;
          }

          const assistRecord = byPlayer.get(assistKey) || {
            id: makeId("player_stat", [team, assistName]),
            team,
            playerName: assistName,
            updatedAt: now.toISOString(),
            provider: "public-web",
            sourceType: "public-web",
            goals: 0,
            assists: 0,
            matchesSampled: 0,
            scoringMatches: 0,
            assistMatches: 0,
            shots: 0,
            shotsOnTarget: 0,
            starts: 0,
            seasonAppearances: 0,
            position: "",
            attackingRole: "unknown",
            creativeRoleScore: 0.36,
            scoringRoleScore: 0.34,
            scorerSource: "public result rows",
            assistSource: "public result rows"
          };
          assistRecord.assists += Number(scorer.goals || 1);
          assistRecord.assistMatches += 1;
          assistRecord.matchesSampled = teamMatchCounts.get(normalizeName(team)) || assistRecord.matchesSampled || 1;
          byPlayer.set(assistKey, assistRecord);
        }
      }
    }
  }

  return [...byPlayer.values()]
    .map(finalizePlayerStatRecord)
    .sort((left, right) => right.goals - left.goals || normalizeName(left.playerName).localeCompare(normalizeName(right.playerName)));
}

function aggregateSupplementalPlayerStats(records, teams, matchHistory, now, providerConfig = {}) {
  const teamCounts = teamSampleCounts(teams, matchHistory, now, providerConfig);
  const byPlayer = new Map();

  for (const record of records) {
    const key = `${normalizeName(record.team)}|${normalizeName(record.playerName)}`;
    const existing = byPlayer.get(key) || {
      ...record,
      goals: 0,
      assists: 0,
      assistMatches: 0,
      shots: 0,
      shotsOnTarget: 0,
      starts: 0,
      seasonAppearances: 0,
      sourceUrls: []
    };
    existing.goals += Number(record.goals || 0);
    existing.assists += Number(record.assists || 0);
    existing.assistMatches += Number(record.assistMatches || 0);
    existing.shots += Number(record.shots || 0);
    existing.shotsOnTarget += Number(record.shotsOnTarget || 0);
    existing.starts += Number(record.starts || 0);
    existing.seasonAppearances += Number(record.seasonAppearances || 0);
    existing.position ||= record.position || "";
    existing.attackingRole = strongerRole(existing.attackingRole, record.attackingRole);
    existing.creativeRoleScore = Math.max(Number(existing.creativeRoleScore || 0), Number(record.creativeRoleScore || 0));
    existing.scoringRoleScore = Math.max(Number(existing.scoringRoleScore || 0), Number(record.scoringRoleScore || 0));
    existing.assistSource ||= record.assistSource || record.source || "";
    existing.sourceUrls.push(record.sourceUrl);
    existing.updatedAt = now.toISOString();
    byPlayer.set(key, existing);
  }

  return [...byPlayer.values()]
    .map((record) => {
      const matchesSampled = teamCounts.get(normalizeName(record.team)) || record.matchesSampled || 1;

      return finalizePlayerStatRecord({
        ...record,
        id: makeId("player_stat", [record.team, record.playerName, record.sourceUrls.join("|")]),
        matchesSampled,
        scoringMatches: record.scoringMatches || 0,
        scorerSource: `${record.scorerSource}; yearly player goal table`,
        sourceUrl: record.sourceUrls.filter(Boolean).at(0) || record.sourceUrl || ""
      });
    })
    .sort((left, right) => right.goals - left.goals || normalizeName(left.playerName).localeCompare(normalizeName(right.playerName)));
}

function mergePlayerStats(primaryStats, supplementalStats) {
  const byPlayer = new Map();

  for (const record of primaryStats) {
    byPlayer.set(`${normalizeName(record.team)}|${normalizeName(record.playerName)}`, record);
  }

  for (const record of supplementalStats) {
    const key = `${normalizeName(record.team)}|${normalizeName(record.playerName)}`;
    const existing = byPlayer.get(key);

    byPlayer.set(key, existing ? mergePlayerStatRecord(existing, record) : finalizePlayerStatRecord(record));
  }

  return [...byPlayer.values()]
    .map(finalizePlayerStatRecord)
    .sort((left, right) => Number(right.goals || 0) - Number(left.goals || 0) || Number(right.assists || 0) - Number(left.assists || 0) || normalizeName(left.playerName).localeCompare(normalizeName(right.playerName)));
}

function mergePlayerStatRecord(left, right) {
  const matchesSampled = Math.max(Number(left.matchesSampled || 0), Number(right.matchesSampled || 0));
  const goals = Math.max(Number(left.goals || 0), Number(right.goals || 0));
  const assists = Math.max(Number(left.assists || 0), Number(right.assists || 0));
  const sourceUrls = [
    ...(Array.isArray(left.sourceUrls) ? left.sourceUrls : [left.sourceUrl]),
    ...(Array.isArray(right.sourceUrls) ? right.sourceUrls : [right.sourceUrl])
  ].filter(Boolean);

  return finalizePlayerStatRecord({
    ...left,
    ...right,
    id: makeId("player_stat", [left.team || right.team, left.playerName || right.playerName, sourceUrls.join("|")]),
    goals,
    assists,
    assistMatches: Math.max(Number(left.assistMatches || 0), Number(right.assistMatches || 0)),
    shots: Math.max(Number(left.shots || 0), Number(right.shots || 0)),
    shotsOnTarget: Math.max(Number(left.shotsOnTarget || 0), Number(right.shotsOnTarget || 0)),
    starts: Math.max(Number(left.starts || 0), Number(right.starts || 0)),
    seasonAppearances: Math.max(Number(left.seasonAppearances || 0), Number(right.seasonAppearances || 0)),
    scoringMatches: Math.max(Number(left.scoringMatches || 0), Number(right.scoringMatches || 0)),
    matchesSampled,
    position: left.position || right.position || "",
    attackingRole: strongerRole(left.attackingRole, right.attackingRole),
    creativeRoleScore: Math.max(Number(left.creativeRoleScore || 0), Number(right.creativeRoleScore || 0)),
    scoringRoleScore: Math.max(Number(left.scoringRoleScore || 0), Number(right.scoringRoleScore || 0)),
    scorerSource: [left.scorerSource, right.scorerSource].filter(Boolean).join("; "),
    assistSource: [left.assistSource, right.assistSource].filter(Boolean).join("; "),
    sourceUrls,
    sourceUrl: sourceUrls[0] || left.sourceUrl || right.sourceUrl || ""
  });
}

function finalizePlayerStatRecord(record) {
  const matchesSampled = Math.max(1, Number(record.matchesSampled || 0));
  const goals = Number(record.goals || 0);
  const assists = Number(record.assists || 0);
  const role = playerRoleProfile(record.position || record.attackingRole || "");
  const creativeRoleScore = Math.max(Number(record.creativeRoleScore || 0), Number(role.creativeRoleScore || 0));
  const scoringRoleScore = Math.max(Number(record.scoringRoleScore || 0), Number(role.scoringRoleScore || 0));
  const appearanceConfidence = clamp(Math.max(Number(record.seasonAppearances || 0), Number(record.starts || 0)) / 12, 0, 0.16);

  return {
    ...record,
    goals,
    assists,
    assistMatches: Number(record.assistMatches || (assists > 0 ? 1 : 0)),
    shots: Number(record.shots || 0),
    shotsOnTarget: Number(record.shotsOnTarget || 0),
    starts: Number(record.starts || 0),
    seasonAppearances: Number(record.seasonAppearances || 0),
    matchesSampled,
    attackingRole: record.attackingRole || role.attackingRole,
    creativeRoleScore: round(creativeRoleScore, 3),
    scoringRoleScore: round(scoringRoleScore, 3),
    goalsPerMatchSample: round(goals / matchesSampled, 3),
    goalsPerTwentyTeamMatches: round(goals / matchesSampled * 20, 3),
    assistsPerMatchSample: round(assists / matchesSampled, 3),
    assistsPerTwentyTeamMatches: round(assists / matchesSampled * 20, 3),
    goalInvolvementsPerTwentyTeamMatches: round((goals + assists) / matchesSampled * 20, 3),
    scorerConfidence: round(clamp(0.24 + Math.min(20, matchesSampled) * 0.032 + appearanceConfidence + Math.min(10, goals) * 0.012, 0.28, 0.78), 3),
    assistConfidence: round(clamp(0.2 + Math.min(20, matchesSampled) * 0.028 + appearanceConfidence + Math.min(10, assists) * 0.014 + creativeRoleScore * 0.08, 0.24, 0.76), 3),
    playerDataCoverage: round(clamp(matchesSampled / 20 * 0.6 + Math.max(Number(record.seasonAppearances || 0), Number(record.starts || 0)) / 12 * 0.2 + (goals + assists > 0 ? 0.14 : 0) + (record.position ? 0.06 : 0), 0.12, 0.92), 3)
  };
}

function strongerRole(left, right) {
  const scores = {
    creator: 5,
    forward: 4,
    midfielder: 3,
    defender: 2,
    goalkeeper: 1,
    unknown: 0
  };
  const leftValue = left || "unknown";
  const rightValue = right || "unknown";
  return (scores[rightValue] || 0) > (scores[leftValue] || 0) ? rightValue : leftValue;
}

function enrichTeamStatsWithSupplementalScorers(record, supplementalScorers = []) {
  if (record.topScorers?.length || !supplementalScorers.length) {
    return record;
  }

  const topScorers = supplementalScorers
    .filter((scorer) => Number(scorer.goals || 0) > 0)
    .slice(0, 8)
    .map((scorer) => ({
      playerName: scorer.playerName,
      goals: scorer.goals,
      assists: scorer.assists,
      scoringMatches: scorer.scoringMatches,
      goalsPerTwentyTeamMatches: scorer.goalsPerTwentyTeamMatches,
      assistsPerTwentyTeamMatches: scorer.assistsPerTwentyTeamMatches,
      scorerConfidence: scorer.scorerConfidence,
      source: scorer.scorerSource
    }));

  return {
    ...record,
    scorerSummary: topScorers,
    topScorers,
    intelligenceCoverage: {
      ...(record.intelligenceCoverage || {}),
      topScorerCount: topScorers.length
    }
  };
}

function teamSampleCounts(teams, matchHistory, now, providerConfig = {}) {
  const counts = new Map();

  for (const team of teams) {
    const matchNames = teamMatchNames(team, providerConfig);
    const matches = matchHistory
      .filter((match) => new Date(match.date) < now)
      .filter((match) => teamMatchesAny(match.homeTeam, matchNames) || teamMatchesAny(match.awayTeam, matchNames))
      .sort((left, right) => new Date(right.date) - new Date(left.date))
      .slice(0, Number(providerConfig?.maxRecentMatches || 20));
    counts.set(normalizeName(team), matches.length);
  }

  return counts;
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

function estimatePassesAttempted({ goalsFor, goalsAgainst, possession, shots }) {
  const gameState = Number(goalsFor || 0) - Number(goalsAgainst || 0);
  return Math.round(clamp(250 + Number(possession || 50) * 6.6 + Number(shots || 10) * 5.2 - Math.max(0, gameState) * 18, 230, 690));
}

function estimatePassCompletion(possession, shots) {
  return round(clamp(0.77 + (Number(possession || 50) - 50) * 0.004 - Math.max(0, Number(shots || 10) - 15) * 0.004, 0.68, 0.91), 3);
}

function possessionNudge(homeGoals, awayGoals) {
  return clamp((Number(homeGoals) - Number(awayGoals)) * 2.5, -8, 8);
}

function inferTacticalProfile({ possession, shotsFor, shotsAgainst, xgFor, xgAgainst, highPressIndex, setPieceThreat, transitionThreat, passCompletion }) {
  const control = Number(possession || 50);
  const press = Number(highPressIndex || 50);
  const transition = Number(transitionThreat || 50);
  const setPiece = Number(setPieceThreat || 50);
  const chanceVolume = Number(shotsFor || 10) - Number(shotsAgainst || 10);
  const goalBalance = Number(xgFor || 1.25) - Number(xgAgainst || 1.25);
  let formation = "4-2-3-1 / 4-3-3";
  let styleOfPlay = "balanced mid-block with mixed build-up";
  const styleTags = [];

  if (control >= 57 && Number(passCompletion || 0.8) >= 0.82) {
    formation = "4-3-3 / 4-2-3-1";
    styleOfPlay = "possession-led build-up with high territory";
    styleTags.push("possession", "territory", "patient build-up");
  } else if (transition >= 58 && control <= 51) {
    formation = "4-4-2 / 4-2-3-1";
    styleOfPlay = "direct transition and counter-attacking";
    styleTags.push("transition", "direct", "counter");
  } else if (press >= 58 && chanceVolume >= 1) {
    formation = "4-3-3 / 4-2-3-1";
    styleOfPlay = "front-foot pressing and fast regains";
    styleTags.push("pressing", "front-foot", "regains");
  } else if (Number(xgAgainst || 1.25) <= 1.05 && control < 52) {
    formation = "5-4-1 / 4-4-2";
    styleOfPlay = "compact defensive block with selective counters";
    styleTags.push("compact", "defensive", "counter");
  } else {
    styleTags.push("balanced", "mixed build-up");
  }

  if (setPiece >= 58) {
    styleTags.push("set-piece threat");
  }

  if (goalBalance >= 0.35) {
    styleTags.push("positive xG balance");
  }

  return {
    likelyFormation: formation,
    styleOfPlay,
    styleTags: [...new Set(styleTags)].slice(0, 6),
    possessionTier: control >= 57 ? "high" : control <= 47 ? "low" : "medium",
    pressingTier: press >= 58 ? "high" : press <= 45 ? "low" : "medium",
    transitionTier: transition >= 58 ? "high" : transition <= 45 ? "low" : "medium",
    source: "derived from 20-match public result sample and score-derived event estimates"
  };
}

function intelligenceCoverage({ matchCount, maxMatches, profile }) {
  return {
    matchWindowTarget: maxMatches,
    matchWindowAvailable: matchCount,
    hasFullTwentyMatchWindow: matchCount >= maxMatches,
    managerKnown: Boolean(profile?.manager),
    profileConfidence: round(Number(profile?.profileConfidence || 0.2), 3),
    eventDataMode: "score-derived-estimates",
    equalSchemaForAllTeams: true
  };
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

  const byName = new Map();
  const goalPattern = /([A-ZÀ-Ý][A-Za-zÀ-ÿ'.-]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'.-]+){0,3})\s*(?:\d{1,3}\s*(?:'|′|min)|pen\.?|og\b)(?:\s*\(([^)]*)\))?/g;

  for (const match of text.matchAll(goalPattern)) {
    const name = cleanScorerName(match[1]);

    if (!name || normalizeName(name).length < 3 || normalizeName(name) === "co" || /stadium|attendance|referee|friendly|qualification|league|cup/i.test(name)) {
      continue;
    }

    const key = normalizeName(name);
    const existing = byName.get(key) || { name, goals: 0, assists: [] };
    existing.goals += 1;
    existing.assists.push(...extractAssistNamesFromText(match[2] || ""));
    byName.set(key, existing);
  }

  return [...byName.values()].map((record) => ({
    ...record,
    assists: uniqueNames(record.assists)
  }));
}

function extractScorersFromScorerCell(value, goalsFor = 0) {
  const timed = extractScorersFromText(value);

  if (timed.length) {
    return timed;
  }

  const text = cleanCell(value)
    .replace(/[–—-]/g, " ")
    .replace(/\bnone\b/gi, " ")
    .trim();

  if (!text || /^0$/.test(text) || Number(goalsFor || 0) <= 0) {
    return [];
  }

  const byName = new Map();

  for (const part of text.split(/\s*,\s*|\s*;\s*/)) {
    if (!part || /\bo\.?\s*g\b|own goal/i.test(part)) {
      continue;
    }

    const goals = Number(part.match(/\((\d+)\)/)?.[1] || 1);
    const assists = extractAssistNamesFromText(part);
    const name = cleanScorerName(part
      .replace(/\([^)]*\)/g, " ")
      .replace(/\d+/g, " "));
    const key = normalizeName(name);

    if (!key || key.length < 3) {
      continue;
    }

    const existing = byName.get(key) || { name, goals: 0, assists: [] };
    existing.goals += goals;
    existing.assists.push(...assists);
    byName.set(key, existing);
  }

  return [...byName.values()].map((record) => ({
    ...record,
    assists: uniqueNames(record.assists)
  }));
}

function cleanScorerName(value) {
  return cleanCell(value)
    .replace(/\([^)]*(?:assist|assisted by)[^)]*\)/gi, " ")
    .replace(/\b(?:pen|og|own goal|goal|scorer|scorers|assist|assisted by)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAssistNamesFromText(value) {
  const text = cleanCell(value);
  const names = [];
  const patterns = [
    /(?:assist(?:ed)?\s+by|assist)\s*[:\-]?\s*([A-ZÀ-Ý][A-Za-zÀ-ÿ'.-]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'.-]+){0,3})/gi,
    /([A-ZÀ-Ý][A-Za-zÀ-ÿ'.-]+(?:\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ'.-]+){0,3})\s+assist(?:ed)?/gi
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = cleanScorerName(match[1]);

      if (name && normalizeName(name).length >= 3) {
        names.push(name);
      }
    }
  }

  return uniqueNames(names);
}

function uniqueNames(names = []) {
  const byName = new Map();

  for (const name of names.filter(Boolean)) {
    byName.set(normalizeName(name), name);
  }

  return [...byName.values()];
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
