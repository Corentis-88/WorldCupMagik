import { makeId, normalizeName } from "../utils.mjs";

export async function fetchPublicText(url, providerConfig = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(providerConfig.requestTimeoutMs || 12000));

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": providerConfig.userAgent || "WorldCupMagik/1.0 public-web gatherer",
        "Accept": "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.35"
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

export function sourceDiagnostic({ kind, source, status, records = 0, reason = "", now = new Date() }) {
  return {
    id: makeId("source", [kind, source?.name, source?.url, status, records, reason, now.toISOString()]),
    createdAt: now.toISOString(),
    kind,
    source: source?.name || "Unknown source",
    url: source?.url || "",
    status,
    records,
    reason
  };
}

export function sourceList(providerConfig, fallbackPathName) {
  if (Array.isArray(providerConfig?.sources)) {
    return providerConfig.sources;
  }

  return fallbackPathName;
}

export function extractJsonLd(html) {
  const blocks = [...String(html || "").matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const items = [];

  for (const block of blocks) {
    const raw = decodeEntities(block[1]).trim();

    try {
      const parsed = JSON.parse(raw);
      flattenJsonLd(parsed, items);
    } catch {
      // Invalid embedded JSON-LD is common on public pages; the source diagnostic
      // records the fetch, while extraction continues through text/table parsing.
    }
  }

  return items;
}

export function flattenJsonLd(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      flattenJsonLd(item, out);
    }
    return out;
  }

  if (!value || typeof value !== "object") {
    return out;
  }

  if (Array.isArray(value["@graph"])) {
    flattenJsonLd(value["@graph"], out);
  }

  if (Array.isArray(value.itemListElement)) {
    flattenJsonLd(value.itemListElement, out);
  }

  if (value.item) {
    flattenJsonLd(value.item, out);
  }

  if (Array.isArray(value.mainEntity)) {
    flattenJsonLd(value.mainEntity, out);
  }

  out.push(value);
  return out;
}

export function htmlToLines(html) {
  return decodeEntities(String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|p|li|tr|td|th|div|section|article|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function htmlToText(html) {
  return htmlToLines(html).join("\n");
}

export function extractHtmlTables(html) {
  const tables = [];
  const tableBlocks = [...String(html || "").matchAll(/<table\b[\s\S]*?<\/table>/gi)];

  for (const tableBlock of tableBlocks) {
    const rows = [];
    const rowBlocks = [...tableBlock[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)];

    for (const rowBlock of rowBlocks) {
      const cells = [...rowBlock[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((cell) => decodeEntities(stripTags(cell[1])).replace(/\s+/g, " ").trim())
        .filter(Boolean);

      if (cells.length) {
        rows.push(cells);
      }
    }

    if (rows.length) {
      tables.push(rows);
    }
  }

  return tables;
}

export function stripTags(value) {
  return String(value || "").replace(/<[^>]+>/g, " ");
}

export function decodeEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_match, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#(\d+);/g, (_match, value) => String.fromCodePoint(Number(value)));
}

export function parseDate(value, fallbackYear = new Date().getFullYear()) {
  const text = decodeEntities(value).replace(/\s+/g, " ").trim();
  const direct = new Date(text);

  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const monthMatch = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+(\d{4}))?\b/i)
    || text.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?\b/i);

  if (!monthMatch) {
    return null;
  }

  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const firstIsMonth = Number.isNaN(Number(monthMatch[1]));
  const day = Number(firstIsMonth ? monthMatch[2] : monthMatch[1]);
  const monthName = String(firstIsMonth ? monthMatch[1] : monthMatch[2]).slice(0, 3).toLowerCase();
  const year = Number(monthMatch[3] || fallbackYear);
  const month = monthNames.indexOf(monthName);

  if (!day || month < 0 || !year) {
    return null;
  }

  return new Date(Date.UTC(year, month, day, 12, 0, 0));
}

export function parseClock(value) {
  const match = String(value || "").match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)?\b/);

  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = match[3]?.toLowerCase();

  if (meridiem === "pm" && hour < 12) {
    hour += 12;
  } else if (meridiem === "am" && hour === 12) {
    hour = 0;
  }

  if (hour > 23 || minute > 59) {
    return null;
  }

  return { hour, minute };
}

export function absolutizeUrl(value, baseUrl) {
  const cleaned = decodeEntities(String(value || "")).trim();

  try {
    return new URL(cleaned, baseUrl).toString();
  } catch {
    return cleaned;
  }
}

export function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function cleanTeamName(value) {
  return decodeEntities(value)
    .replace(/\b(?:FIFA|World Cup|Group [A-Z]|Match \d+|Fixture|Result|Live|Odds|Betting|Preview|Stats)\b/gi, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "")
    .trim();
}

export function teamNameMatches(left, right) {
  const a = normalizeName(left);
  const b = normalizeName(right);

  if (!a || !b) {
    return false;
  }

  return a === b || a.includes(b) || b.includes(a);
}

export function uniqueBy(records, keyFn) {
  const byKey = new Map();

  for (const record of records) {
    const key = keyFn(record);

    if (!key) {
      continue;
    }

    if (!byKey.has(key)) {
      byKey.set(key, record);
    }
  }

  return [...byKey.values()];
}

export function toDecimalOdds(value) {
  const text = String(value || "").trim();
  const decimal = text.match(/\b(\d{1,2}\.\d{2})\b/);

  if (decimal) {
    const price = Number(decimal[1]);
    return price > 1 ? price : null;
  }

  const fraction = text.match(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b/);

  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    return denominator > 0 ? Math.round((1 + numerator / denominator) * 100) / 100 : null;
  }

  const american = text.match(/(^|[^\d])([+-]\d{3,4})\b/);

  if (american) {
    const value = Number(american[2]);

    if (value > 0) {
      return Math.round((1 + value / 100) * 100) / 100;
    }

    if (value < 0) {
      return Math.round((1 + 100 / Math.abs(value)) * 100) / 100;
    }
  }

  return null;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
