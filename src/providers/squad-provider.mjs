import { readJson } from "../db.mjs";
import { clamp, makeId, normalizeName, round } from "../utils.mjs";
import {
  extractHtmlTables,
  fetchPublicText,
  htmlToLines,
  sourceDiagnostic,
  uniqueBy
} from "./public-source.mjs";

const ELITE_CLUBS = [
  "Arsenal", "Aston Villa", "Atletico Madrid", "Barcelona", "Bayern Munich",
  "Benfica", "Borussia Dortmund", "Chelsea", "Inter Milan", "Juventus",
  "Liverpool", "Manchester City", "Manchester United", "Milan", "Napoli",
  "Paris Saint-Germain", "Porto", "Real Madrid", "Roma", "Tottenham Hotspur"
];

const TOP_LEAGUE_SIGNALS = [
  "Premier League", "La Liga", "Bundesliga", "Serie A", "Ligue 1",
  "UEFA Champions League", "Europa League", "Eredivisie", "Primeira Liga",
  "Saudi Pro League", "Major League Soccer", "Liga MX", "Brasileirao",
  "Argentine Primera", "J1 League"
];

const KNOWN_CLUBS = [
  ...ELITE_CLUBS,
  "Ajax", "Al Ahly", "Al Hilal", "Al Ittihad", "Al Nassr", "Al Sadd",
  "Atalanta", "Athletic Bilbao", "Bayer Leverkusen", "Brighton", "Celtic",
  "Club America", "Crystal Palace", "Eintracht Frankfurt", "Fenerbahce",
  "Feyenoord", "Fiorentina", "Fulham", "Galatasaray", "Leeds United",
  "Leicester City", "Lille", "Lyon", "Marseille", "Monaco", "Monterrey",
  "Newcastle United", "Nottingham Forest", "Olympiacos", "PSV Eindhoven",
  "Rangers", "RB Leipzig", "Real Betis", "Real Sociedad", "River Plate",
  "Sevilla", "Sporting CP", "Villarreal", "West Ham United", "Wolverhampton Wanderers"
];

export async function fetchSquadDepth({ fixtures, providerConfig, now = new Date() }) {
  const result = await fetchSquadDepthWithDiagnostics({ fixtures, providerConfig, now });
  return result.records;
}

export async function fetchSquadDepthWithDiagnostics({ fixtures = [], providerConfig = {}, now = new Date() } = {}) {
  const mode = providerConfig?.mode || "self-gather";

  if (mode !== "self-gather") {
    throw new Error(`Unsupported squad depth provider mode: ${mode}. WorldCupMagik squad depth uses public web pages plus conservative local priors only.`);
  }

  const teams = uniqueTeams(fixtures);
  const [sources, baselineConfig] = await Promise.all([
    loadSources(providerConfig),
    readJson((providerConfig?.baselineFile || "config/squad-depth-profiles.json").split(/[\\/]/), {})
  ]);
  const publicSignalsByTeam = new Map();
  const diagnostics = [];

  for (const source of sources) {
    if (source.type === "team-template") {
      const limit = Math.min(teams.length, Number(providerConfig.maxTeamPages || source.maxTeamPages || teams.length));
      const selectedTeams = teams.slice(0, limit);
      const tasks = selectedTeams.map((team) => async () => {
        const teamSource = sourceForTeam(source, team);

        if (!teamSource?.url) {
          return {
            diagnostics: [sourceDiagnostic({
              kind: "squad_depth",
              source: { name: `${source.name}: ${team}`, url: "" },
              status: "empty",
              reason: "No public team-page URL could be resolved for this team.",
              now
            })],
            signals: []
          };
        }

        return fetchTeamSquadSignals({ team, source: teamSource, providerConfig, now });
      });
      const results = await mapLimit(tasks, Number(providerConfig.teamPageConcurrency || 4));

      for (const result of results) {
        diagnostics.push(...result.diagnostics);
        addPublicSignals(publicSignalsByTeam, result.signals);
      }

      if (limit < teams.length) {
        diagnostics.push(sourceDiagnostic({
          kind: "squad_depth",
          source,
          status: "empty",
          reason: `Team-page fetch limit reached at ${limit}; remaining teams used depth priors only.`,
          now
        }));
      }

      continue;
    }

    const result = await fetchSharedSquadSignals({ teams, source, providerConfig, now });
    diagnostics.push(...result.diagnostics);
    addPublicSignals(publicSignalsByTeam, result.signals);
  }

  const records = teams.map((team) => finalSquadDepthRecord({
    team,
    baselineConfig,
    publicSignals: publicSignalsByTeam.get(normalizeName(team)) || [],
    now
  }));

  return {
    records: uniqueBy(records, (record) => record.team),
    diagnostics
  };
}

async function fetchSharedSquadSignals({ teams, source, providerConfig, now }) {
  try {
    const html = await fetchPublicText(source.url, providerConfig);
    const signals = teams
      .map((team) => squadSignalsFromHtml({ team, html, source, teamSpecific: false, now }))
      .filter(Boolean);

    return {
      signals,
      diagnostics: [sourceDiagnostic({
        kind: "squad_depth",
        source,
        status: signals.length ? "ok" : "empty",
        records: signals.length,
        reason: signals.length ? "" : "Fetched shared squad page but found no usable team squad sections.",
        now
      })]
    };
  } catch (error) {
    return {
      signals: [],
      diagnostics: [sourceDiagnostic({
        kind: "squad_depth",
        source,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
        now
      })]
    };
  }
}

async function fetchTeamSquadSignals({ team, source, providerConfig, now }) {
  try {
    const html = await fetchPublicText(source.url, providerConfig);
    const signals = squadSignalsFromHtml({ team, html, source, teamSpecific: true, now });

    return {
      signals: signals ? [signals] : [],
      diagnostics: [sourceDiagnostic({
        kind: "squad_depth",
        source,
        status: signals ? "ok" : "empty",
        records: signals ? 1 : 0,
        reason: signals ? "" : "Fetched public team page but could not identify enough squad/player signals.",
        now
      })]
    };
  } catch (error) {
    return {
      signals: [],
      diagnostics: [sourceDiagnostic({
        kind: "squad_depth",
        source,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
        now
      })]
    };
  }
}

function squadSignalsFromHtml({ team, html, source, teamSpecific, now }) {
  const lines = htmlToLines(html);
  const tables = extractHtmlTables(html);
  const chunkLines = teamSpecific ? currentSquadChunk(lines) : sharedTeamChunk(lines, team);
  const tableText = relevantTableText(tables, teamSpecific ? "" : team);
  const text = `${chunkLines.join("\n")}\n${tableText}`.trim();

  if (!text) {
    return null;
  }

  const playerCount = estimatePlayerCount({ lines: chunkLines, tables, text });
  const eliteClubMentions = countSignals(text, ELITE_CLUBS);
  const topLeagueMentions = countSignals(text, TOP_LEAGUE_SIGNALS) + Math.min(12, eliteClubMentions);
  const clubDiversity = clubDiversityCount(text);
  const usableSignalCount = playerCount + eliteClubMentions + topLeagueMentions + clubDiversity;

  if (usableSignalCount < 3) {
    return null;
  }

  const depthScore = clamp(
    0.34
      + Math.min(playerCount, 26) * 0.005
      + Math.min(eliteClubMentions, 10) * 0.027
      + Math.min(topLeagueMentions, 14) * 0.012
      + Math.min(clubDiversity, 18) * 0.006,
    0.3,
    0.92
  );
  const confidence = clamp(
    Number(source.reliability || 0.55) * 0.46
      + Math.min(playerCount, 26) / 26 * 0.24
      + Math.min(eliteClubMentions + topLeagueMentions, 14) / 14 * 0.16
      + (teamSpecific ? 0.09 : 0.04),
    0.2,
    0.74
  );

  return {
    team,
    capturedAt: now.toISOString(),
    source: source.name,
    sourceUrl: source.url,
    sourceReliability: Number(source.reliability || 0.55),
    depthScore: round(depthScore, 4),
    confidence: round(confidence, 4),
    playerCount,
    eliteClubMentions,
    topLeagueMentions,
    clubDiversity,
    sourceType: "public-web"
  };
}

function finalSquadDepthRecord({ team, baselineConfig, publicSignals, now }) {
  const baseline = profileForTeam(baselineConfig, team);
  const publicSignal = selectBestPublicSignal(publicSignals);
  const publicWeight = publicSignal
    ? clamp(Number(publicSignal.confidence || 0) * 0.62, 0.12, 0.48)
    : 0;
  const baselineScore = Number(baseline.depthScore ?? baselineConfig.default?.depthScore ?? 0.5);
  const baselineConfidence = Number(baseline.confidence ?? baselineConfig.default?.confidence ?? 0.3);
  const blendedDepth = publicSignal
    ? baselineScore * (1 - publicWeight) + Number(publicSignal.depthScore || baselineScore) * publicWeight
    : baselineScore;
  const confidence = publicSignal
    ? clamp(baselineConfidence * 0.58 + Number(publicSignal.confidence || 0) * 0.42 + 0.06, 0.24, 0.82)
    : baselineConfidence;
  const sourceType = publicSignal ? "curated-plus-public" : "curated-profile";

  return {
    id: makeId("squad_depth", [team, sourceType, now.toISOString(), publicSignal?.sourceUrl || "baseline"]),
    capturedAt: now.toISOString(),
    provider: publicSignal ? "public-web" : "curated-profile",
    sourceType,
    source: publicSignal?.source || "Squad depth profile",
    sourceUrl: publicSignal?.sourceUrl || "",
    team,
    depthScore: round(clamp(blendedDepth, 0.25, 0.94), 4),
    confidence: round(clamp(confidence, 0.2, 0.84), 4),
    baselineDepth: round(baselineScore, 4),
    baselineConfidence: round(baselineConfidence, 4),
    publicDepth: publicSignal ? publicSignal.depthScore : null,
    publicConfidence: publicSignal ? publicSignal.confidence : null,
    playerCount: publicSignal?.playerCount || 0,
    eliteClubMentions: publicSignal?.eliteClubMentions || 0,
    topLeagueMentions: publicSignal?.topLeagueMentions || 0,
    clubDiversity: publicSignal?.clubDiversity || 0,
    notes: publicSignal
      ? `Public squad signals blended with depth prior: ${publicSignal.playerCount} player rows/signals, ${publicSignal.eliteClubMentions} elite-club mentions, ${publicSignal.clubDiversity} club-diversity signals.`
      : baseline.notes || baselineConfig.default?.notes || "Conservative squad depth prior."
  };
}

function currentSquadChunk(lines) {
  const start = lines.findIndex((line) => /current squad|recent call-ups|players|squad/i.test(line));

  if (start < 0) {
    return lines.slice(0, 380);
  }

  const end = lines.findIndex((line, index) => index > start + 12 && /coaching staff|records|competitive record|honours|results and fixtures|individual records/i.test(line));
  return lines.slice(start, end > start ? end : start + 180);
}

function sharedTeamChunk(lines, team) {
  const teamNorm = normalizeName(team);
  const start = lines.findIndex((line) => {
    const lineNorm = normalizeName(line);
    return lineNorm === teamNorm || lineNorm.startsWith(`${teamNorm} `) || lineNorm.endsWith(` ${teamNorm}`);
  });

  if (start < 0) {
    return [];
  }

  return lines.slice(start, start + 180);
}

function relevantTableText(tables, team) {
  const teamNorm = normalizeName(team);

  return tables
    .filter((rows) => {
      if (!teamNorm) {
        return true;
      }

      return rows.some((row) => normalizeName(row.join(" ")).includes(teamNorm));
    })
    .slice(0, 8)
    .flatMap((rows) => rows.slice(0, 32).map((row) => row.join(" | ")))
    .join("\n");
}

function estimatePlayerCount({ lines, tables, text }) {
  const tableRows = tables.flat().filter((row) => likelyPlayerText(row.join(" "))).length;
  const lineRows = lines.filter((line) => likelyPlayerText(line)).length;
  const squadNumberRows = [...String(text || "").matchAll(/\b(?:GK|DF|MF|FW|Goalkeeper|Defender|Midfielder|Forward)\b/gi)].length;

  return Math.min(26, Math.max(tableRows, lineRows, squadNumberRows));
}

function likelyPlayerText(value) {
  const text = String(value || "");

  return /\b(?:GK|DF|MF|FW|Goalkeeper|Defender|Midfielder|Forward)\b/i.test(text)
    && /[A-Z][a-z]{2,}/.test(text)
    && text.length < 220;
}

function countSignals(text, signals) {
  const source = normalizeName(text);

  return signals.reduce((total, signal) => {
    const needle = normalizeName(signal);
    if (!needle) {
      return total;
    }

    const pattern = new RegExp(`\\b${escapeRegExp(needle)}\\b`, "g");
    return total + ([...source.matchAll(pattern)].length || 0);
  }, 0);
}

function clubDiversityCount(text) {
  const source = normalizeName(text);
  const clubs = new Set();

  for (const club of KNOWN_CLUBS) {
    const needle = normalizeName(club);

    if (needle && source.includes(needle)) {
      clubs.add(needle);
    }
  }

  return clubs.size;
}

function selectBestPublicSignal(signals) {
  return [...signals].sort((left, right) => {
    const leftScore = Number(left.confidence || 0) + Number(left.depthScore || 0) * 0.12;
    const rightScore = Number(right.confidence || 0) + Number(right.depthScore || 0) * 0.12;
    return rightScore - leftScore;
  })[0] || null;
}

function profileForTeam(config, team) {
  const byTeam = normalizedObject(config.teams || {});
  return byTeam.get(normalizeName(team)) || config.default || { depthScore: 0.5, confidence: 0.3 };
}

function sourceForTeam(source, team) {
  const slug = slugForTeam(source, team);

  if (!slug) {
    return null;
  }

  return {
    ...source,
    name: `${source.name}: ${team}`,
    url: source.urlTemplate.replace("{teamSlug}", encodeURI(slug))
  };
}

function slugForTeam(source, team) {
  const slugMap = normalizedObject(source.teamSlugs || {});
  const configured = slugMap.get(normalizeName(team));

  if (configured) {
    return configured;
  }

  const words = normalizeName(team).split(/\s+/).filter(Boolean);
  return words.length ? `${words.map(titleWord).join("_")}_national_football_team` : "";
}

function titleWord(value) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : "";
}

function addPublicSignals(target, signals) {
  for (const signal of signals || []) {
    const key = normalizeName(signal.team);
    const bucket = target.get(key) || [];
    bucket.push(signal);
    target.set(key, bucket);
  }
}

function uniqueTeams(fixtures) {
  return [...new Set(fixtures.flatMap((fixture) => [fixture?.homeTeam, fixture?.awayTeam]).filter(Boolean))]
    .sort((left, right) => normalizeName(left).localeCompare(normalizeName(right)));
}

async function loadSources(providerConfig) {
  if (Array.isArray(providerConfig?.sources)) {
    return providerConfig.sources;
  }

  return readJson((providerConfig?.sourcesFile || "config/squad-sources.json").split(/[\\/]/), []);
}

function normalizedObject(value) {
  return new Map(Object.entries(value || {}).map(([key, item]) => [normalizeName(key), item]));
}

async function mapLimit(tasks, limit) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const current = index;
      index += 1;
      results[current] = await tasks[current]();
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(Number(limit) || 1, tasks.length || 1)) }, worker));
  return results;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
