import { readJson } from "../db.mjs";
import { makeId, normalizeName } from "../utils.mjs";
import {
  escapeRegExp,
  extractJsonLd,
  fetchPublicText,
  htmlToText,
  sourceDiagnostic,
  teamNameMatches,
  toDecimalOdds,
  uniqueBy
} from "./public-source.mjs";

export async function fetchOddsSnapshot({ fixtures, providerConfig, now = new Date() }) {
  const result = await fetchOddsSnapshotWithDiagnostics({ fixtures, providerConfig, now });
  return result.records;
}

export async function fetchOddsSnapshotWithDiagnostics({ fixtures, providerConfig, now = new Date() }) {
  const mode = providerConfig?.mode || "self-gather";

  if (mode !== "self-gather") {
    throw new Error(`Unsupported odds provider mode: ${mode}. WorldCupMagik odds use public bookmaker/comparison pages only.`);
  }

  const sources = await loadSources(providerConfig);
  const records = [];
  const diagnostics = [];

  for (const source of sources.filter((item) => item.enabled !== false)) {
    if (source.fixtureUrlFromFixtures) {
      for (const fixture of fixtures) {
        const url = buildFixtureUrl(source, fixture) || fixture.sourceUrl;

        if (!url) {
          diagnostics.push(sourceDiagnostic({
            kind: "odds",
            source,
            status: "empty",
            reason: `No public match URL available for ${fixture.homeTeam} v ${fixture.awayTeam}.`,
            now
          }));
          continue;
        }

        const fixtureSource = { ...source, url, name: `${source.name}: ${fixture.homeTeam} v ${fixture.awayTeam}` };

        try {
          const html = await fetchPublicText(url, providerConfig);
          const extracted = extractOddsFromPage({
            html,
            fixtures: [fixture],
            source: fixtureSource,
            now,
            providerConfig
          });

          records.push(...extracted);
          diagnostics.push(sourceDiagnostic({
            kind: "odds",
            source: fixtureSource,
            status: extracted.length ? "ok" : "empty",
            records: extracted.length,
            reason: extracted.length ? "" : "Fetched public match page but found no supported odds offers.",
            now
          }));
        } catch (error) {
          diagnostics.push(sourceDiagnostic({
            kind: "odds",
            source: fixtureSource,
            status: "error",
            reason: error instanceof Error ? error.message : String(error),
            now
          }));
        }
      }
      continue;
    }

    try {
      const url = source.url;
      const html = await fetchPublicText(url, providerConfig);
      const extracted = extractOddsFromPage({
        html,
        fixtures,
        source,
        now,
        providerConfig
      });

      records.push(...extracted);
      diagnostics.push(sourceDiagnostic({
        kind: "odds",
        source,
        status: extracted.length ? "ok" : "empty",
        records: extracted.length,
        reason: extracted.length ? "" : "Fetched public page but found no fixture-market odds near the selected teams.",
        now
      }));
    } catch (error) {
      diagnostics.push(sourceDiagnostic({
        kind: "odds",
        source,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
        now
      }));
    }
  }

  return {
    records: uniqueBy(records, (record) => `${record.capturedAt}|${record.bookmaker}|${record.fixtureId}|${record.market}|${record.outcome}`),
    diagnostics
  };
}

async function loadSources(providerConfig) {
  if (Array.isArray(providerConfig?.sources)) {
    return providerConfig.sources;
  }

  return readJson((providerConfig?.sourcesFile || "config/odds-sources.json").split(/[\\/]/), []);
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

function extractOddsFromPage({ html, fixtures, source, now }) {
  const jsonLdRecords = extractJsonLdOdds({ html, fixtures, source, now });

  if (jsonLdRecords.length) {
    return jsonLdRecords;
  }

  const text = htmlToText(html);
  const records = [];

  for (const fixture of fixtures) {
    const blocks = fixtureBlocks(text, fixture, source);

    for (const block of blocks) {
      records.push(...extractFixtureOdds({ block, fixture, source, now }));
    }
  }

  return records;
}

function extractJsonLdOdds({ html, fixtures, source, now }) {
  const records = [];
  const capturedAt = now.toISOString();

  for (const item of extractJsonLd(html)) {
    const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];

    if (!types.some((type) => /SportsEvent/i.test(String(type || "")))) {
      continue;
    }

    const fixture = matchFixtureFromJsonLd(fixtures, item);

    if (!fixture || !Array.isArray(item.offers)) {
      continue;
    }

    for (const offer of item.offers) {
      const mapped = mapJsonLdOffer(offer, fixture, item);
      const price = Number(offer.price);

      if (!mapped || !Number.isFinite(price) || price <= 1) {
        continue;
      }

      records.push(toOddsRecord({
        fixture,
        source,
        bookmaker: offer.offeredBy?.name || source.bookmaker || source.name,
        capturedAt,
        market: mapped.market,
        outcome: mapped.outcome,
        playerName: mapped.playerName,
        playerTeam: mapped.playerTeam,
        decimalOdds: price
      }));
    }
  }

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}`);
}

function matchFixtureFromJsonLd(fixtures, item) {
  const homeTeam = teamValue(item.homeTeam);
  const awayTeam = teamValue(item.awayTeam);

  return fixtures.find((fixture) => {
    if (homeTeam && awayTeam) {
      return teamNameMatches(fixture.homeTeam, homeTeam) && teamNameMatches(fixture.awayTeam, awayTeam);
    }

    return teamNameMatches(item.name, fixture.homeTeam) && teamNameMatches(item.name, fixture.awayTeam);
  }) || null;
}

function mapJsonLdOffer(offer, fixture, event) {
  const name = String(offer.name || "");
  const scorer = parseScorerOffer(name);
  const prefix = normalizeName(name.split(/[—-]/)[0]);
  const homeNames = [fixture.homeTeam, event.homeTeam?.alternateName, event.homeTeam?.name].filter(Boolean).map(normalizeName);
  const awayNames = [fixture.awayTeam, event.awayTeam?.alternateName, event.awayTeam?.name].filter(Boolean).map(normalizeName);

  if (scorer) {
    return { market: scorer.market, outcome: scorer.playerName, playerName: scorer.playerName, playerTeam: scorer.playerTeam };
  }

  const doubleChance = parseDoubleChanceOffer(name, fixture);

  if (doubleChance) {
    return doubleChance;
  }

  if (prefix === "draw") {
    return { market: "match_winner", outcome: "Draw" };
  }

  if (homeNames.some((team) => team && (prefix === team || team.includes(prefix) || prefix.includes(team)))) {
    return { market: "match_winner", outcome: fixture.homeTeam };
  }

  if (awayNames.some((team) => team && (prefix === team || team.includes(prefix) || prefix.includes(team)))) {
    return { market: "match_winner", outcome: fixture.awayTeam };
  }

  if (/over\s*1\.?5/i.test(name)) {
    return { market: "over_1_5_goals", outcome: "Over" };
  }

  if (/over\s*2\.?5/i.test(name)) {
    return { market: "over_2_5_goals", outcome: "Over" };
  }

  if (/under\s*2\.?5/i.test(name)) {
    return { market: "under_2_5_goals", outcome: "Under" };
  }

  if (/under\s*3\.?5/i.test(name)) {
    return { market: "under_3_5_goals", outcome: "Under" };
  }

  if (/under\s*4\.?5/i.test(name)) {
    return { market: "under_4_5_goals", outcome: "Under" };
  }

  if (/^yes\b/i.test(name)) {
    return { market: "both_teams_to_score", outcome: "Yes" };
  }

  if (/^no\b/i.test(name)) {
    return { market: "both_teams_to_score", outcome: "No" };
  }

  return null;
}

function teamValue(value) {
  if (!value) {
    return "";
  }

  return typeof value === "string" ? value : value.name || value.alternateName || "";
}

function fixtureBlocks(text, fixture, source = {}) {
  const normalized = normalizeName(text);
  const home = normalizeName(fixture.homeTeam);
  const away = normalizeName(fixture.awayTeam);
  const blocks = [];
  const raw = String(text || "");

  if (source.fullPageFixtureBlock && normalized.includes(home) && normalized.includes(away)) {
    blocks.push(raw.slice(0, Number(source.maxFixtureBlockChars || 45000)));
  }

  const patterns = [
    new RegExp(`${escapeRegExp(fixture.homeTeam)}[\\s\\S]{0,1200}${escapeRegExp(fixture.awayTeam)}`, "gi"),
    new RegExp(`${escapeRegExp(fixture.awayTeam)}[\\s\\S]{0,1200}${escapeRegExp(fixture.homeTeam)}`, "gi")
  ];

  for (const pattern of patterns) {
    for (const match of raw.matchAll(pattern)) {
      const start = Math.max(0, match.index - 500);
      const end = Math.min(raw.length, match.index + match[0].length + 700);
      blocks.push(raw.slice(start, end));
    }
  }

  if (!blocks.length && normalized.includes(home) && normalized.includes(away)) {
    const homeIndex = normalized.indexOf(home);
    const awayIndex = normalized.indexOf(away);
    const midpoint = Math.max(0, Math.min(homeIndex, awayIndex));
    blocks.push(raw.slice(Math.max(0, midpoint - 800), midpoint + 1600));
  }

  return blocks;
}

function extractFixtureOdds({ block, fixture, source, now }) {
  const records = [];
  const capturedAt = now.toISOString();
  const bookmaker = source.bookmaker || source.name;

  records.push(...extractNamedOutcomeOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    now
  }));
  records.push(...extractDoubleChanceOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt
  }));
  records.push(...extractTotalGoalLineOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt
  }));
  records.push(...extractMarketPairOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    market: "over_1_5_goals",
    outcome: "Over",
    labelPattern: /(?:over|o)\s*1\.?5/i
  }));
  records.push(...extractMarketPairOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    market: "over_2_5_goals",
    outcome: "Over",
    labelPattern: /(?:over|o)\s*2\.?5/i
  }));
  records.push(...extractMarketPairOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    market: "under_2_5_goals",
    outcome: "Under",
    labelPattern: /(?:under|u)\s*2\.?5/i
  }));
  records.push(...extractMarketPairOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    market: "under_3_5_goals",
    outcome: "Under",
    labelPattern: /(?:under|u)\s*3\.?5/i
  }));
  records.push(...extractMarketPairOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    market: "under_4_5_goals",
    outcome: "Under",
    labelPattern: /(?:under|u)\s*4\.?5/i
  }));
  records.push(...extractMarketPairOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    market: "both_teams_to_score",
    outcome: "Yes",
    labelPattern: /(?:btts|both teams to score)[\s\S]{0,80}\byes\b/i
  }));
  records.push(...extractMarketPairOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    market: "both_teams_to_score",
    outcome: "No",
    labelPattern: /(?:btts|both teams to score)[\s\S]{0,80}\bno\b/i
  }));
  records.push(...extractScorerMarketOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt
  }));

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}`);
}

function extractNamedOutcomeOdds({ block, fixture, source, bookmaker, capturedAt, now }) {
  const outcomes = [
    { market: "match_winner", outcome: fixture.homeTeam, aliases: [fixture.homeTeam] },
    { market: "match_winner", outcome: "Draw", aliases: ["Draw", "Tie"] },
    { market: "match_winner", outcome: fixture.awayTeam, aliases: [fixture.awayTeam] },
    { market: "draw_no_bet", outcome: fixture.homeTeam, aliases: [`${fixture.homeTeam} draw no bet`, `${fixture.homeTeam} DNB`] },
    { market: "draw_no_bet", outcome: fixture.awayTeam, aliases: [`${fixture.awayTeam} draw no bet`, `${fixture.awayTeam} DNB`] }
  ];
  const records = [];

  for (const outcome of outcomes) {
    const price = firstPriceNearAliases(block, outcome.aliases);

    if (!price) {
      continue;
    }

    records.push(toOddsRecord({
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: outcome.market,
      outcome: outcome.outcome,
      decimalOdds: price
    }));
  }

  if (!records.length) {
    records.push(...extractCompactThreeWayMarket({ block, fixture, source, bookmaker, capturedAt, now }));
  }

  return records;
}

function extractCompactThreeWayMarket({ block, fixture, source, bookmaker, capturedAt }) {
  const prices = priceTokens(block).slice(0, 8);

  if (prices.length < 3 || !containsBothTeams(block, fixture)) {
    return [];
  }

  const [home, draw, away] = prices;
  return [
    toOddsRecord({ fixture, source, bookmaker, capturedAt, market: "match_winner", outcome: fixture.homeTeam, decimalOdds: home.value }),
    toOddsRecord({ fixture, source, bookmaker, capturedAt, market: "match_winner", outcome: "Draw", decimalOdds: draw.value }),
    toOddsRecord({ fixture, source, bookmaker, capturedAt, market: "match_winner", outcome: fixture.awayTeam, decimalOdds: away.value })
  ];
}

function extractMarketPairOdds({ block, fixture, source, bookmaker, capturedAt, market, outcome, labelPattern }) {
  const match = block.match(labelPattern);

  if (!match) {
    return [];
  }

  const window = block.slice(match.index, match.index + 180);
  const token = priceTokens(window)[0];

  if (!token) {
    return [];
  }

  return [toOddsRecord({
    fixture,
    source,
    bookmaker,
    capturedAt,
    market,
    outcome,
    decimalOdds: token.value
  })];
}

function extractDoubleChanceOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const section = doubleChanceSection(block) || String(block || "");
  const outcomes = [
    {
      outcome: `${fixture.homeTeam} or Draw`,
      aliases: [
        `${fixture.homeTeam} or draw`,
        `${fixture.homeTeam} / draw`,
        `${fixture.homeTeam}/draw`,
        `double chance ${fixture.homeTeam}`,
        `${fixture.homeTeam} double chance`
      ]
    },
    {
      outcome: `Draw or ${fixture.awayTeam}`,
      aliases: [
        `draw or ${fixture.awayTeam}`,
        `draw / ${fixture.awayTeam}`,
        `draw/${fixture.awayTeam}`,
        `double chance ${fixture.awayTeam}`,
        `${fixture.awayTeam} double chance`
      ]
    },
    {
      outcome: `${fixture.homeTeam} or ${fixture.awayTeam}`,
      aliases: [
        `${fixture.homeTeam} or ${fixture.awayTeam}`,
        `${fixture.homeTeam} / ${fixture.awayTeam}`,
        `${fixture.homeTeam}/${fixture.awayTeam}`,
        "no draw"
      ]
    }
  ];
  const records = [];

  for (const outcome of outcomes) {
    const price = firstPriceNearAliases(section, outcome.aliases);

    if (!price) {
      continue;
    }

    records.push(toOddsRecord({
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "double_chance",
      outcome: outcome.outcome,
      decimalOdds: price
    }));
  }

  return records;
}

function extractTotalGoalLineOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const section = totalGoalsSection(block);

  if (!section) {
    return [];
  }

  const records = [];
  const price = oddsPricePattern();
  const lines = [
    { line: "1.5", overMarket: "over_1_5_goals" },
    { line: "2.5", overMarket: "over_2_5_goals", underMarket: "under_2_5_goals" },
    { line: "3.5", underMarket: "under_3_5_goals" },
    { line: "4.5", underMarket: "under_4_5_goals" }
  ];

  for (const item of lines) {
    const linePattern = item.line.replace(".", "\\.?");
    const rowPattern = new RegExp(`\\b${linePattern}\\b[\\s\\S]{0,24}?(${price})[\\s\\S]{0,24}?(${price})`, "i");
    const row = rowPattern.exec(section);

    if (!row) {
      continue;
    }

    const beforeLine = section.slice(Math.max(0, row.index - 14), row.index).toLowerCase();

    if (/[a-z]\s*$/.test(beforeLine)) {
      continue;
    }

    if (item.overMarket) {
      const decimalOdds = toDecimalOdds(row[1]);

      if (decimalOdds) {
        records.push(toOddsRecord({
          fixture,
          source,
          bookmaker,
          capturedAt,
          market: item.overMarket,
          outcome: "Over",
          decimalOdds
        }));
      }
    }

    if (item.underMarket) {
      const decimalOdds = toDecimalOdds(row[2]);

      if (decimalOdds) {
        records.push(toOddsRecord({
          fixture,
          source,
          bookmaker,
          capturedAt,
          market: item.underMarket,
          outcome: "Under",
          decimalOdds
        }));
      }
    }
  }

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}`);
}

function doubleChanceSection(block) {
  const match = String(block || "").match(/(?:double\s+chance)[\s\S]{0,900}?(?=(?:draw\s+no\s+bet|handicap|total goals|over\/under|both teams|correct score|player|corners|cards|$))/i);
  return match?.[0] || "";
}

function totalGoalsSection(block) {
  const match = String(block || "").match(/(?:total\s+goals|match\s+goals|goals\s+over\/under|over\/under|asian\s+total)[\s\S]{0,1200}?(?=(?:handicap|both teams|correct score|player|corners|cards|double chance|$))/i);
  return match?.[0] || "";
}

function extractScorerMarketOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const section = String(block || "");

  if (!section) {
    return [];
  }

  const records = [];
  const add = ({ playerName, playerTeam, market, price }) => {
    const cleanPlayer = cleanScorerName(playerName);
    const cleanTeam = cleanPlayerTeam(playerTeam, fixture);
    const decimalOdds = toDecimalOdds(price);

    if (!cleanPlayer || !decimalOdds || !looksLikeScorerName(cleanPlayer, fixture)) {
      return;
    }

    records.push(toOddsRecord({
      fixture,
      source,
      bookmaker,
      capturedAt,
      market,
      outcome: cleanPlayer,
      decimalOdds,
      playerName: cleanPlayer,
      playerTeam: cleanTeam
    }));
  };
  const name = scorerNamePattern();
  const price = oddsPricePattern();
  const tableFirstAnytime = new RegExp(`\\b(${name})(?:\\s*\\(([^)]+)\\))?\\s+First\\s+(${price})\\s+Anytime\\s+(${price})`, "gi");
  const tableAnytimeFirst = new RegExp(`\\b(${name})(?:\\s*\\(([^)]+)\\))?\\s+Anytime\\s+(${price})\\s+First\\s+(${price})`, "gi");
  const latestPlayerProps = new RegExp(`\\bLatest\\s+(${name})\\s+Player\\s+Prop\\s+Odds[\\s\\S]{0,120}?Goalscorer\\s+Anytime\\s+(${price})\\s+First\\s+(${price})`, "gi");
  const playerAnytime = new RegExp(`\\b(${name})(?:\\s*\\(([^)]+)\\))?\\s+(?:anytime\\s+(?:goal)?scorer|anytime\\s+to\\s+score|to\\s+score\\s+anytime|to\\s+score)\\s+(${price})`, "gi");
  const anytimePlayer = new RegExp(`\\b(?:anytime\\s+(?:goal)?scorer|anytime\\s+to\\s+score|to\\s+score\\s+anytime)\\s+(${name})(?:\\s*\\(([^)]+)\\))?\\s+(${price})`, "gi");
  const playerFirst = new RegExp(`\\b(${name})(?:\\s*\\(([^)]+)\\))?\\s+(?:first\\s+(?:goal)?scorer|first\\s+goalscorer)\\s+(${price})`, "gi");
  const firstPlayer = new RegExp(`\\b(?:first\\s+(?:goal)?scorer|first\\s+goalscorer)\\s+(${name})(?:\\s*\\(([^)]+)\\))?\\s+(${price})`, "gi");

  for (const match of section.matchAll(tableFirstAnytime)) {
    add({ playerName: match[1], playerTeam: match[2], market: "first_goalscorer", price: match[3] });
    add({ playerName: match[1], playerTeam: match[2], market: "anytime_scorer", price: match[4] });
  }

  for (const match of section.matchAll(tableAnytimeFirst)) {
    add({ playerName: match[1], playerTeam: match[2], market: "anytime_scorer", price: match[3] });
    add({ playerName: match[1], playerTeam: match[2], market: "first_goalscorer", price: match[4] });
  }

  for (const match of section.matchAll(latestPlayerProps)) {
    add({ playerName: match[1], market: "anytime_scorer", price: match[2] });
    add({ playerName: match[1], market: "first_goalscorer", price: match[3] });
  }

  for (const match of section.matchAll(playerAnytime)) {
    add({ playerName: match[1], playerTeam: match[2], market: "anytime_scorer", price: match[3] });
  }

  for (const match of section.matchAll(anytimePlayer)) {
    add({ playerName: match[1], playerTeam: match[2], market: "anytime_scorer", price: match[3] });
  }

  for (const match of section.matchAll(playerFirst)) {
    add({ playerName: match[1], playerTeam: match[2], market: "first_goalscorer", price: match[3] });
  }

  for (const match of section.matchAll(firstPlayer)) {
    add({ playerName: match[1], playerTeam: match[2], market: "first_goalscorer", price: match[3] });
  }

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}`);
}

function extractAnytimeScorerOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const section = scorerSection(block);

  if (!section) {
    return [];
  }

  const records = [];
  const pattern = /\b([A-Z][A-Za-zÀ-ÿ' .-]{2,45})\s+(\d{1,2}\.\d{2}|\d{1,3}\s*\/\s*\d{1,3})\b/g;

  for (const match of section.matchAll(pattern)) {
    const playerName = cleanScorerName(match[1]);
    const decimalOdds = toDecimalOdds(match[2]);

    if (!playerName || !decimalOdds || !looksLikeScorerName(playerName, fixture)) {
      continue;
    }

    records.push(toOddsRecord({
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "anytime_scorer",
      outcome: playerName,
      decimalOdds,
      playerName
    }));
  }

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}`);
}

function scorerSection(block) {
  const match = String(block || "").match(/(?:player\s+goals|player\s+prop|anytime\s+(?:goal)?scorer|anytime\s+to\s+score|to\s+score\s+anytime|first\s+(?:goal)?scorer)[\s\S]{0,4200}?(?=(?:bet\s+builder|full\s+time\s+result|over\/under|both\s+teams|correct\s+score|odds\s+last|popular|more markets|$))/i);
  return match?.[0] || "";
}

function parseScorerOffer(name) {
  const text = String(name || "").replace(/\s+/g, " ").trim();
  const firstScorer = /(?:first\s+(?:goal)?scorer|first\s+goalscorer)/i.test(text);
  const anytimeScorer = /(?:anytime\s+(?:goal)?scorer|anytime\s+to\s+score|to\s+score\s+anytime|\bto\s+score\b)/i.test(text);

  if (!firstScorer && !anytimeScorer) {
    return null;
  }

  if (/(?:both\s+teams|team\s+to\s+score|correct\s+score|scorecast|top\s+(?:team\s+)?goalscorer|golden\s+boot)/i.test(text)) {
    return null;
  }

  const [candidate] = text.split(/\s+(?:first\s+(?:goal)?scorer|first\s+goalscorer|anytime\s+(?:goal)?scorer|anytime\s+to\s+score|to\s+score\s+anytime|to\s+score)\b|[-\u2013\u2014]| at /i);
  const playerName = cleanScorerName(candidate);

  return playerName && looksLikeScorerName(playerName)
    ? { market: firstScorer ? "first_goalscorer" : "anytime_scorer", playerName }
    : null;
}

function parseDoubleChanceOffer(name, fixture) {
  const text = String(name || "").replace(/\s+/g, " ").trim();

  if (/draw\s+no\s+bet|handicap|correct\s+score|to\s+qualify/i.test(text)) {
    return null;
  }

  const selectionText = text.split(/\s+-\s+|\s+at\s+/i)[0] || text;
  const lower = selectionText.toLowerCase();
  const home = fixture.homeTeam;
  const away = fixture.awayTeam;
  const homeDraw = (teamNameMatches(lower, home) && /\bor\s+draw\b|\/\s*draw|\b1x\b|double\s+chance/i.test(selectionText))
    && !teamNameMatches(lower, away);
  const awayDraw = (teamNameMatches(lower, away) && /\bdraw\s+or\b|draw\s*\/|\bx2\b|double\s+chance/i.test(selectionText))
    && !teamNameMatches(lower, home);
  const noDraw = teamNameMatches(lower, home)
    && teamNameMatches(lower, away)
    && (/\bor\b|\/|\b12\b|\bno draw\b/i.test(selectionText));

  if (homeDraw) {
    return { market: "double_chance", outcome: `${home} or Draw` };
  }

  if (awayDraw) {
    return { market: "double_chance", outcome: `Draw or ${away}` };
  }

  if (noDraw) {
    return { market: "double_chance", outcome: `${home} or ${away}` };
  }

  return null;
}

function parseAnytimeScorerOffer(name) {
  const text = String(name || "").replace(/\s+/g, " ").trim();

  if (!/(?:anytime\s+(?:goal)?scorer|anytime\s+to\s+score|to\s+score\s+anytime|\bto\s+score\b)/i.test(text)) {
    return null;
  }

  if (/(?:both\s+teams|team\s+to\s+score|correct\s+score|scorecast|first\s+goal|top\s+(?:team\s+)?goalscorer|golden\s+boot)/i.test(text)) {
    return null;
  }

  const [candidate] = text.split(/\s+(?:anytime\s+(?:goal)?scorer|anytime\s+to\s+score|to\s+score\s+anytime|to\s+score)\b|[—-]| at /i);
  const playerName = cleanScorerName(candidate);

  return playerName && looksLikeScorerName(playerName) ? { playerName } : null;
}

function cleanScorerName(value) {
  return String(value || "")
    .replace(/\b(?:World Cup|FIFA|Odds|Price|Bet|Boost|Selection|Player|Prop|Props|Top Pick|Latest|Goalscorer|Scorer|Anytime|First|Goals|Goal)\b/gi, " ")
    .replace(/^[^A-Za-zÀ-ÿ]+|[^A-Za-zÀ-ÿ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPlayerTeam(value, fixture) {
  const text = String(value || "").trim();

  if (teamNameMatches(text, fixture.homeTeam)) {
    return fixture.homeTeam;
  }

  if (teamNameMatches(text, fixture.awayTeam)) {
    return fixture.awayTeam;
  }

  return "";
}

function looksLikeScorerName(value, fixture = null) {
  const normalized = normalizeName(value);

  if (!normalized || normalized.split(/\s+/).length > 5) {
    return false;
  }

  if (/^(yes|no|draw|over|under|home|away|selection|odds|price)$/.test(normalized)) {
    return false;
  }

  if (fixture && (teamNameMatches(value, fixture.homeTeam) || teamNameMatches(value, fixture.awayTeam))) {
    return false;
  }

  return /[a-z]/.test(normalized) && normalized.length >= 4;
}

function firstPriceNearAliases(block, aliases) {
  for (const alias of aliases) {
    const pattern = new RegExp(`${escapeRegExp(alias)}[\\s\\S]{0,90}?((?:\\d{1,2}\\.\\d{2})|(?:\\d{1,3}\\s*\\/\\s*\\d{1,3}))`, "i");
    const match = block.match(pattern);
    const price = toDecimalOdds(match?.[1]);

    if (price) {
      return price;
    }
  }

  return null;
}

function priceTokens(block) {
  const tokens = [];
  const pattern = /\b(\d{1,2}\.\d{2}|[+-]\d{3,4}|\d{1,3}\s*\/\s*\d{1,3})\b/g;

  for (const match of String(block || "").matchAll(pattern)) {
    const value = toDecimalOdds(match[1]);

    if (value && value >= 1.01 && value <= 1001) {
      tokens.push({ value, index: match.index });
    }
  }

  return tokens;
}

function scorerNamePattern() {
  return "[A-Z\\u00C0-\\u017F][A-Za-z\\u00C0-\\u017F' .-]{2,45}";
}

function oddsPricePattern() {
  return "(?:\\d{1,2}\\.\\d{2}|[+-]\\d{3,4}|\\d{1,3}\\s*\\/\\s*\\d{1,3})";
}

function containsBothTeams(block, fixture) {
  return teamNameMatches(block, fixture.homeTeam) && teamNameMatches(block, fixture.awayTeam);
}

function toOddsRecord({ fixture, source, bookmaker, capturedAt, market, outcome, decimalOdds, playerName, playerTeam }) {
  return {
    id: makeId("odds", [capturedAt, bookmaker, fixture.id, market, outcome, decimalOdds]),
    capturedAt,
    provider: "public-web",
    source: source.name,
    sourceUrl: source.url,
    bookmaker,
    fixtureId: fixture.id,
    fixtureDate: fixture.date,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    market,
    outcome,
    playerName,
    playerTeam,
    decimalOdds: Number(decimalOdds),
    sourceReliability: source.reliability
  };
}
