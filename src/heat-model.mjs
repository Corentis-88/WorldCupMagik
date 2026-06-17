import climateProfiles from "../config/team-climate-profiles.json" with { type: "json" };
import climateHistory from "../config/world-cup-climate-history.json" with { type: "json" };
import weatherSources from "../config/weather-sources.json" with { type: "json" };
import { clamp, mean, normalizeName, round } from "./utils.mjs";

const DEFAULT_PROFILE = climateProfiles.default || {
  confederation: "UNKNOWN",
  hotDry: 0.48,
  hotHumid: 0.48,
  temperate: 0.52,
  altitude: 0.46,
  confidence: 0.34
};

const CLIMATE_PROFILE_BY_TEAM = normalizedObject(climateProfiles.teams || {});
const TEAM_MEMORY_BY_TEAM = normalizedObject(climateHistory.teamMemory || {});
const CONFEDERATION_MEMORY = climateHistory.confederationMemory || {};
const WEATHER_SOURCES = Array.isArray(weatherSources) ? weatherSources : [];
const HOST_CLIMATE_BASELINES = {
  mexico_city: { temperatureC: 25.5, humidityPct: 58, confidence: 0.42 },
  guadalajara: { temperatureC: 29, humidityPct: 55, confidence: 0.42 },
  monterrey: { temperatureC: 32.5, humidityPct: 62, confidence: 0.44 },
  toronto: { temperatureC: 24, humidityPct: 58, confidence: 0.38 },
  vancouver: { temperatureC: 20.5, humidityPct: 62, confidence: 0.36 },
  los_angeles: { temperatureC: 25.5, humidityPct: 55, confidence: 0.38 },
  san_francisco_bay_area: { temperatureC: 21.5, humidityPct: 60, confidence: 0.36 },
  new_york_new_jersey: { temperatureC: 27, humidityPct: 58, confidence: 0.4 },
  boston: { temperatureC: 25.5, humidityPct: 56, confidence: 0.38 },
  houston: { temperatureC: 32, humidityPct: 70, confidence: 0.46 },
  dallas: { temperatureC: 32.5, humidityPct: 58, confidence: 0.44 },
  philadelphia: { temperatureC: 28, humidityPct: 58, confidence: 0.4 },
  atlanta: { temperatureC: 29.5, humidityPct: 64, confidence: 0.42 },
  seattle: { temperatureC: 22, humidityPct: 58, confidence: 0.36 },
  miami: { temperatureC: 30.5, humidityPct: 73, confidence: 0.48 },
  kansas_city: { temperatureC: 29, humidityPct: 60, confidence: 0.4 }
};

export function teamClimateProfile(team) {
  return CLIMATE_PROFILE_BY_TEAM.get(normalizeName(team)) || DEFAULT_PROFILE;
}

export function teamHeatAdaptation(team, climateBand = "hotMixed") {
  return climateAdaptationSignal(team, climateBand).value;
}

export function climateBandForWeather(heatRecord = {}) {
  const heatIndex = Number(heatRecord.heatIndexC ?? heatRecord.temperatureC);
  const humidity = Number(heatRecord.humidityPct);
  const place = normalizeName([heatRecord.location, heatRecord.venue].filter(Boolean).join(" "));

  if (/mexico city|guadalajara|estadio azteca|akron stadium/.test(place) && Number.isFinite(heatIndex) && heatIndex >= 24) {
    return "altitude";
  }

  if (!Number.isFinite(heatIndex) || heatIndex < 26) {
    return "temperate";
  }

  if (Number.isFinite(humidity) && humidity >= 66) {
    return "hotHumid";
  }

  if (Number.isFinite(humidity) && humidity <= 48) {
    return "hotDry";
  }

  return "hotMixed";
}

export function historicalClimateMemory(team, climateBand = "hotMixed") {
  return climateMemorySignal(team, climateBand).value;
}

export function buildHeatImpact({ fixture, heatRecord = null, homeSquadDepth = null, awaySquadDepth = null } = {}) {
  const effectiveHeatRecord = heatRecord || hostClimateFallbackRecord(fixture);

  if (!fixture || !effectiveHeatRecord) {
    return neutralHeatImpact();
  }

  if (isClimateControlledVenue(fixture, effectiveHeatRecord)) {
    return climateControlledHeatImpact(fixture, effectiveHeatRecord);
  }

  const confidence = clamp(Number(effectiveHeatRecord.confidence || 0), 0, 1);
  const heatStress = clamp(Number(effectiveHeatRecord.heatStress ?? heatStressFromWeather(effectiveHeatRecord)), 0, 1);
  const climateBand = climateBandForWeather({
    ...effectiveHeatRecord,
    venue: effectiveHeatRecord.venue || fixture.venue
  });

  if (confidence <= 0 || heatStress <= 0) {
    return {
      ...neutralHeatImpact(),
      source: effectiveHeatRecord.source || "",
      venue: effectiveHeatRecord.venue || fixture.venue || "",
      location: effectiveHeatRecord.location || "",
      temperatureC: nullableNumber(effectiveHeatRecord.temperatureC),
      heatIndexC: nullableNumber(effectiveHeatRecord.heatIndexC),
      humidityPct: nullableNumber(effectiveHeatRecord.humidityPct),
      confidence,
      climateBand,
      notes: effectiveHeatRecord.notes || "Weather found, but heat stress was neutral."
    };
  }

  const homeClimate = climateAdaptationSignal(fixture.homeTeam, climateBand);
  const awayClimate = climateAdaptationSignal(fixture.awayTeam, climateBand);
  const homeMemory = climateMemorySignal(fixture.homeTeam, climateBand);
  const awayMemory = climateMemorySignal(fixture.awayTeam, climateBand);
  const homeDepth = squadDepthSignal(homeSquadDepth);
  const awayDepth = squadDepthSignal(awaySquadDepth);
  const climateConfidence = mean([homeClimate.confidence, awayClimate.confidence, confidence]);
  const historyConfidence = mean([homeMemory.confidence, awayMemory.confidence]);
  const squadDepthConfidence = mean([homeDepth.confidence, awayDepth.confidence]);
  const adaptationDifferential = clamp((homeClimate.value - awayClimate.value) * clamp(climateConfidence, 0.35, 0.82), -0.65, 0.65);
  const historyDifferential = clamp((homeMemory.value - awayMemory.value) * clamp(historyConfidence, 0.2, 0.72), -0.12, 0.12);
  const squadDepthDifferential = clamp((homeDepth.depthScore - awayDepth.depthScore) * clamp(squadDepthConfidence, 0.2, 0.84), -0.45, 0.45);
  const combinedHeatDifferential = clamp(
    adaptationDifferential
      + historyDifferential * 0.75
      + squadDepthDifferential * 0.22,
    -0.75,
    0.75
  );
  const weightedStress = heatStress * confidence;
  const resultEdgeAdjustment = clamp(combinedHeatDifferential * weightedStress * 46, -28, 28);
  const depthCushion = clamp((mean([homeDepth.depthScore, awayDepth.depthScore]) - 0.5) * 0.06 * clamp(squadDepthConfidence, 0.2, 0.84), -0.015, 0.018);
  const expectedGoalsAdjustment = clamp((-0.15 + depthCushion) * weightedStress, -0.15, 0);
  const goalShareAdjustment = clamp(combinedHeatDifferential * weightedStress * 0.08, -0.055, 0.055);
  const bttsAdjustment = clamp((-0.025 + depthCushion * 0.12) * weightedStress, -0.025, 0);
  const drawLift = clamp(0.012 * weightedStress, 0, 0.012);

  return {
    source: effectiveHeatRecord.source || "",
    venue: effectiveHeatRecord.venue || fixture.venue || "",
    location: effectiveHeatRecord.location || "",
    temperatureC: nullableNumber(effectiveHeatRecord.temperatureC),
    heatIndexC: nullableNumber(effectiveHeatRecord.heatIndexC),
    humidityPct: nullableNumber(effectiveHeatRecord.humidityPct),
    heatStress: round(heatStress, 4),
    confidence: round(confidence, 4),
    climateBand,
    homeHeatAdaptation: round(homeClimate.value, 4),
    awayHeatAdaptation: round(awayClimate.value, 4),
    homeClimateAdaptation: round(homeClimate.value, 4),
    awayClimateAdaptation: round(awayClimate.value, 4),
    climateProfileConfidence: round(climateConfidence, 4),
    homeHistoricalHeatMemory: round(homeMemory.value, 4),
    awayHistoricalHeatMemory: round(awayMemory.value, 4),
    historicalHeatConfidence: round(historyConfidence, 4),
    homeSquadDepth: round(homeDepth.depthScore, 4),
    awaySquadDepth: round(awayDepth.depthScore, 4),
    squadDepthConfidence: round(squadDepthConfidence, 4),
    adaptationDifferential: round(adaptationDifferential, 4),
    historyDifferential: round(historyDifferential, 4),
    squadDepthDifferential: round(squadDepthDifferential, 4),
    combinedHeatDifferential: round(combinedHeatDifferential, 4),
    resultEdgeAdjustment: round(resultEdgeAdjustment, 2),
    expectedGoalsAdjustment: round(expectedGoalsAdjustment, 3),
    goalShareAdjustment: round(goalShareAdjustment, 3),
    bttsAdjustment: round(bttsAdjustment, 4),
    drawLift: round(drawLift, 4),
    notes: effectiveHeatRecord.notes || heatImpactNote({
      heatStress,
      confidence,
      climateBand,
      combinedHeatDifferential,
      adaptationDifferential,
      historyDifferential,
      squadDepthDifferential
    })
  };
}

function hostClimateFallbackRecord(fixture = {}) {
  if (!fixture) {
    return null;
  }

  const source = resolveWeatherSource(fixture);
  const baseline = source ? HOST_CLIMATE_BASELINES[source.key] : null;

  if (!source || !baseline) {
    return null;
  }

  const localHour = fixtureLocalHour(fixture.date, source.utcOffsetHours);
  const temperatureC = kickoffTemperatureBaseline(Number(baseline.temperatureC), localHour);
  const humidityPct = Number(source.averageHumidityPct || baseline.humidityPct || 58);
  const heatIndexC = calculatedHeatIndexC(temperatureC, humidityPct);
  const roofFactor = Number(source.roofFactor ?? 1);
  const heatStress = heatStressFromWeather({ temperatureC, heatIndexC, humidityPct, roofFactor });

  return {
    provider: "host-climate-fallback",
    sourceType: "host-climate-fallback",
    source: `${source.location || source.name} host-climate fallback`,
    sourceUrl: source.url || "",
    fixtureId: fixture.id || "",
    fixtureDate: fixture.date || "",
    homeTeam: fixture.homeTeam || "",
    awayTeam: fixture.awayTeam || "",
    venue: fixture.venue || source.location || "",
    location: source.location || source.name || "",
    localKickoffHour: localHour,
    temperatureC: round(temperatureC, 1),
    humidityPct: round(humidityPct, 1),
    heatIndexC: round(heatIndexC, 1),
    roofFactor: round(roofFactor, 2),
    climateControlled: Boolean(source.climateControlled),
    heatStress,
    confidence: clamp(Number(baseline.confidence || 0.38) * Number(source.reliability || 0.62) / 0.66, 0.22, 0.52),
    notes: `No fresh venue forecast yet; using low-confidence ${source.location || source.name} host-climate baseline until public weather refreshes.`
  };
}

function resolveWeatherSource(fixture = {}) {
  const venueText = normalizeName([
    fixture.venue,
    fixture.hostCity,
    fixture.location,
    fixture.source
  ].filter(Boolean).join(" "));

  if (!venueText) {
    return null;
  }

  return WEATHER_SOURCES.find((source) => {
    const aliases = [source.key, source.name, source.location, ...(source.aliases || [])]
      .map(normalizeName)
      .filter(Boolean);
    return aliases.some((alias) => venueText.includes(alias) || alias.includes(venueText));
  }) || null;
}

function fixtureLocalHour(date, utcOffsetHours = 0) {
  const parsed = new Date(date);

  if (Number.isNaN(parsed.getTime())) {
    return 15;
  }

  return (parsed.getUTCHours() + Number(utcOffsetHours || 0) + 24) % 24;
}

function kickoffTemperatureBaseline(baseTemperatureC, localHour) {
  const base = Number.isFinite(baseTemperatureC) ? baseTemperatureC : 26;
  const hour = Number(localHour);

  if (hour >= 12 && hour <= 16) {
    return base + 1.2;
  }

  if (hour >= 17 && hour <= 20) {
    return base + 0.4;
  }

  if (hour <= 7 || hour >= 22) {
    return base - 1.4;
  }

  return base;
}

export function neutralHeatImpact() {
  return {
    source: "",
    venue: "",
    location: "",
    temperatureC: null,
    heatIndexC: null,
    humidityPct: null,
    heatStress: 0,
    confidence: 0,
    climateBand: "",
    homeHeatAdaptation: null,
    awayHeatAdaptation: null,
    homeClimateAdaptation: null,
    awayClimateAdaptation: null,
    climateProfileConfidence: 0,
    homeHistoricalHeatMemory: 0,
    awayHistoricalHeatMemory: 0,
    historicalHeatConfidence: 0,
    homeSquadDepth: null,
    awaySquadDepth: null,
    squadDepthConfidence: 0,
    adaptationDifferential: 0,
    historyDifferential: 0,
    squadDepthDifferential: 0,
    combinedHeatDifferential: 0,
    resultEdgeAdjustment: 0,
    expectedGoalsAdjustment: 0,
    goalShareAdjustment: 0,
    bttsAdjustment: 0,
    drawLift: 0,
    notes: "No reliable venue weather record yet; heat is neutral."
  };
}

function climateControlledHeatImpact(fixture = {}, heatRecord = {}) {
  return {
    ...neutralHeatImpact(),
    source: heatRecord.source || "",
    venue: heatRecord.venue || fixture.venue || "",
    location: heatRecord.location || "",
    temperatureC: nullableNumber(heatRecord.temperatureC),
    heatIndexC: nullableNumber(heatRecord.heatIndexC),
    humidityPct: nullableNumber(heatRecord.humidityPct),
    confidence: clamp(Number(heatRecord.confidence || 0.72), 0, 1),
    climateBand: "climateControlled",
    notes: "Climate-controlled/retractable-roof venue; outdoor heat is not applied to match tempo."
  };
}

function isClimateControlledVenue(fixture = {}, heatRecord = {}) {
  if (heatRecord.climateControlled === true) {
    return true;
  }

  const text = normalizeName([
    fixture.venue,
    fixture.hostCity,
    fixture.location,
    heatRecord.venue,
    heatRecord.location,
    heatRecord.source
  ].filter(Boolean).join(" "));

  return /at t stadium|att stadium|dallas stadium|nrg stadium|houston stadium|mercedes benz stadium|mercedes-benz stadium|atlanta stadium/.test(text);
}

export function heatStressFromWeather({ temperatureC, heatIndexC, humidityPct, roofFactor = 1 } = {}) {
  const temp = Number(temperatureC);
  const heatIndex = Number.isFinite(Number(heatIndexC)) ? Number(heatIndexC) : calculatedHeatIndexC(temp, humidityPct);
  const humidity = Number(humidityPct);
  let stress = clamp((heatIndex - 24) / 11, 0, 1);

  if (Number.isFinite(humidity) && Number.isFinite(temp) && humidity >= 70 && temp >= 27) {
    stress += 0.08;
  }

  return round(clamp(stress * clamp(Number(roofFactor ?? 1), 0.15, 1), 0, 1), 4);
}

export function calculatedHeatIndexC(temperatureC, humidityPct) {
  const tempC = Number(temperatureC);
  const humidity = Number(humidityPct);

  if (!Number.isFinite(tempC)) {
    return 0;
  }

  if (!Number.isFinite(humidity)) {
    return round(tempC, 2);
  }

  const tempF = tempC * 9 / 5 + 32;

  if (tempF < 80 || humidity < 40) {
    return round(tempC + clamp((humidity - 55) / 100, -0.4, 1.2), 2);
  }

  const heatIndexF = -42.379
    + 2.04901523 * tempF
    + 10.14333127 * humidity
    - 0.22475541 * tempF * humidity
    - 0.00683783 * tempF * tempF
    - 0.05481717 * humidity * humidity
    + 0.00122874 * tempF * tempF * humidity
    + 0.00085282 * tempF * humidity * humidity
    - 0.00000199 * tempF * tempF * humidity * humidity;

  return round((heatIndexF - 32) * 5 / 9, 2);
}

function climateAdaptationSignal(team, climateBand) {
  const profile = teamClimateProfile(team);
  const value = climateValue(profile, climateBand);

  return {
    value: clamp(Number(value ?? DEFAULT_PROFILE.hotDry), 0.2, 0.9),
    confidence: clamp(Number(profile.confidence ?? DEFAULT_PROFILE.confidence), 0.2, 0.8),
    confederation: profile.confederation || DEFAULT_PROFILE.confederation
  };
}

function climateMemorySignal(team, climateBand) {
  const profile = teamClimateProfile(team);
  const teamMemory = TEAM_MEMORY_BY_TEAM.get(normalizeName(team));
  const confederationMemory = CONFEDERATION_MEMORY[profile.confederation] || {};
  const teamValue = climateValue(teamMemory, climateBand);
  const confederationValue = climateValue(confederationMemory, climateBand);

  if (teamValue !== null && teamValue !== undefined && Number.isFinite(Number(teamValue))) {
    return {
      value: clamp(Number(teamValue), -0.08, 0.08),
      confidence: clamp(Number(teamMemory.confidence || 0.45), 0.2, 0.75)
    };
  }

  return {
    value: clamp(Number(confederationValue || 0), -0.05, 0.05),
    confidence: clamp(Number(confederationMemory.confidence || 0.28), 0.18, 0.6)
  };
}

function climateValue(record, climateBand) {
  if (!record) {
    return null;
  }

  if (climateBand === "hotMixed") {
    return mean([record.hotDry, record.hotHumid]);
  }

  return record[climateBand];
}

function squadDepthSignal(record) {
  if (!record) {
    return {
      depthScore: 0.5,
      confidence: 0.24
    };
  }

  return {
    depthScore: clamp(Number(record.depthScore ?? record.score ?? 0.5), 0.25, 0.94),
    confidence: clamp(Number(record.confidence || 0.3), 0.2, 0.84)
  };
}

function heatImpactNote({ heatStress, confidence, climateBand, combinedHeatDifferential, adaptationDifferential, historyDifferential, squadDepthDifferential }) {
  if (heatStress < 0.25) {
    return "Venue weather is not hot enough to move the model materially.";
  }

  const direction = combinedHeatDifferential > 0.06
    ? "home side"
    : combinedHeatDifferential < -0.06
      ? "away side"
      : "neither side";

  return `Heat stress ${round(heatStress * 100, 1)}% (${climateBand}) with ${round(confidence * 100, 1)}% weather confidence; climate/history/depth edge favours ${direction}. Components: climate ${round(adaptationDifferential, 3)}, history ${round(historyDifferential, 3)}, depth ${round(squadDepthDifferential, 3)}.`;
}

function nullableNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function normalizedObject(value) {
  return new Map(Object.entries(value || {}).map(([key, item]) => [normalizeName(key), item]));
}
