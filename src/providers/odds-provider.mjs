import { readJson } from "../db.mjs";
import { SURVIVABILITY_MARKET_KEYS } from "../survivability-market-coverage.mjs";
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
    records: uniqueBy(records, (record) => `${record.capturedAt}|${record.bookmaker}|${record.fixtureId}|${record.market}|${record.outcome}|${record.line || ""}|${record.side || ""}`),
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
        line: mapped.line,
        team: mapped.team,
        side: mapped.side,
        handicapType: mapped.handicapType,
        settlementType: mapped.settlementType,
        dataOnly: mapped.dataOnly,
        decimalOdds: price
      }));
    }
  }

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}|${record.line || ""}|${record.side || ""}`);
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
  const eventOffer = parseEventOffer(name, fixture);
  const prefix = normalizeName(name.split(/[—-]/)[0]);
  const homeNames = [fixture.homeTeam, event.homeTeam?.alternateName, event.homeTeam?.name].filter(Boolean).map(normalizeName);
  const awayNames = [fixture.awayTeam, event.awayTeam?.alternateName, event.awayTeam?.name].filter(Boolean).map(normalizeName);

  if (scorer) {
    return { market: scorer.market, outcome: scorer.playerName, playerName: scorer.playerName, playerTeam: scorer.playerTeam };
  }

  if (eventOffer) {
    return eventOffer;
  }

  const doubleChance = parseDoubleChanceOffer(name, fixture);

  if (doubleChance) {
    return doubleChance;
  }

  const survivability = parseSurvivabilityOffer(name, fixture);

  if (survivability) {
    return survivability;
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
  records.push(...extractSurvivabilityMarketOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt
  }));
  records.push(...extractEventMarketOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt
  }));
  records.push(...extractScorerMarketOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt
  }));

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}|${record.line || ""}|${record.side || ""}`);
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

function extractSurvivabilityMarketOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const records = [
    ...extractAsianHandicapOdds({ block, fixture, source, bookmaker, capturedAt }),
    ...extractAsianTotalOdds({ block, fixture, source, bookmaker, capturedAt }),
    ...extractThreeWayHandicapOdds({ block, fixture, source, bookmaker, capturedAt }),
    ...extractTeamTotalOdds({ block, fixture, source, bookmaker, capturedAt }),
    ...extractTeamToScoreOdds({ block, fixture, source, bookmaker, capturedAt }),
    ...extractToQualifyOdds({ block, fixture, source, bookmaker, capturedAt })
  ];

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}`);
}

function extractAsianHandicapOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const section = marketSection(block, /asian\s+handicap/i, /(?:asian\s+total|total goals|team total|team to score|to qualify|3[-\s]?way|european handicap|both teams|correct score|player|corners|cards|$)/i, 1600);

  if (!section) {
    return [];
  }

  const records = [];
  const price = oddsPricePattern();
  const line = signedLinePattern();

  for (const team of [fixture.homeTeam, fixture.awayTeam]) {
    const teamPattern = teamPatternFor(team);
    const patterns = [
      new RegExp(`(?:asian\\s+handicap|ah)\\s+${teamPattern}\\s*(${line})[\\s\\S]{0,32}?(${price})`, "gi"),
      new RegExp(`${teamPattern}\\s*(${line})\\s*(?:asian\\s+handicap|ah)?[\\s\\S]{0,32}?(${price})`, "gi"),
      new RegExp(`${teamPattern}\\s*(?:asian\\s+handicap|ah)\\s*(${line})[\\s\\S]{0,32}?(${price})`, "gi")
    ];

    for (const pattern of patterns) {
      for (const match of section.matchAll(pattern)) {
        const lineValue = formatLine(match[1], { signed: true });
        addCollectOnlyRecord(records, {
          fixture,
          source,
          bookmaker,
          capturedAt,
          market: "asian_handicap",
          outcome: `${team} ${lineValue}`,
          decimalOdds: match[2],
          team,
          side: teamNameMatches(team, fixture.homeTeam) ? "home" : "away",
          line: lineValue,
          handicapType: "asian",
          settlementType: "asian_handicap"
        });
      }
    }
  }

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}`);
}

function extractAsianTotalOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const section = marketSection(block, /asian\s+(?:total|goals)|total\s+goals\s+asian/i, /(?:asian\s+handicap|team total|team to score|to qualify|3[-\s]?way|european handicap|both teams|correct score|player|corners|cards|$)/i, 1600);

  if (!section) {
    return [];
  }

  return extractOverUnderLineRecords({
    section,
    fixture,
    source,
    bookmaker,
    capturedAt,
    market: "asian_total_goals",
    settlementType: "asian_total_goals",
    outcomePrefix: "",
    team: "",
    lineAlias: "Goals"
  });
}

function extractThreeWayHandicapOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const section = marketSection(block, /(?:3[-\s]?way|european|match)\s+handicap|handicap\s+result/i, /(?:asian\s+handicap|asian\s+total|team total|team to score|to qualify|both teams|correct score|player|corners|cards|$)/i, 1700);

  if (!section) {
    return [];
  }

  const records = [];
  const price = oddsPricePattern();
  const line = signedLinePattern();
  const homePattern = teamPatternFor(fixture.homeTeam);
  const awayPattern = teamPatternFor(fixture.awayTeam);

  for (const handicapTeam of [fixture.homeTeam, fixture.awayTeam]) {
    const handicapTeamPattern = teamPatternFor(handicapTeam);
    const pattern = new RegExp(`${handicapTeamPattern}\\s*(${line})[\\s\\S]{0,120}?${homePattern}\\s+(${price})[\\s\\S]{0,80}?draw\\s+(${price})[\\s\\S]{0,80}?${awayPattern}\\s+(${price})`, "i");
    const match = section.match(pattern);

    if (!match) {
      continue;
    }

    const lineValue = formatLine(match[1], { signed: true });

    addCollectOnlyRecord(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "three_way_handicap",
      outcome: `${fixture.homeTeam} (${handicapTeam} ${lineValue})`,
      decimalOdds: match[2],
      team: fixture.homeTeam,
      side: "home",
      line: lineValue,
      handicapType: "three_way",
      settlementType: "three_way_handicap"
    });
    addCollectOnlyRecord(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "three_way_handicap",
      outcome: `Draw (${handicapTeam} ${lineValue})`,
      decimalOdds: match[3],
      side: "draw",
      line: lineValue,
      handicapType: "three_way",
      settlementType: "three_way_handicap"
    });
    addCollectOnlyRecord(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "three_way_handicap",
      outcome: `${fixture.awayTeam} (${handicapTeam} ${lineValue})`,
      decimalOdds: match[4],
      team: fixture.awayTeam,
      side: "away",
      line: lineValue,
      handicapType: "three_way",
      settlementType: "three_way_handicap"
    });
  }

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}`);
}

function extractTeamTotalOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const section = marketSection(block, /team\s+(?:total|goals)|team\s+goals/i, /(?:asian\s+handicap|asian\s+total|team to score|to qualify|3[-\s]?way|european handicap|both teams|correct score|player|corners|cards|$)/i, 1800);

  if (!section) {
    return [];
  }

  const records = [];

  for (const team of [fixture.homeTeam, fixture.awayTeam]) {
    records.push(...extractOverUnderLineRecords({
      section,
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "team_total_goals",
      settlementType: "team_total_goals",
      outcomePrefix: team,
      team,
      teamPattern: teamPatternFor(team),
      lineAlias: "Team goals"
    }));
  }

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}`);
}

function extractTeamToScoreOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const section = marketSection(block, /team\s+to\s+score|to\s+score/i, /(?:asian\s+handicap|asian\s+total|team total|to qualify|3[-\s]?way|european handicap|both teams|correct score|player|corners|cards|$)/i, 1400);

  if (!section) {
    return [];
  }

  const records = [];
  const price = oddsPricePattern();

  for (const team of [fixture.homeTeam, fixture.awayTeam]) {
    const teamPattern = teamPatternFor(team);
    const patterns = [
      new RegExp(`(?:team\\s+to\\s+score\\s+)?${teamPattern}[\\s\\S]{0,24}?\\byes\\b[\\s\\S]{0,24}?(${price})[\\s\\S]{0,40}?\\bno\\b[\\s\\S]{0,24}?(${price})`, "gi"),
      new RegExp(`${teamPattern}\\s+to\\s+score[\\s\\S]{0,24}?\\byes\\b[\\s\\S]{0,24}?(${price})[\\s\\S]{0,40}?\\bno\\b[\\s\\S]{0,24}?(${price})`, "gi")
    ];

    for (const pattern of patterns) {
      for (const match of section.matchAll(pattern)) {
        addCollectOnlyRecord(records, {
          fixture,
          source,
          bookmaker,
          capturedAt,
          market: "team_to_score",
          outcome: `${team} to score: Yes`,
          decimalOdds: match[1],
          team,
          side: "yes",
          settlementType: "team_to_score"
        });
        addCollectOnlyRecord(records, {
          fixture,
          source,
          bookmaker,
          capturedAt,
          market: "team_to_score",
          outcome: `${team} to score: No`,
          decimalOdds: match[2],
          team,
          side: "no",
          settlementType: "team_to_score"
        });
      }
    }
  }

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}`);
}

function extractToQualifyOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const section = marketSection(block, /to\s+qualify|qualification/i, /(?:asian\s+handicap|asian\s+total|team total|team to score|3[-\s]?way|european handicap|both teams|correct score|player|corners|cards|$)/i, 1200);

  if (!section) {
    return [];
  }

  const records = [];
  const price = oddsPricePattern();

  for (const team of [fixture.homeTeam, fixture.awayTeam]) {
    const teamPattern = teamPatternFor(team);
    const patterns = [
      new RegExp(`${teamPattern}\\s+to\\s+qualify[\\s\\S]{0,24}?(${price})`, "gi"),
      new RegExp(`to\\s+qualify[\\s\\S]{0,40}?${teamPattern}[\\s\\S]{0,24}?(${price})`, "gi")
    ];

    for (const pattern of patterns) {
      for (const match of section.matchAll(pattern)) {
        addCollectOnlyRecord(records, {
          fixture,
          source,
          bookmaker,
          capturedAt,
          market: "to_qualify",
          outcome: `${team} to qualify`,
          decimalOdds: match[1],
          team,
          settlementType: "to_qualify"
        });
      }
    }
  }

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}`);
}

function extractOverUnderLineRecords({
  section,
  fixture,
  source,
  bookmaker,
  capturedAt,
  market,
  settlementType,
  outcomePrefix = "",
  team = "",
  teamPattern = "",
  lineAlias = "Goals"
}) {
  const records = [];
  const price = oddsPricePattern();
  const line = goalLinePattern();
  const prefixPattern = teamPattern ? `${teamPattern}[\\s\\S]{0,45}?` : "";
  const overUnder = new RegExp(`${prefixPattern}\\bover\\s*(${line})(?:\\s+${lineAlias})?[\\s\\S]{0,28}?(${price})[\\s\\S]{0,58}?\\bunder\\s*\\1(?:\\s+${lineAlias})?[\\s\\S]{0,28}?(${price})`, "gi");
  const lineThenPrices = new RegExp(`${prefixPattern}\\b(${line})\\b[\\s\\S]{0,28}?(${price})[\\s\\S]{0,28}?(${price})`, "gi");

  for (const match of section.matchAll(overUnder)) {
    const lineValue = formatLine(match[1]);
    addOverUnderRecords(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market,
      settlementType,
      outcomePrefix,
      team,
      line: lineValue,
      overPrice: match[2],
      underPrice: match[3]
    });
  }

  for (const match of section.matchAll(lineThenPrices)) {
    const before = section.slice(Math.max(0, match.index - 40), match.index).toLowerCase();
    const immediateBefore = section.slice(Math.max(0, match.index - 12), match.index).toLowerCase();

    if (/\b(?:price|odds|rank|group|match)\b/.test(before) || /\b(?:over|under)\s*$/.test(immediateBefore)) {
      continue;
    }

    const lineValue = formatLine(match[1]);
    addOverUnderRecords(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market,
      settlementType,
      outcomePrefix,
      team,
      line: lineValue,
      overPrice: match[2],
      underPrice: match[3]
    });
  }

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}`);
}

function addOverUnderRecords(records, { fixture, source, bookmaker, capturedAt, market, settlementType, outcomePrefix, team, line, overPrice, underPrice }) {
  const prefix = outcomePrefix ? `${outcomePrefix} ` : "";

  addCollectOnlyRecord(records, {
    fixture,
    source,
    bookmaker,
    capturedAt,
    market,
    outcome: `${prefix}Over ${line}`,
    decimalOdds: overPrice,
    team,
    side: "over",
    line,
    settlementType
  });
  addCollectOnlyRecord(records, {
    fixture,
    source,
    bookmaker,
    capturedAt,
    market,
    outcome: `${prefix}Under ${line}`,
    decimalOdds: underPrice,
    team,
    side: "under",
    line,
    settlementType
  });
}

function addCollectOnlyRecord(records, values) {
  const decimalOdds = toDecimalOdds(values.decimalOdds);

  if (!decimalOdds) {
    return;
  }

  records.push(toOddsRecord({
    ...values,
    decimalOdds,
    dataOnly: true
  }));
}

function extractEventMarketOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const records = [
    ...extractBinaryEventMarketOdds({
      block,
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "penalty_awarded",
      startPattern: /(?:penalty|penalties).{0,80}?(?:awarded|taken|in match|yes|no)|(?:to be a penalty|penalty awarded)/i,
      stopPattern: /(?:player|shots?|goalscorer|assists?|corners?|cards?|handicap|total goals|both teams|correct score|$)/i
    }),
    ...extractBinaryEventMarketOdds({
      block,
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "red_card",
      startPattern: /(?:red card|sending off|sent off).{0,80}?(?:shown|in match|yes|no)|(?:to be a red card)/i,
      stopPattern: /(?:player|shots?|goalscorer|assists?|corners?|yellow|cards?|handicap|total goals|both teams|correct score|$)/i
    }),
    ...extractTeamLineMarketOdds({
      block,
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "team_shots",
      settlementType: "team_shots",
      startPattern: /(?:team\s+shots|team\s+total\s+shots|total\s+team\s+shots)/i,
      stopPattern: /(?:shots?\s+on\s+target|team\s+sot|corners?|cards?|player|goalscorer|assists?|handicap|total goals|both teams|correct score|$)/i,
      lineAlias: "Shots"
    }),
    ...extractTeamLineMarketOdds({
      block,
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "team_shots_on_target",
      settlementType: "team_shots_on_target",
      startPattern: /(?:team\s+shots?\s+on\s+target|team\s+sot|team\s+total\s+sot)/i,
      stopPattern: /(?:team\s+shots\b|corners?|cards?|player|goalscorer|assists?|handicap|total goals|both teams|correct score|$)/i,
      lineAlias: "(?:Shots?\\s+On\\s+Target|SOT)"
    }),
    ...extractCornerMarketOdds({ block, fixture, source, bookmaker, capturedAt }),
    ...extractCardTotalMarketOdds({ block, fixture, source, bookmaker, capturedAt }),
    ...extractTeamBinaryMarketOdds({
      block,
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "clean_sheet",
      settlementType: "clean_sheet",
      startPattern: /(?:clean\s+sheet|to\s+keep\s+a\s+clean\s+sheet)/i,
      stopPattern: /(?:win\s+to\s+nil|corners?|cards?|shots?|player|goalscorer|assists?|handicap|total goals|both teams|correct score|$)/i,
      label: "clean sheet"
    }),
    ...extractTeamBinaryMarketOdds({
      block,
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "win_to_nil",
      settlementType: "win_to_nil",
      startPattern: /(?:win\s+to\s+nil|to\s+win\s+to\s+nil)/i,
      stopPattern: /(?:clean\s+sheet|corners?|cards?|shots?|player|goalscorer|assists?|handicap|total goals|both teams|correct score|$)/i,
      label: "win to nil"
    }),
    ...extractPlayerShotOdds({ block, fixture, source, bookmaker, capturedAt }),
    ...extractPlayerShotOnTargetOdds({ block, fixture, source, bookmaker, capturedAt }),
    ...extractGoalkeeperSaveOdds({ block, fixture, source, bookmaker, capturedAt }),
    ...extractPlayerCardOdds({ block, fixture, source, bookmaker, capturedAt })
  ];

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}|${record.line || ""}|${record.side || ""}`);
}

function extractBinaryEventMarketOdds({ block, fixture, source, bookmaker, capturedAt, market, startPattern, stopPattern }) {
  const section = marketSection(block, startPattern, stopPattern, 1200);
  const records = [];

  if (!section) {
    return records;
  }

  const price = oddsPricePattern();
  const compactPair = new RegExp(`\\byes\\b[\\s\\S]{0,32}?(${price})[\\s\\S]{0,80}?\\bno\\b[\\s\\S]{0,32}?(${price})`, "i");
  const reverseCompactPair = new RegExp(`\\bno\\b[\\s\\S]{0,32}?(${price})[\\s\\S]{0,80}?\\byes\\b[\\s\\S]{0,32}?(${price})`, "i");
  const yesOnly = new RegExp(`\\byes\\b[\\s\\S]{0,42}?(${price})`, "i");
  const noOnly = new RegExp(`\\bno\\b[\\s\\S]{0,42}?(${price})`, "i");
  const compact = section.match(compactPair);
  const reverseCompact = section.match(reverseCompactPair);

  if (compact) {
    addEventRecord(records, { fixture, source, bookmaker, capturedAt, market, outcome: "Yes", decimalOdds: compact[1] });
    addEventRecord(records, { fixture, source, bookmaker, capturedAt, market, outcome: "No", decimalOdds: compact[2] });
    return records;
  }

  if (reverseCompact) {
    addEventRecord(records, { fixture, source, bookmaker, capturedAt, market, outcome: "No", decimalOdds: reverseCompact[1] });
    addEventRecord(records, { fixture, source, bookmaker, capturedAt, market, outcome: "Yes", decimalOdds: reverseCompact[2] });
    return records;
  }

  const yes = section.match(yesOnly);
  const no = section.match(noOnly);

  if (yes) {
    addEventRecord(records, { fixture, source, bookmaker, capturedAt, market, outcome: "Yes", decimalOdds: yes[1] });
  }

  if (no) {
    addEventRecord(records, { fixture, source, bookmaker, capturedAt, market, outcome: "No", decimalOdds: no[1] });
  }

  return records;
}

function extractPlayerShotOnTargetOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const section = String(block || "");
  const records = [];
  const name = playerEventNamePattern();
  const price = oddsPricePattern();
  const playerThenShot = new RegExp(`\\b(${name})(?:\\s*\\(([^)]+)\\))?\\s+(?:to\\s+have\\s+)?(?:1\\+|one\\s+or\\s+more|over\\s*0\\.?5)?\\s*(?:shots?\\s+on\\s+target|sot)\\s+(${price})`, "gi");
  const shotThenPlayer = new RegExp(`\\b(?:1\\+|one\\s+or\\s+more|over\\s*0\\.?5)\\s+(?:shots?\\s+on\\s+target|sot)\\s+(${name})(?:\\s*\\(([^)]+)\\))?\\s+(${price})`, "gi");
  const latestProps = new RegExp(`\\bLatest\\s+(${name})\\s+Player\\s+Prop\\s+Odds[\\s\\S]{0,220}?(?:shots?\\s+on\\s+target|sot)[\\s\\S]{0,44}?(${price})`, "gi");

  for (const match of section.matchAll(playerThenShot)) {
    addEventRecord(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "player_shot_on_target",
      outcome: match[1],
      playerName: match[1],
      playerTeam: cleanPlayerTeam(match[2], fixture),
      decimalOdds: match[3],
      line: "0.5",
      side: "over"
    });
  }

  for (const match of section.matchAll(shotThenPlayer)) {
    addEventRecord(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "player_shot_on_target",
      outcome: match[1],
      playerName: match[1],
      playerTeam: cleanPlayerTeam(match[2], fixture),
      decimalOdds: match[3],
      line: "0.5",
      side: "over"
    });
  }

  for (const match of section.matchAll(latestProps)) {
    addEventRecord(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "player_shot_on_target",
      outcome: match[1],
      playerName: match[1],
      decimalOdds: match[2],
      line: "0.5",
      side: "over"
    });
  }

  return records;
}

function extractPlayerShotOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const section = playerPropEventBlock(block);
  const records = [];
  const name = playerEventNamePattern();
  const price = oddsPricePattern();
  const line = goalLinePattern();
  const playerThenShots = new RegExp(`\\b(${name})(?:\\s*\\(([^)]+)\\))?\\s+(?:to\\s+have\\s+)?(?:(?:1\\+|one\\s+or\\s+more)\\s+)?(?:shots?|player\\s+shots?)\\b(?!\\s+on\\s+target|\\s*sot)(?:\\s+over\\s*(${line}))?[\\s\\S]{0,28}?(${price})`, "gi");
  const shotsThenPlayer = new RegExp(`\\b(?:1\\+|one\\s+or\\s+more|over\\s*(${line}))\\s+(?:shots?|player\\s+shots?)\\b(?!\\s+on\\s+target|\\s*sot)\\s+(${name})(?:\\s*\\(([^)]+)\\))?\\s+(${price})`, "gi");
  const latestPropsLine = new RegExp(`\\bLatest\\s+(${name})\\s+Player\\s+Prop\\s+Odds[^<]{0,160}?\\bShots\\b(?!\\s+On\\s+Target)[^<]{0,32}?Over\\s*(${line})\\s+(${price})`, "gi");
  const latestPropsBare = new RegExp(`\\bLatest\\s+(${name})\\s+Player\\s+Prop\\s+Odds[^<]{0,160}?\\bShots\\b(?!\\s+On\\s+Target)(?![^<]{0,36}?\\bOver\\b)[^<]{0,32}?(${price})`, "gi");

  for (const match of section.matchAll(playerThenShots)) {
    addEventRecord(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "player_shot",
      outcome: match[1],
      playerName: match[1],
      playerTeam: cleanPlayerTeam(match[2], fixture),
      decimalOdds: match[4],
      line: formatLine(match[3] || "0.5"),
      side: "over"
    });
  }

  for (const match of section.matchAll(shotsThenPlayer)) {
    addEventRecord(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "player_shot",
      outcome: match[2],
      playerName: match[2],
      playerTeam: cleanPlayerTeam(match[3], fixture),
      decimalOdds: match[4],
      line: formatLine(match[1] || "0.5"),
      side: "over"
    });
  }

  for (const match of section.matchAll(latestPropsLine)) {
    addEventRecord(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "player_shot",
      outcome: match[1],
      playerName: match[1],
      decimalOdds: match[3],
      line: formatLine(match[2]),
      side: "over"
    });
  }

  for (const match of section.matchAll(latestPropsBare)) {
    addEventRecord(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "player_shot",
      outcome: match[1],
      playerName: match[1],
      decimalOdds: match[2],
      line: "0.5",
      side: "over"
    });
  }

  return records;
}

function playerPropEventBlock(block) {
  return String(block || "").split(/(?:<section[^>]*>\s*<h2[^>]*>\s*)?(?:Team\s+Shots|Team\s+Shots\s+On\s+Target|Total\s+Corners|Team\s+Corners|Total\s+Cards|Team\s+Cards|Clean\s+Sheet|Win\s+To\s+Nil)\b/i)[0] || "";
}

function extractGoalkeeperSaveOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const section = String(block || "");
  const records = [];
  const name = playerEventNamePattern();
  const price = oddsPricePattern();
  const line = goalLinePattern();
  const playerThenSaves = new RegExp(`\\b(${name})(?:\\s*\\(([^)]+)\\))?\\s+(?:goalkeeper\\s+)?saves?\\s+(?:over\\s*)?(${line})[\\s\\S]{0,28}?(${price})`, "gi");
  const savesThenPlayer = new RegExp(`\\b(?:goalkeeper\\s+)?saves?\\s+(?:over\\s*)?(${line})\\s+(${name})(?:\\s*\\(([^)]+)\\))?\\s+(${price})`, "gi");

  for (const match of section.matchAll(playerThenSaves)) {
    addEventRecord(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "goalkeeper_saves",
      outcome: match[1],
      playerName: match[1],
      playerTeam: cleanPlayerTeam(match[2], fixture),
      decimalOdds: match[4],
      line: formatLine(match[3]),
      side: "over"
    });
  }

  for (const match of section.matchAll(savesThenPlayer)) {
    addEventRecord(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "goalkeeper_saves",
      outcome: match[2],
      playerName: match[2],
      playerTeam: cleanPlayerTeam(match[3], fixture),
      decimalOdds: match[4],
      line: formatLine(match[1]),
      side: "over"
    });
  }

  return records;
}

function extractTeamLineMarketOdds({ block, fixture, source, bookmaker, capturedAt, market, settlementType, startPattern, stopPattern, lineAlias }) {
  const section = marketSection(block, startPattern, stopPattern, 1800);
  const records = [];

  if (!section) {
    return records;
  }

  for (const team of [fixture.homeTeam, fixture.awayTeam]) {
    const teamPattern = teamPatternFor(team);

    records.push(...extractOverUnderLineRecords({
      section,
      fixture,
      source,
      bookmaker,
      capturedAt,
      market,
      settlementType,
      outcomePrefix: team,
      team,
      teamPattern,
      lineAlias
    }));
  }

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}|${record.line || ""}|${record.side || ""}`);
}

function extractCornerMarketOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const records = [];
  const totalSection = marketSection(block, /(?:total\s+corners|match\s+corners|corners\s+over\/under|corner\s+total)/i, /(?:team\s+corners|cards?|shots?|player|goalscorer|assists?|handicap|total goals|both teams|correct score|$)/i, 1600);

  if (totalSection) {
    records.push(...extractOverUnderLineRecords({
      section: totalSection,
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "total_corners",
      settlementType: "total_corners",
      lineAlias: "Corners"
    }));
  }

  records.push(...extractTeamLineMarketOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    market: "team_corners",
    settlementType: "team_corners",
    startPattern: /(?:team\s+corners|team\s+total\s+corners|corner\s+handicap)/i,
    stopPattern: /(?:total\s+corners|cards?|shots?|player|goalscorer|assists?|handicap|total goals|both teams|correct score|$)/i,
    lineAlias: "Corners"
  }));

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}|${record.line || ""}|${record.side || ""}`);
}

function extractCardTotalMarketOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const records = [];
  const totalSection = marketSection(block, /(?:total\s+cards|match\s+cards|cards\s+over\/under|booking\s+points)/i, /(?:team\s+cards|player|shots?|corners?|goalscorer|assists?|handicap|total goals|both teams|correct score|$)/i, 1600);

  if (totalSection) {
    records.push(...extractOverUnderLineRecords({
      section: totalSection,
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "total_cards",
      settlementType: "total_cards",
      lineAlias: "(?:Cards|Booking\\s+Points)"
    }));
  }

  records.push(...extractTeamLineMarketOdds({
    block,
    fixture,
    source,
    bookmaker,
    capturedAt,
    market: "team_cards",
    settlementType: "team_cards",
    startPattern: /(?:team\s+cards|team\s+total\s+cards|team\s+booking\s+points)/i,
    stopPattern: /(?:total\s+cards|player|shots?|corners?|goalscorer|assists?|handicap|total goals|both teams|correct score|$)/i,
    lineAlias: "(?:Cards|Booking\\s+Points)"
  }));

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}|${record.line || ""}|${record.side || ""}`);
}

function extractTeamBinaryMarketOdds({ block, fixture, source, bookmaker, capturedAt, market, settlementType, startPattern, stopPattern, label }) {
  const section = marketSection(block, startPattern, stopPattern, 1400);
  const records = [];
  const price = oddsPricePattern();

  if (!section) {
    return records;
  }

  for (const team of [fixture.homeTeam, fixture.awayTeam]) {
    const teamPattern = teamPatternFor(team);
    const yesNo = new RegExp(`${teamPattern}[\\s\\S]{0,56}?(?:${label})?[\\s\\S]{0,32}?\\byes\\b[\\s\\S]{0,24}?(${price})[\\s\\S]{0,70}?\\bno\\b[\\s\\S]{0,24}?(${price})`, "gi");
    const yesOnly = new RegExp(`${teamPattern}[\\s\\S]{0,56}?(?:${label})?[\\s\\S]{0,32}?\\byes\\b[\\s\\S]{0,24}?(${price})`, "gi");
    const directPrice = new RegExp(`${teamPattern}[\\s\\S]{0,32}?${label}[\\s\\S]{0,24}?(${price})`, "gi");

    for (const match of section.matchAll(yesNo)) {
      addCollectOnlyRecord(records, {
        fixture,
        source,
        bookmaker,
        capturedAt,
        market,
        outcome: `${team} ${label}: Yes`,
        decimalOdds: match[1],
        team,
        side: "yes",
        settlementType
      });
      addCollectOnlyRecord(records, {
        fixture,
        source,
        bookmaker,
        capturedAt,
        market,
        outcome: `${team} ${label}: No`,
        decimalOdds: match[2],
        team,
        side: "no",
        settlementType
      });
    }

    for (const match of section.matchAll(yesOnly)) {
      addCollectOnlyRecord(records, {
        fixture,
        source,
        bookmaker,
        capturedAt,
        market,
        outcome: `${team} ${label}: Yes`,
        decimalOdds: match[1],
        team,
        side: "yes",
        settlementType
      });
    }

    for (const match of section.matchAll(directPrice)) {
      addCollectOnlyRecord(records, {
        fixture,
        source,
        bookmaker,
        capturedAt,
        market,
        outcome: `${team} ${label}: Yes`,
        decimalOdds: match[1],
        team,
        side: "yes",
        settlementType
      });
    }
  }

  return uniqueBy(records, (record) => `${record.fixtureId}|${record.market}|${record.outcome}|${record.bookmaker}|${record.side || ""}`);
}

function extractPlayerCardOdds({ block, fixture, source, bookmaker, capturedAt }) {
  const section = String(block || "");
  const records = [];
  const name = playerEventNamePattern();
  const price = oddsPricePattern();
  const playerThenCard = new RegExp(`\\b(${name})(?:\\s*\\(([^)]+)\\))?\\s+(?:to\\s+be\\s+(?:shown\\s+a\\s+)?carded|to\\s+receive\\s+a\\s+card|to\\s+be\\s+booked|shown\\s+a\\s+card|yellow\\s+card|carded)\\s+(${price})`, "gi");
  const cardThenPlayer = new RegExp(`\\b(?:to\\s+be\\s+(?:shown\\s+a\\s+)?carded|to\\s+receive\\s+a\\s+card|to\\s+be\\s+booked|shown\\s+a\\s+card|yellow\\s+card|player\\s+card)\\s+(${name})(?:\\s*\\(([^)]+)\\))?\\s+(${price})`, "gi");

  for (const match of section.matchAll(playerThenCard)) {
    addEventRecord(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "player_card",
      outcome: match[1],
      playerName: match[1],
      playerTeam: cleanPlayerTeam(match[2], fixture),
      decimalOdds: match[3]
    });
  }

  for (const match of section.matchAll(cardThenPlayer)) {
    addEventRecord(records, {
      fixture,
      source,
      bookmaker,
      capturedAt,
      market: "player_card",
      outcome: match[1],
      playerName: match[1],
      playerTeam: cleanPlayerTeam(match[2], fixture),
      decimalOdds: match[3]
    });
  }

  return records;
}

function addEventRecord(records, values) {
  const decimalOdds = toDecimalOdds(values.decimalOdds);

  if (!decimalOdds) {
    return;
  }

  const isPlayerMarket = ["player_shot", "player_shot_on_target", "goalkeeper_saves", "player_card"].includes(values.market);
  const playerName = cleanPlayerEventName(values.playerName || values.outcome);

  if (isPlayerMarket && (!playerName || !looksLikeScorerName(playerName, values.fixture))) {
    return;
  }

  records.push(toOddsRecord({
    ...values,
    outcome: isPlayerMarket ? playerName : values.outcome,
    playerName: isPlayerMarket ? playerName : undefined,
    decimalOdds,
    dataOnly: true
  }));
}

function marketSection(block, startPattern, stopPattern, maxChars = 1400) {
  const text = String(block || "");
  const start = text.search(startPattern);

  if (start < 0) {
    return "";
  }

  const raw = text.slice(start, start + maxChars);
  const stopSearch = raw.slice(24).search(stopPattern);

  return stopSearch >= 0 ? raw.slice(0, stopSearch + 24) : raw;
}

function teamPatternFor(team) {
  return escapeRegExp(team).replace(/\s+/g, "\\s+");
}

function signedLinePattern() {
  return "[+-]?(?:\\d+(?:\\.\\d{1,2})?|\\.\\d{1,2})";
}

function goalLinePattern() {
  return "(?:\\d+(?:\\.\\d{1,2})?)";
}

function formatLine(value, { signed = false } = {}) {
  const numeric = Number(String(value || "").replace(/^\+/, ""));

  if (!Number.isFinite(numeric)) {
    return String(value || "").trim();
  }

  const rounded = Math.round(numeric * 100) / 100;
  const text = Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/0+$/, "").replace(/\.$/, "");

  return signed && rounded > 0 ? `+${text}` : text;
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
  const tableAnytimeFirstAssist = new RegExp(`\\b(${name})(?:\\s*\\(([^)]+)\\))?\\s+Anytime\\s+(${price})\\s+First\\s+(${price})\\s+Assist\\s+(${price})`, "gi");
  const latestPlayerProps = new RegExp(`\\bLatest\\s+(${name})\\s+Player\\s+Prop\\s+Odds[\\s\\S]{0,120}?Goalscorer\\s+Anytime\\s+(${price})\\s+First\\s+(${price})`, "gi");
  const latestAssistProps = new RegExp(`\\bLatest\\s+(${name})\\s+Player\\s+Prop\\s+Odds[\\s\\S]{0,160}?(?:Anytime\\s+Assist|Player\\s+Assists?|To\\s+Record\\s+An?\\s+Assist)\\s+(${price})`, "gi");
  const playerAnytime = new RegExp(`\\b(${name})(?:\\s*\\(([^)]+)\\))?\\s+(?:anytime\\s+(?:goal)?scorer|anytime\\s+to\\s+score|to\\s+score\\s+anytime|to\\s+score)\\s+(${price})`, "gi");
  const anytimePlayer = new RegExp(`\\b(?:anytime\\s+(?:goal)?scorer|anytime\\s+to\\s+score|to\\s+score\\s+anytime)\\s+(${name})(?:\\s*\\(([^)]+)\\))?\\s+(${price})`, "gi");
  const playerFirst = new RegExp(`\\b(${name})(?:\\s*\\(([^)]+)\\))?\\s+(?:first\\s+(?:goal)?scorer|first\\s+goalscorer)\\s+(${price})`, "gi");
  const firstPlayer = new RegExp(`\\b(?:first\\s+(?:goal)?scorer|first\\s+goalscorer)\\s+(${name})(?:\\s*\\(([^)]+)\\))?\\s+(${price})`, "gi");
  const playerAssist = new RegExp(`\\b(${name})(?:\\s*\\(([^)]+)\\))?\\s+(?:anytime\\s+assist|to\\s+(?:record\\s+)?an?\\s+assist|to\\s+assist|player\\s+assists?)\\s+(${price})`, "gi");
  const assistPlayer = new RegExp(`\\b(?:anytime\\s+assist|to\\s+(?:record\\s+)?an?\\s+assist|player\\s+assists?)\\s+(${name})(?:\\s*\\(([^)]+)\\))?\\s+(${price})`, "gi");

  for (const match of section.matchAll(tableFirstAnytime)) {
    add({ playerName: match[1], playerTeam: match[2], market: "first_goalscorer", price: match[3] });
    add({ playerName: match[1], playerTeam: match[2], market: "anytime_scorer", price: match[4] });
  }

  for (const match of section.matchAll(tableAnytimeFirst)) {
    add({ playerName: match[1], playerTeam: match[2], market: "anytime_scorer", price: match[3] });
    add({ playerName: match[1], playerTeam: match[2], market: "first_goalscorer", price: match[4] });
  }

  for (const match of section.matchAll(tableAnytimeFirstAssist)) {
    add({ playerName: match[1], playerTeam: match[2], market: "anytime_scorer", price: match[3] });
    add({ playerName: match[1], playerTeam: match[2], market: "first_goalscorer", price: match[4] });
    add({ playerName: match[1], playerTeam: match[2], market: "anytime_assist", price: match[5] });
  }

  for (const match of section.matchAll(latestPlayerProps)) {
    add({ playerName: match[1], market: "anytime_scorer", price: match[2] });
    add({ playerName: match[1], market: "first_goalscorer", price: match[3] });
  }

  for (const match of section.matchAll(latestAssistProps)) {
    add({ playerName: match[1], market: "anytime_assist", price: match[2] });
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

  for (const match of section.matchAll(playerAssist)) {
    add({ playerName: match[1], playerTeam: match[2], market: "anytime_assist", price: match[3] });
  }

  for (const match of section.matchAll(assistPlayer)) {
    add({ playerName: match[1], playerTeam: match[2], market: "anytime_assist", price: match[3] });
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
  const match = String(block || "").match(/(?:player\s+goals|player\s+prop|player\s+assists?|anytime\s+assist|to\s+record\s+an?\s+assist|anytime\s+(?:goal)?scorer|anytime\s+to\s+score|to\s+score\s+anytime|first\s+(?:goal)?scorer)[\s\S]{0,4200}?(?=(?:bet\s+builder|full\s+time\s+result|over\/under|both\s+teams|correct\s+score|odds\s+last|popular|more markets|$))/i);
  return match?.[0] || "";
}

function parseSurvivabilityOffer(name, fixture) {
  const text = String(name || "").replace(/\s+/g, " ").trim();
  const selection = text.split(/\s+-\s+|\s+at\s+/i)[0] || text;
  const team = teamFromSelection(selection, fixture);
  const overUnder = selection.match(new RegExp(`\\b(over|under)\\s*(${goalLinePattern()})\\b`, "i"));
  const signedLine = selection.match(new RegExp(`\\b(${signedLinePattern()})\\b`));

  if (/asian\s+handicap|\bah\b/i.test(selection) && team && signedLine) {
    const line = formatLine(signedLine[1], { signed: true });

    return {
      market: "asian_handicap",
      outcome: `${team} ${line}`,
      team,
      side: sideFromTeam(team, fixture),
      line,
      handicapType: "asian",
      settlementType: "asian_handicap",
      dataOnly: true
    };
  }

  if (/asian\s+(?:total|goals)|total\s+goals\s+asian/i.test(selection) && overUnder) {
    const side = overUnder[1].toLowerCase();
    const line = formatLine(overUnder[2]);

    return {
      market: "asian_total_goals",
      outcome: `${capitalized(side)} ${line}`,
      side,
      line,
      settlementType: "asian_total_goals",
      dataOnly: true
    };
  }

  if (/(?:3[-\s]?way|european|match)\s+handicap|handicap\s+result/i.test(selection) && signedLine) {
    const line = formatLine(signedLine[1], { signed: true });
    const handicapTeam = team || teamFromSelection(text, fixture);
    const outcome = /^draw\b/i.test(selection)
      ? `Draw (${handicapTeam || "handicap"} ${line})`
      : team
        ? `${team} (${handicapTeam || team} ${line})`
        : "";

    if (outcome) {
      return {
        market: "three_way_handicap",
        outcome,
        team: /^draw\b/i.test(selection) ? "" : team,
        side: /^draw\b/i.test(selection) ? "draw" : sideFromTeam(team, fixture),
        line,
        handicapType: "three_way",
        settlementType: "three_way_handicap",
        dataOnly: true
      };
    }
  }

  if (/(?:team\s+total|team\s+goals)/i.test(selection) && team && overUnder) {
    const side = overUnder[1].toLowerCase();
    const line = formatLine(overUnder[2]);

    return {
      market: "team_total_goals",
      outcome: `${team} ${capitalized(side)} ${line}`,
      team,
      side,
      line,
      settlementType: "team_total_goals",
      dataOnly: true
    };
  }

  if (/(?:team\s+to\s+score|\bto\s+score\b)/i.test(selection) && team) {
    const side = /\bno\b/i.test(selection) ? "no" : "yes";

    return {
      market: "team_to_score",
      outcome: `${team} to score: ${capitalized(side)}`,
      team,
      side,
      settlementType: "team_to_score",
      dataOnly: true
    };
  }

  if (/to\s+qualify/i.test(selection) && team) {
    return {
      market: "to_qualify",
      outcome: `${team} to qualify`,
      team,
      settlementType: "to_qualify",
      dataOnly: true
    };
  }

  return null;
}

function parseEventOffer(name, fixture) {
  const text = String(name || "").replace(/\s+/g, " ").trim();
  const selection = text.split(/\s+-\s+|\s+at\s+/i)[0] || text;
  const lineOffer = parseLineEventOffer(selection, fixture);

  if (lineOffer) {
    return lineOffer;
  }

  const teamBinaryOffer = parseTeamBinaryEventOffer(selection, fixture);

  if (teamBinaryOffer) {
    return teamBinaryOffer;
  }

  const playerShotOnTarget = parsePlayerEventSelection(selection, {
    market: "player_shot_on_target",
    trigger: /(?:shots?\s+on\s+target|sot|1\+\s+shots?\s+on\s+target|over\s*0\.?5\s+shots?\s+on\s+target)/i
  });

  if (playerShotOnTarget) {
    return {
      ...playerShotOnTarget,
      outcome: playerShotOnTarget.playerName,
      line: formatLine(lineFromSelection(selection) || "0.5"),
      side: "over",
      dataOnly: true
    };
  }

  const playerShot = parsePlayerEventSelection(selection, {
    market: "player_shot",
    trigger: /(?:1\+\s+shots?\b|over\s*\d+(?:\.\d+)?\s+shots?\b|player\s+shots?\b|shots?\b(?!\s+on\s+target|sot))/i
  });

  if (playerShot) {
    return {
      ...playerShot,
      outcome: playerShot.playerName,
      line: "0.5",
      side: "over",
      dataOnly: true
    };
  }

  const goalkeeperSave = parsePlayerEventSelection(selection, {
    market: "goalkeeper_saves",
    trigger: /(?:goalkeeper\s+)?saves?\s+(?:over\s*)?\d+(?:\.\d+)?|(?:over\s*)?\d+(?:\.\d+)?\s+(?:goalkeeper\s+)?saves?/i
  });

  if (goalkeeperSave) {
    return {
      ...goalkeeperSave,
      outcome: goalkeeperSave.playerName,
      line: formatLine(lineFromSelection(selection) || "2.5"),
      side: "over",
      dataOnly: true
    };
  }

  const playerCard = parsePlayerEventSelection(selection, {
    market: "player_card",
    trigger: /(?:to\s+be\s+(?:shown\s+a\s+)?carded|to\s+receive\s+a\s+card|to\s+be\s+booked|shown\s+a\s+card|yellow\s+card|player\s+card)/i
  });

  if (playerCard && !/(?:red\s+card|sending\s+off|sent\s+off)/i.test(selection)) {
    return {
      ...playerCard,
      outcome: playerCard.playerName,
      dataOnly: true
    };
  }

  if (/(?:penalty|penalties).{0,80}(?:awarded|taken|in match)|(?:to be a penalty|penalty awarded)/i.test(selection)) {
    return {
      market: "penalty_awarded",
      outcome: yesNoOutcome(selection),
      settlementType: "penalty_awarded",
      dataOnly: true
    };
  }

  if (/(?:red card|sending off|sent off).{0,80}(?:shown|in match|yes|no)|(?:to be a red card)/i.test(selection)) {
    return {
      market: "red_card",
      outcome: yesNoOutcome(selection),
      settlementType: "red_card",
      dataOnly: true
    };
  }

  return null;
}

function parseLineEventOffer(selection, fixture) {
  const overUnder = selection.match(new RegExp(`\\b(over|under)\\s*(${goalLinePattern()})\\b`, "i"));

  if (!overUnder) {
    return null;
  }

  const side = overUnder[1].toLowerCase();
  const line = formatLine(overUnder[2]);
  const team = teamFromSelection(selection, fixture);
  let market = "";

  if (/(?:shots?\s+on\s+target|\bsot\b)/i.test(selection) && team) {
    market = "team_shots_on_target";
  } else if (/\bshots?\b/i.test(selection) && team && !/(?:goalscorer|scorer|goal\s+scorer)/i.test(selection)) {
    market = "team_shots";
  } else if (/corners?/i.test(selection)) {
    market = team ? "team_corners" : "total_corners";
  } else if (/(?:cards?|booking\s+points)/i.test(selection) && !/player\s+card|to\s+be\s+carded|booked/i.test(selection)) {
    market = team ? "team_cards" : "total_cards";
  }

  if (!market) {
    return null;
  }

  return {
    market,
    outcome: team ? `${team} ${capitalized(side)} ${line}` : `${capitalized(side)} ${line}`,
    team,
    side,
    line,
    settlementType: market,
    dataOnly: true
  };
}

function parseTeamBinaryEventOffer(selection, fixture) {
  const team = teamFromSelection(selection, fixture);

  if (!team) {
    return null;
  }

  if (/(?:clean\s+sheet|to\s+keep\s+a\s+clean\s+sheet)/i.test(selection)) {
    const outcome = yesNoOutcome(selection);

    return {
      market: "clean_sheet",
      outcome: `${team} clean sheet: ${outcome}`,
      team,
      side: outcome.toLowerCase(),
      settlementType: "clean_sheet",
      dataOnly: true
    };
  }

  if (/(?:win\s+to\s+nil|to\s+win\s+to\s+nil)/i.test(selection)) {
    const outcome = yesNoOutcome(selection);

    return {
      market: "win_to_nil",
      outcome: `${team} win to nil: ${outcome}`,
      team,
      side: outcome.toLowerCase(),
      settlementType: "win_to_nil",
      dataOnly: true
    };
  }

  return null;
}

function lineFromSelection(selection) {
  const text = String(selection || "");

  if (/\b1\+|one\s+or\s+more/i.test(text)) {
    return "0.5";
  }

  return text.match(new RegExp(`\\b(?:over|under)\\s*(${goalLinePattern()})\\b`, "i"))?.[1] || "";
}

function parsePlayerEventSelection(selection, { market, trigger }) {
  const text = String(selection || "");

  if (!trigger.test(text)) {
    return null;
  }

  const [candidate] = text.split(trigger);
  const playerName = cleanPlayerEventName(candidate);

  return playerName && looksLikeScorerName(playerName)
    ? { market, playerName }
    : null;
}

function yesNoOutcome(selection) {
  return /\bno\b/i.test(selection) && !/\byes\b/i.test(selection) ? "No" : "Yes";
}

function parseScorerOffer(name) {
  const text = String(name || "").replace(/\s+/g, " ").trim();
  const firstScorer = /(?:first\s+(?:goal)?scorer|first\s+goalscorer)/i.test(text);
  const anytimeScorer = /(?:anytime\s+(?:goal)?scorer|anytime\s+to\s+score|to\s+score\s+anytime|\bto\s+score\b)/i.test(text);
  const anytimeAssist = /(?:anytime\s+assist|to\s+(?:record\s+)?an?\s+assist|player\s+assists?)/i.test(text);

  if (!firstScorer && !anytimeScorer && !anytimeAssist) {
    return null;
  }

  if (/(?:both\s+teams|team\s+to\s+score|correct\s+score|scorecast|top\s+(?:team\s+)?goalscorer|golden\s+boot|most\s+assists?|tournament\s+assists?)/i.test(text)) {
    return null;
  }

  const [candidate] = text.split(/\s+(?:first\s+(?:goal)?scorer|first\s+goalscorer|anytime\s+(?:goal)?scorer|anytime\s+to\s+score|to\s+score\s+anytime|to\s+score|anytime\s+assist|to\s+(?:record\s+)?an?\s+assist|player\s+assists?)\b|[-\u2013\u2014]| at /i);
  const playerName = cleanScorerName(candidate);

  return playerName && looksLikeScorerName(playerName)
    ? { market: anytimeAssist ? "anytime_assist" : firstScorer ? "first_goalscorer" : "anytime_scorer", playerName }
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

function teamFromSelection(selection, fixture) {
  for (const team of [fixture.homeTeam, fixture.awayTeam]) {
    if (teamNameMatches(selection, team)) {
      return team;
    }
  }

  return "";
}

function sideFromTeam(team, fixture) {
  if (teamNameMatches(team, fixture.homeTeam)) {
    return "home";
  }

  if (teamNameMatches(team, fixture.awayTeam)) {
    return "away";
  }

  return "";
}

function capitalized(value) {
  const text = String(value || "");
  return text ? `${text[0].toUpperCase()}${text.slice(1).toLowerCase()}` : "";
}

function cleanScorerName(value) {
  return String(value || "")
    .replace(/\b(?:World Cup|FIFA|Odds|Price|Bet|Boost|Selection|Player|Prop|Props|Top Pick|Latest|Goalscorer|Scorer|Anytime|First|Goals|Goal|Assist|Assists|Record)\b/gi, " ")
    .replace(/^[^A-Za-zÀ-ÿ]+|[^A-Za-zÀ-ÿ]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPlayerEventName(value) {
  return String(value || "")
    .replace(/\b(?:World Cup|FIFA|Odds|Price|Bet|Boost|Selection|Player|Prop|Props|Top Pick|Latest|Goalkeeper|Keeper|Saves?|Shots?|Shot|SOT|On Target|Target|Cards?|Carded|Booked|Booking|Yellow|Red|Shown|Receive|Penalty|Awarded|Yes|No|Over|Under)\b/gi, " ")
    .replace(/(?:1\+|one\s+or\s+more|0\.?5)/gi, " ")
    .replace(/^[^A-Za-z\u00C0-\u017F]+|[^A-Za-z\u00C0-\u017F]+$/g, "")
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

  if (/^(yes|no|draw|over|under|home|away|team|selection|odds|price)$/.test(normalized)) {
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

function playerEventNamePattern() {
  return "[A-Z\\u00C0-\\u017F][A-Za-z\\u00C0-\\u017F' .-]{2,45}?";
}

function oddsPricePattern() {
  return "(?:\\d{1,2}\\.\\d{2}|[+-]\\d{3,4}|\\d{1,3}\\s*\\/\\s*\\d{1,3})";
}

function containsBothTeams(block, fixture) {
  return teamNameMatches(block, fixture.homeTeam) && teamNameMatches(block, fixture.awayTeam);
}

function toOddsRecord({
  fixture,
  source,
  bookmaker,
  capturedAt,
  market,
  outcome,
  decimalOdds,
  playerName,
  playerTeam,
  line,
  team,
  side,
  handicapType,
  settlementType,
  dataOnly
}) {
  const collectOnly = dataOnly ?? SURVIVABILITY_MARKET_KEYS.includes(market);
  const record = {
    id: makeId("odds", [capturedAt, bookmaker, fixture.id, market, outcome, line, side, decimalOdds]),
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
    line,
    team,
    side,
    handicapType,
    settlementType,
    decimalOdds: Number(decimalOdds),
    sourceReliability: source.reliability
  };

  if (collectOnly) {
    record.dataOnly = true;
  }

  return record;
}
