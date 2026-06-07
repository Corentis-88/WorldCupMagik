import { readJson } from "../db.mjs";
import { buildHeatImpact, calculatedHeatIndexC, heatStressFromWeather } from "../heat-model.mjs";
import { clamp, daysBetween, makeId, normalizeName, round } from "../utils.mjs";
import {
  fetchPublicText,
  htmlToLines,
  sourceDiagnostic,
  uniqueBy
} from "./public-source.mjs";

export async function fetchHeatSnapshots({ fixtures, providerConfig, now = new Date() }) {
  const result = await fetchHeatSnapshotsWithDiagnostics({ fixtures, providerConfig, now });
  return result.records;
}

export async function fetchHeatSnapshotsWithDiagnostics({ fixtures = [], providerConfig = {}, now = new Date() }) {
  const mode = providerConfig?.mode || "self-gather";

  if (mode !== "self-gather") {
    throw new Error(`Unsupported weather provider mode: ${mode}. WorldCupMagik weather uses public web pages only.`);
  }

  const sources = await loadSources(providerConfig);
  const diagnostics = [];
  const records = [];
  const fixturesBySource = groupFixturesByWeatherSource(fixtures, sources, diagnostics, now);

  for (const [sourceKey, sourceFixtures] of fixturesBySource.entries()) {
    const source = sources.find((item) => item.key === sourceKey);

    if (!source) {
      continue;
    }

    try {
      const html = await fetchPublicText(source.url, providerConfig);
      const summaries = parseWeatherForecastSummaries(html);

      if (!summaries.length) {
        diagnostics.push(sourceDiagnostic({
          kind: "weather",
          source,
          status: "empty",
          records: 0,
          reason: "Fetched public weather page but found no forecast summary periods.",
          now
        }));
        continue;
      }

      const sourceRecords = sourceFixtures
        .map((fixture) => heatSnapshotForFixture({ fixture, source, summaries, now }))
        .filter(Boolean);

      records.push(...sourceRecords);
      diagnostics.push(sourceDiagnostic({
        kind: "weather",
        source,
        status: sourceRecords.length ? "ok" : "empty",
        records: sourceRecords.length,
        reason: sourceRecords.length ? "" : "Forecast periods were present but none matched selected fixture dates.",
        now
      }));
    } catch (error) {
      diagnostics.push(sourceDiagnostic({
        kind: "weather",
        source,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
        now
      }));
    }
  }

  return {
    records: uniqueBy(records, (record) => `${record.fixtureId}|${record.source}|${record.capturedAt}`),
    diagnostics
  };
}

async function loadSources(providerConfig) {
  if (Array.isArray(providerConfig?.sources)) {
    return providerConfig.sources;
  }

  return readJson((providerConfig?.sourcesFile || "config/weather-sources.json").split(/[\\/]/), []);
}

function groupFixturesByWeatherSource(fixtures, sources, diagnostics, now) {
  const bySource = new Map();

  for (const fixture of fixtures) {
    const source = resolveWeatherSource(fixture, sources);

    if (!source) {
      diagnostics.push(sourceDiagnostic({
        kind: "weather",
        source: {
          name: `${fixture.homeTeam} vs ${fixture.awayTeam} heat resolver`,
          url: fixture.sourceUrl || ""
        },
        status: "empty",
        records: 0,
        reason: `No host-city weather source matched venue "${fixture.venue || "unknown"}".`,
        now
      }));
      continue;
    }

    const bucket = bySource.get(source.key) || [];
    bucket.push(fixture);
    bySource.set(source.key, bucket);
  }

  return bySource;
}

function resolveWeatherSource(fixture, sources) {
  const venueText = normalizeName([
    fixture.venue,
    fixture.hostCity,
    fixture.location,
    fixture.source
  ].filter(Boolean).join(" "));

  if (!venueText) {
    return null;
  }

  return sources.find((source) => {
    const aliases = [source.key, source.name, source.location, ...(source.aliases || [])]
      .map(normalizeName)
      .filter(Boolean);
    return aliases.some((alias) => venueText.includes(alias) || alias.includes(venueText));
  }) || null;
}

export function parseWeatherForecastSummaries(html) {
  const lines = htmlToLines(html);
  const summaries = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = cleanForecastText(lines[index]);
    const range = parseForecastRange(header);

    if (!range) {
      continue;
    }

    const summary = cleanForecastText(lines[index + 1]);
    const maxTempC = extractTemperature(summary, "max");
    const minTempC = extractTemperature(summary, "min");

    if (!Number.isFinite(maxTempC) && !Number.isFinite(minTempC)) {
      continue;
    }

    summaries.push({
      fromDay: range.fromDay,
      toDay: range.toDay,
      summary,
      maxTempC,
      minTempC,
      rainfallMm: extractRainfall(summary),
      humidityPct: estimateHumidity(summary),
      condition: classifyCondition(summary)
    });
  }

  return uniqueBy(summaries, (summary) => `${summary.fromDay}|${summary.toDay}|${summary.summary}`);
}

function heatSnapshotForFixture({ fixture, source, summaries, now }) {
  const daysUntil = Math.max(0, Math.floor(daysBetween(now, fixture.date)));
  const summary = summaries.find((item) => daysUntil >= item.fromDay && daysUntil <= item.toDay)
    || summaries.find((item) => daysUntil <= item.toDay)
    || summaries.at(-1);

  if (!summary) {
    return null;
  }

  const localHour = fixtureLocalHour(fixture.date, source.utcOffsetHours);
  const temperatureC = estimateKickoffTemperature(summary, localHour);
  const humidityPct = Number(source.humidityOverridePct || summary.humidityPct || source.averageHumidityPct || 58);
  const heatIndexC = calculatedHeatIndexC(temperatureC, humidityPct);
  const roofFactor = Number(source.roofFactor ?? 1);
  const heatStress = heatStressFromWeather({ temperatureC, heatIndexC, humidityPct, roofFactor });
  const confidence = forecastConfidence({ daysUntil, source, summary });
  const baseRecord = {
    id: makeId("heat", [fixture.id, source.key, now.toISOString(), summary.summary]),
    capturedAt: now.toISOString(),
    provider: "public-web",
    sourceType: "public-web",
    source: source.name,
    sourceUrl: source.url,
    fixtureId: fixture.id,
    fixtureDate: fixture.date,
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    venue: fixture.venue || source.location || "",
    location: source.location || source.name,
    condition: summary.condition,
    forecastWindow: `${summary.fromDay}-${summary.toDay} days`,
    forecastSummary: summary.summary,
    localKickoffHour: localHour,
    temperatureC: round(temperatureC, 1),
    humidityPct: round(humidityPct, 1),
    heatIndexC: round(heatIndexC, 1),
    roofFactor: round(roofFactor, 2),
    heatStress,
    confidence,
    rainfallMm: summary.rainfallMm,
    sourceReliability: Number(source.reliability || 0.62)
  };
  const impact = buildHeatImpact({ fixture, heatRecord: baseRecord });

  return {
    ...baseRecord,
    homeHeatAdaptation: impact.homeHeatAdaptation,
    awayHeatAdaptation: impact.awayHeatAdaptation,
    adaptationDifferential: impact.adaptationDifferential,
    resultEdgeAdjustment: impact.resultEdgeAdjustment,
    expectedGoalsAdjustment: impact.expectedGoalsAdjustment,
    notes: impact.notes
  };
}

function parseForecastRange(header) {
  const normalized = header.replace(/&ndash;|\u2013|\u2014/g, "-");
  const range = normalized.match(/\((\d+)\s*-\s*(\d+)\s+days\)/i);

  if (range) {
    return {
      fromDay: Number(range[1]),
      toDay: Number(range[2])
    };
  }

  if (/weather today/i.test(normalized)) {
    return { fromDay: 0, toDay: 3 };
  }

  return null;
}

function cleanForecastText(value) {
  return String(value || "")
    .replace(/&deg;/g, "deg")
    .replace(/&ndash;|\u2013|\u2014/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTemperature(summary, label) {
  const match = summary.match(new RegExp(`${label}\\s+(-?\\d+(?:\\.\\d+)?)\\s*(?:deg|\\u00b0)?\\s*C`, "i"));
  return match ? Number(match[1]) : NaN;
}

function extractRainfall(summary) {
  const match = summary.match(/total\s+(\d+(?:\.\d+)?)\s*mm/i);
  return match ? Number(match[1]) : 0;
}

function estimateHumidity(summary) {
  if (/heavy rain|thunder|storm/i.test(summary)) {
    return 78;
  }

  if (/rain|showers|drizzle/i.test(summary)) {
    return 68;
  }

  if (/dry|sunny|clear/i.test(summary)) {
    return 52;
  }

  return 60;
}

function classifyCondition(summary) {
  if (/thunder|storm/i.test(summary)) {
    return "storm";
  }

  if (/heavy rain/i.test(summary)) {
    return "heavy_rain";
  }

  if (/rain|showers|drizzle/i.test(summary)) {
    return "rain";
  }

  if (/sunny|clear/i.test(summary)) {
    return "clear";
  }

  return "mixed";
}

function fixtureLocalHour(date, utcOffsetHours = 0) {
  const value = new Date(date);

  if (Number.isNaN(value.getTime())) {
    return 14;
  }

  const hour = value.getUTCHours() + Number(utcOffsetHours || 0);
  return ((hour % 24) + 24) % 24;
}

function estimateKickoffTemperature(summary, localHour) {
  const maxTemp = Number.isFinite(summary.maxTempC) ? summary.maxTempC : summary.minTempC;
  const minTemp = Number.isFinite(summary.minTempC) ? summary.minTempC : summary.maxTempC;

  if (!Number.isFinite(maxTemp) && !Number.isFinite(minTemp)) {
    return 22;
  }

  if (localHour >= 11 && localHour <= 17) {
    return maxTemp;
  }

  if (localHour >= 18 && localHour <= 21) {
    return minTemp + (maxTemp - minTemp) * 0.62;
  }

  if (localHour >= 8 && localHour <= 10) {
    return minTemp + (maxTemp - minTemp) * 0.45;
  }

  return minTemp + (maxTemp - minTemp) * 0.22;
}

function forecastConfidence({ daysUntil, source, summary }) {
  const sourceReliability = Number(source.reliability || 0.62);
  const freshness = daysUntil <= 3 ? 0.75 : daysUntil <= 7 ? 0.62 : daysUntil <= 12 ? 0.5 : 0.42;
  const detail = summary.rainfallMm > 0 || Number.isFinite(summary.maxTempC) ? 0.08 : 0;

  return round(clamp(sourceReliability * 0.55 + freshness * 0.35 + detail, 0.24, 0.72), 4);
}
