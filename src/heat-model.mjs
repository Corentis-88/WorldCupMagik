import { clamp, normalizeName, round } from "./utils.mjs";

const DEFAULT_ADAPTATION = 0.48;

const TEAM_HEAT_ADAPTATION = new Map(Object.entries({
  Algeria: 0.68,
  Argentina: 0.54,
  Australia: 0.62,
  Austria: 0.36,
  Belgium: 0.36,
  "Bosnia and Herzegovina": 0.38,
  Brazil: 0.7,
  Canada: 0.34,
  "Cape Verde": 0.72,
  Colombia: 0.66,
  Croatia: 0.44,
  "Curacao": 0.76,
  Czechia: 0.36,
  "Czech Republic": 0.36,
  "DR Congo": 0.72,
  Ecuador: 0.66,
  Egypt: 0.7,
  England: 0.34,
  France: 0.44,
  Germany: 0.38,
  Ghana: 0.74,
  Haiti: 0.76,
  Iran: 0.62,
  Iraq: 0.74,
  "Ivory Coast": 0.76,
  Japan: 0.56,
  Jordan: 0.72,
  Mexico: 0.62,
  Morocco: 0.66,
  Netherlands: 0.34,
  "New Zealand": 0.42,
  Norway: 0.26,
  Panama: 0.76,
  Paraguay: 0.68,
  Portugal: 0.54,
  Qatar: 0.78,
  "Saudi Arabia": 0.8,
  Scotland: 0.3,
  Senegal: 0.76,
  "South Africa": 0.56,
  "South Korea": 0.52,
  Spain: 0.58,
  Sweden: 0.28,
  Switzerland: 0.34,
  Tunisia: 0.7,
  Turkey: 0.56,
  Turkiye: 0.56,
  USA: 0.52,
  "United States": 0.52,
  Uruguay: 0.58,
  Uzbekistan: 0.56
}).map(([team, value]) => [normalizeName(team), value]));

export function teamHeatAdaptation(team) {
  return TEAM_HEAT_ADAPTATION.get(normalizeName(team)) ?? DEFAULT_ADAPTATION;
}

export function buildHeatImpact({ fixture, heatRecord = null } = {}) {
  if (!fixture || !heatRecord) {
    return neutralHeatImpact();
  }

  const confidence = clamp(Number(heatRecord.confidence || 0), 0, 1);
  const heatStress = clamp(Number(heatRecord.heatStress ?? heatStressFromWeather(heatRecord)), 0, 1);

  if (confidence <= 0 || heatStress <= 0) {
    return {
      ...neutralHeatImpact(),
      source: heatRecord.source || "",
      venue: heatRecord.venue || fixture.venue || "",
      location: heatRecord.location || "",
      temperatureC: nullableNumber(heatRecord.temperatureC),
      heatIndexC: nullableNumber(heatRecord.heatIndexC),
      humidityPct: nullableNumber(heatRecord.humidityPct),
      confidence,
      notes: heatRecord.notes || "Weather found, but heat stress was neutral."
    };
  }

  const homeAdaptation = teamHeatAdaptation(fixture.homeTeam);
  const awayAdaptation = teamHeatAdaptation(fixture.awayTeam);
  const adaptationDifferential = clamp(homeAdaptation - awayAdaptation, -0.65, 0.65);
  const weightedStress = heatStress * confidence;
  const resultEdgeAdjustment = clamp(adaptationDifferential * weightedStress * 46, -28, 28);
  const expectedGoalsAdjustment = clamp(-0.15 * weightedStress, -0.15, 0);
  const goalShareAdjustment = clamp(adaptationDifferential * weightedStress * 0.08, -0.055, 0.055);
  const bttsAdjustment = clamp(-0.025 * weightedStress, -0.025, 0);
  const drawLift = clamp(0.012 * weightedStress, 0, 0.012);

  return {
    source: heatRecord.source || "",
    venue: heatRecord.venue || fixture.venue || "",
    location: heatRecord.location || "",
    temperatureC: nullableNumber(heatRecord.temperatureC),
    heatIndexC: nullableNumber(heatRecord.heatIndexC),
    humidityPct: nullableNumber(heatRecord.humidityPct),
    heatStress: round(heatStress, 4),
    confidence: round(confidence, 4),
    homeHeatAdaptation: round(homeAdaptation, 4),
    awayHeatAdaptation: round(awayAdaptation, 4),
    adaptationDifferential: round(adaptationDifferential, 4),
    resultEdgeAdjustment: round(resultEdgeAdjustment, 2),
    expectedGoalsAdjustment: round(expectedGoalsAdjustment, 3),
    goalShareAdjustment: round(goalShareAdjustment, 3),
    bttsAdjustment: round(bttsAdjustment, 4),
    drawLift: round(drawLift, 4),
    notes: heatRecord.notes || heatImpactNote({ heatStress, confidence, adaptationDifferential })
  };
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
    homeHeatAdaptation: null,
    awayHeatAdaptation: null,
    adaptationDifferential: 0,
    resultEdgeAdjustment: 0,
    expectedGoalsAdjustment: 0,
    goalShareAdjustment: 0,
    bttsAdjustment: 0,
    drawLift: 0,
    notes: "No reliable venue weather record yet; heat is neutral."
  };
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

function heatImpactNote({ heatStress, confidence, adaptationDifferential }) {
  if (heatStress < 0.25) {
    return "Venue weather is not hot enough to move the model materially.";
  }

  const direction = adaptationDifferential > 0.06
    ? "home side"
    : adaptationDifferential < -0.06
      ? "away side"
      : "neither side";

  return `Heat stress ${round(heatStress * 100, 1)}% with ${round(confidence * 100, 1)}% weather confidence; adaptation edge favours ${direction}.`;
}

function nullableNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}
