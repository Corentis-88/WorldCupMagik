import { readJson } from "../db.mjs";
import { makeId, normalizeName } from "../utils.mjs";
import {
  escapeRegExp,
  fetchPublicText,
  htmlToLines,
  sourceDiagnostic,
  teamNameMatches,
  uniqueBy
} from "./public-source.mjs";

export async function fetchLineupSnapshotWithDiagnostics({ fixtures, providerConfig = {}, now = new Date() }) {
  const mode = providerConfig?.mode || "self-gather";

  if (mode !== "self-gather") {
    throw new Error(`Unsupported lineup provider mode: ${mode}. WorldCupMagik lineups use public web pages only.`);
  }

  const sources = await loadSources(providerConfig);
  const lineups = [];
  const diagnostics = [];

  for (const source of sources.filter((item) => item.enabled !== false)) {
    for (const fixture of fixtures) {
      const url = buildFixtureUrl(source, fixture) || fixture.sourceUrl;

      if (!url) {
        diagnostics.push(sourceDiagnostic({
          kind: "lineups",
          source,
          status: "empty",
          reason: `No public lineup URL available for ${fixture.homeTeam} v ${fixture.awayTeam}.`,
          now
        }));
        continue;
      }

      const fixtureSource = { ...source, url, name: `${source.name}: ${fixture.homeTeam} v ${fixture.awayTeam}` };

      try {
        const html = await fetchPublicText(url, providerConfig);
        const extracted = extractLineupsFromPage({
          html,
          fixture,
          source: fixtureSource,
          now
        });

        lineups.push(...extracted);
        diagnostics.push(sourceDiagnostic({
          kind: "lineups",
          source: fixtureSource,
          status: extracted.length ? "ok" : "empty",
          records: extracted.length,
          reason: extracted.length ? "" : "Fetched public match page but found no confirmed or predicted lineup block.",
          now
        }));
      } catch (error) {
        diagnostics.push(sourceDiagnostic({
          kind: "lineups",
          source: fixtureSource,
          status: "error",
          reason: error instanceof Error ? error.message : String(error),
          now
        }));
      }
    }
  }

  return {
    lineups: uniqueBy(lineups, (record) => `${record.fixtureId}|${record.sourceUrl}|${record.status}`),
    diagnostics
  };
}

export function extractLineupsFromPage({ html, fixture, source, now = new Date() }) {
  const lines = htmlToLines(html);
  const teams = {};

  for (const team of [fixture.homeTeam, fixture.awayTeam]) {
    const parsed = parseTeamLineup(lines, team);

    if (parsed) {
      teams[team] = parsed;
    }
  }

  const foundTeams = Object.keys(teams);

  if (!foundTeams.length) {
    return [];
  }

  const capturedAt = now.toISOString();
  const statuses = foundTeams.map((team) => teams[team].status);
  const status = statuses.every((item) => item === "confirmed")
    ? "confirmed"
    : statuses.some((item) => item === "confirmed")
      ? "partial_confirmed"
      : "predicted";

  return [{
    id: makeId("lineup", [fixture.id, source.url, status, capturedAt]),
    fixtureId: fixture.id,
    fixtureDate: fixture.date,
    fixtureDateKey: String(fixture.date || "").slice(0, 10),
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    capturedAt,
    provider: "public-web",
    source: source.name,
    sourceUrl: source.url,
    status,
    teams
  }];
}

async function loadSources(providerConfig) {
  if (Array.isArray(providerConfig?.sources)) {
    return providerConfig.sources;
  }

  return readJson((providerConfig?.sourcesFile || "config/lineup-sources.json").split(/[\\/]/), []);
}

function buildFixtureUrl(source, fixture) {
  if (!source.urlTemplate) {
    return "";
  }

  const homeSlug = normalizeName(fixture.homeTeam).replace(/\s+/g, "-");
  const awaySlug = normalizeName(fixture.awayTeam).replace(/\s+/g, "-");
  const dateKey = String(fixture.date || "").slice(0, 10);

  return source.urlTemplate
    .replace(/\{homeSlug\}/g, homeSlug)
    .replace(/\{awaySlug\}/g, awaySlug)
    .replace(/\{dateKey\}/g, dateKey)
    .replace(/\{home\}/g, encodeURIComponent(fixture.homeTeam))
    .replace(/\{away\}/g, encodeURIComponent(fixture.awayTeam));
}

function parseTeamLineup(lines, team) {
  const teamPattern = escapeRegExp(team);
  const pattern = new RegExp(`\\b${teamPattern}\\s+(confirmed|predicted)\\s+lineup\\s*(?:\\(([^)]+)\\))?\\s*:\\s*(.+)$`, "i");

  for (const line of lines) {
    const match = line.match(pattern);

    if (!match) {
      continue;
    }

    const starters = parsePlayerList(match[3]);

    if (starters.length >= 7) {
      return {
        status: match[1].toLowerCase(),
        formation: cleanFormation(match[2]),
        starters,
        normalizedStarters: starters.map(normalizeName),
        sourceText: line
      };
    }
  }

  return parseCompactTeamLineup(lines, team);
}

function parseCompactTeamLineup(lines, team) {
  const headingPattern = new RegExp(`\\b${escapeRegExp(team)}\\s+(confirmed|predicted)\\s+lineup\\b\\s*([^\\n]*)`, "i");

  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(headingPattern);

    if (!heading) {
      continue;
    }

    const windowText = lines.slice(index + 1, index + 18).join(", ");
    const starters = parsePlayerList(windowText);

    if (starters.length >= 7) {
      return {
        status: heading[1].toLowerCase(),
        formation: cleanFormation(heading[2]),
        starters: starters.slice(0, 11),
        normalizedStarters: starters.slice(0, 11).map(normalizeName),
        sourceText: [lines[index], ...lines.slice(index + 1, index + 18)].join(" ")
      };
    }
  }

  return null;
}

function parsePlayerList(value) {
  return String(value || "")
    .split(/[,;]\s*/)
    .map(cleanPlayerName)
    .filter(Boolean)
    .filter((item, index, items) => items.findIndex((other) => normalizeName(other) === normalizeName(item)) === index)
    .slice(0, 18);
}

function cleanPlayerName(value) {
  const cleaned = String(value || "")
    .replace(/\([^)]*\b(?:GK|G|Goalkeeper|Sub|Captain|C)\b[^)]*\)/gi, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:confirmed|predicted|lineup|formation|substitutes?|bench|manager|coach)\b/gi, " ")
    .replace(/\d+-\d+(?:-\d+)*/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^A-Za-z\u00C0-\u017F]+|[^A-Za-z\u00C0-\u017F]+$/g, "")
    .trim();

  if (!cleaned || cleaned.length < 3 || cleaned.length > 48) {
    return "";
  }

  if (/^(?:GK|DF|MF|FW|CM|CB|LB|RB|LW|RW|ST)$/i.test(cleaned)) {
    return "";
  }

  return cleaned;
}

function cleanFormation(value) {
  const match = String(value || "").match(/\b\d-\d(?:-\d){0,3}\b/);
  return match?.[0] || "";
}

export function lineupPlayerMatches(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);

  if (!a || !b) {
    return false;
  }

  if (a === b || a.endsWith(` ${b}`) || b.endsWith(` ${a}`)) {
    return true;
  }

  const aTokens = a.split(/\s+/).filter(Boolean);
  const bTokens = b.split(/\s+/).filter(Boolean);
  const aSurname = aTokens.at(-1);
  const bSurname = bTokens.at(-1);

  return Boolean(aSurname && bSurname && aSurname.length > 3 && aSurname === bSurname);
}

export function lineupTeamMatches(left, right) {
  return teamNameMatches(left, right);
}
