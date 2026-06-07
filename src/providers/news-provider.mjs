import { readJson } from "../db.mjs";
import { assessNewsSource } from "../source-quality.mjs";
import { makeId, normalizeName } from "../utils.mjs";
import { sourceDiagnostic } from "./public-source.mjs";

export async function fetchNewsArticles({ fixtures, providerConfig, now = new Date() }) {
  const result = await fetchNewsArticlesWithDiagnostics({ fixtures, providerConfig, now });
  return result.records;
}

export async function fetchNewsArticlesWithDiagnostics({ fixtures, providerConfig, now = new Date() }) {
  const mode = providerConfig?.mode || "self-gather";

  if (mode === "self-gather") {
    return fetchSelfGatheredArticles({ fixtures, providerConfig, now });
  }

  throw new Error(`Unsupported news provider mode: ${mode}. WorldCupMagik news uses public RSS/HTML pages only.`);
}

async function fetchSelfGatheredArticles({ fixtures, providerConfig, now }) {
  const sourcesFile = providerConfig.sourcesFile || "config/news-sources.json";
  const sources = await readJson(sourcesFile.split(/[\\/]/), []);
  const teams = [...new Set(fixtures.flatMap((fixture) => [fixture.homeTeam, fixture.awayTeam]))];
  const sourceItems = [];
  const diagnostics = [];

  for (const source of sources) {
    try {
      const text = await fetchPublicText(source.url, providerConfig);
      const extracted = extractSourceItems({ source, text, teams, now })
        .slice(0, Number(providerConfig.maxArticlesPerSource || 12));
      sourceItems.push(...extracted);
      diagnostics.push(sourceDiagnostic({
        kind: "news",
        source,
        status: extracted.length ? "ok" : "empty",
        records: extracted.length,
        reason: extracted.length ? "" : "Fetched public source but found no team/tournament news links for the selected fixture window.",
        now
      }));
    } catch (error) {
      diagnostics.push(sourceDiagnostic({
        kind: "news",
        source,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
        now
      }));
    }
  }

  const enriched = [];
  const articleFetchLimit = Number(providerConfig.maxArticleFetches || 24);

  for (const item of sourceItems.slice(0, articleFetchLimit)) {
    let bodySnippet = "";

    if (item.url && isHttpUrl(item.url)) {
      bodySnippet = await fetchArticleSnippet(item.url, providerConfig).catch(() => "");
    }

    enriched.push(toNewsArticle({ item, bodySnippet, teams, now }));
  }

  for (const item of sourceItems.slice(articleFetchLimit)) {
    enriched.push(toNewsArticle({ item, bodySnippet: "", teams, now }));
  }

  const deduped = dedupeArticles(enriched.map(enrichArticleQuality));

  return {
    records: deduped,
    diagnostics
  };
}

function extractSourceItems({ source, text, teams, now }) {
  const lower = String(text || "").slice(0, 500).toLowerCase();

  if (source.type === "rss" || lower.includes("<rss") || lower.includes("<item")) {
    return extractRssItems(source, text, teams, now);
  }

  if (source.type === "atom" || lower.includes("<feed") || lower.includes("<entry")) {
    return extractAtomItems(source, text, teams, now);
  }

  return extractHtmlItems(source, text, teams, now);
}

function extractRssItems(source, xml, teams, now) {
  const items = [...String(xml || "").matchAll(/<item\b[\s\S]*?<\/item>/gi)];

  return items.map((match) => {
    const block = match[0];
    const title = decodeEntities(stripTags(extractTag(block, "title")));
    const description = decodeEntities(stripTags(extractTag(block, "description")));
    const link = absolutizeUrl(extractTag(block, "link"), source.url);
    const publishedAt = parseDate(extractTag(block, "pubDate")) || now.toISOString();

    return sourceItem({ source, title, description, url: link, publishedAt, teams });
  }).filter(Boolean);
}

function extractAtomItems(source, xml, teams, now) {
  const entries = [...String(xml || "").matchAll(/<entry\b[\s\S]*?<\/entry>/gi)];

  return entries.map((match) => {
    const block = match[0];
    const title = decodeEntities(stripTags(extractTag(block, "title")));
    const description = decodeEntities(stripTags(extractTag(block, "summary") || extractTag(block, "content")));
    const linkMatch = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
    const link = absolutizeUrl(linkMatch?.[1] || "", source.url);
    const publishedAt = parseDate(extractTag(block, "published") || extractTag(block, "updated")) || now.toISOString();

    return sourceItem({ source, title, description, url: link, publishedAt, teams });
  }).filter(Boolean);
}

function extractHtmlItems(source, html, teams, now) {
  const anchors = [...String(html || "").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const items = [];

  for (const anchor of anchors) {
    const url = absolutizeUrl(anchor[1], source.url);
    const title = decodeEntities(stripTags(anchor[2])).replace(/\s+/g, " ").trim();

    if (!title || title.length < 18 || !isHttpUrl(url)) {
      continue;
    }

    const item = sourceItem({
      source,
      title,
      description: "",
      url,
      publishedAt: now.toISOString(),
      teams
    });

    if (item) {
      items.push(item);
    }
  }

  return dedupeSourceItems(items);
}

function sourceItem({ source, title, description, url, publishedAt, teams }) {
  const text = `${title || ""} ${description || ""}`;
  const teamTags = tagTeams(text, teams);
  const worldCupRelevant = /world cup|fifa|squad|injury|lineup|football|soccer/i.test(text);

  if (!teamTags.length && !worldCupRelevant) {
    return null;
  }

  return {
    sourceName: source.name,
    sourceReliability: source.reliability,
    sourceType: source.type,
    title,
    description,
    url,
    publishedAt,
    teamTags
  };
}

function toNewsArticle({ item, bodySnippet, teams, now }) {
  const text = `${item.title || ""} ${item.description || ""} ${bodySnippet || ""}`;
  const teamTags = [...new Set([...(item.teamTags || []), ...tagTeams(text, teams)])];
  const classified = classifyArticleSignals(text, teamTags);

  return {
    id: makeId("news", [item.sourceName, item.url, item.publishedAt, item.title]),
    createdAt: now.toISOString(),
    publishedAt: item.publishedAt || now.toISOString(),
    provider: "self-gather",
    source: item.sourceName,
    url: item.url,
    title: item.title,
    description: item.description || bodySnippet.slice(0, 280),
    bodySnippet: bodySnippet.slice(0, 900),
    teamTags,
    playerTags: extractPlayerTags(text),
    sentiment: classified.sentiment,
    signals: classified.signals,
    sourceReliability: item.sourceReliability || 0.55,
    sourceType: item.sourceType
  };
}

async function fetchArticleSnippet(url, providerConfig) {
  const html = await fetchPublicText(url, providerConfig);
  const title = extractTitle(html);
  const meta = extractMetaDescription(html);
  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => decodeEntities(stripTags(match[1])).replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 40)
    .slice(0, 6)
    .join(" ");

  return [title, meta, paragraphs].filter(Boolean).join(" ");
}

async function fetchPublicText(url, providerConfig) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(providerConfig.requestTimeoutMs || 9000));

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": providerConfig.userAgent || "WorldCupMagic/0.1 research bot",
        "Accept": "text/html,application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.3"
      }
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function enrichArticleQuality(article) {
  const quality = assessNewsSource(article);
  return {
    ...article,
    sourceReliability: Math.max(Number(article.sourceReliability || 0), quality.reliability),
    sourceQuality: quality.quality,
    sourceQualityReason: quality.reason,
    acceptedSource: quality.keep
  };
}

export function classifyArticleSignals(text, teamTags = []) {
  const lower = String(text || "").toLowerCase();
  const negativeHits = countMatches(lower, ["injury", "injured", "doubt", "suspended", "setback", "illness", "fatigue", "hamstring", "knock"]);
  const positiveHits = countMatches(lower, ["fit", "returns", "boost", "settled", "confident", "training", "available", "sharp"]);
  const tacticalHits = countMatches(lower, ["press", "counter", "set piece", "shape", "system", "lineup", "formation", "wide", "midfield"]);
  const rotationHits = countMatches(lower, ["rotate", "rotation", "rest", "bench", "minutes managed"]);
  const sentiment = Math.max(-0.65, Math.min(0.65, (positiveHits * 0.16) - (negativeHits * 0.2)));

  return {
    teamTags,
    sentiment,
    signals: {
      injury: Math.min(1, negativeHits * 0.18),
      lineupClarity: Math.max(0.25, Math.min(1, 0.45 + positiveHits * 0.12 - rotationHits * 0.08)),
      tacticalFit: Math.max(0.35, Math.min(1, 0.45 + tacticalHits * 0.09)),
      morale: Math.max(0.25, Math.min(1, 0.5 + sentiment)),
      rotationRisk: Math.max(0.05, Math.min(1, 0.18 + rotationHits * 0.2 + negativeHits * 0.05))
    }
  };
}

function tagTeams(text, teams) {
  const normalized = normalizeName(text);
  return teams.filter((team) => {
    const teamName = normalizeName(team);
    return teamName && new RegExp(`(^| )${escapeRegExp(teamName)}( |$)`).test(normalized);
  });
}

function extractPlayerTags(text) {
  const matches = [...String(text || "").matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g)]
    .map((match) => match[1])
    .filter((value) => !/World Cup|FIFA|BBC Sport|The Guardian|Football RSS/.test(value));
  return [...new Set(matches)].slice(0, 12);
}

function neutralSignals() {
  return {
    injury: 0,
    lineupClarity: 0.45,
    tacticalFit: 0.45,
    morale: 0.5,
    rotationRisk: 0.18
  };
}

function countMatches(text, needles) {
  return needles.reduce((total, needle) => total + (text.includes(needle) ? 1 : 0), 0);
}

function dedupeArticles(records) {
  const byKey = new Map();

  for (const record of records) {
    byKey.set(record.url || record.id, record);
  }

  return [...byKey.values()];
}

function dedupeSourceItems(items) {
  const byKey = new Map();

  for (const item of items) {
    byKey.set(item.url || item.title, item);
  }

  return [...byKey.values()];
}

function extractTag(block, tag) {
  const match = String(block || "").match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return cleanCdata(match?.[1] || "");
}

function extractTitle(html) {
  return decodeEntities(stripTags(extractTag(html, "title"))).replace(/\s+/g, " ").trim();
}

function extractMetaDescription(html) {
  const match = String(html || "").match(/<meta\b[^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    || String(html || "").match(/<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["'](?:description|og:description)["'][^>]*>/i);

  return decodeEntities(match?.[1] || "").replace(/\s+/g, " ").trim();
}

function cleanCdata(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[/i, "")
    .replace(/\]\]>$/i, "")
    .trim();
}

function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function parseDate(value) {
  const date = new Date(decodeEntities(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function absolutizeUrl(value, baseUrl) {
  const cleaned = decodeEntities(cleanCdata(value)).trim();

  try {
    return new URL(cleaned, baseUrl).toString();
  } catch {
    return cleaned;
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
