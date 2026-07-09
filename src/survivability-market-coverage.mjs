import { hoursBetween, mean, normalizeName, round } from "./utils.mjs";

export const SURVIVABILITY_MARKETS = [
  {
    key: "asian_handicap",
    label: "Asian handicap",
    family: "handicap",
    requiresLineDepth: true
  },
  {
    key: "asian_total_goals",
    label: "Asian total goals",
    family: "goals",
    requiresLineDepth: true
  },
  {
    key: "three_way_handicap",
    label: "3-way handicap",
    family: "handicap",
    requiresLineDepth: true
  },
  {
    key: "team_total_goals",
    label: "Team total goals",
    family: "goals",
    requiresLineDepth: true
  },
  {
    key: "team_to_score",
    label: "Team to score",
    family: "goals",
    requiresLineDepth: false
  },
  {
    key: "to_qualify",
    label: "To qualify",
    family: "qualification",
    requiresLineDepth: false
  },
  {
    key: "team_shots",
    label: "Team shots",
    family: "shots",
    requiresLineDepth: true
  },
  {
    key: "team_shots_on_target",
    label: "Team shots on target",
    family: "shots",
    requiresLineDepth: true
  },
  {
    key: "total_corners",
    label: "Total corners",
    family: "corners",
    requiresLineDepth: true
  },
  {
    key: "team_corners",
    label: "Team corners",
    family: "corners",
    requiresLineDepth: true
  },
  {
    key: "total_cards",
    label: "Total cards",
    family: "cards",
    requiresLineDepth: true
  },
  {
    key: "team_cards",
    label: "Team cards",
    family: "cards",
    requiresLineDepth: true
  },
  {
    key: "clean_sheet",
    label: "Clean sheet",
    family: "defence",
    requiresLineDepth: false
  },
  {
    key: "win_to_nil",
    label: "Win to nil",
    family: "defence",
    requiresLineDepth: false
  }
];

export const SURVIVABILITY_MARKET_KEYS = SURVIVABILITY_MARKETS.map((market) => market.key);

const DEFAULT_GATE = {
  enabled: true,
  maxRecordAgeHours: 72,
  minRecords: 18,
  minFixtures: 5,
  minFixtureCoverage: 0.25,
  minBookmakers: 2,
  minAverageBookmakersPerFixture: 1.2,
  minLineCount: 2
};

export function isSurvivabilityMarketRecord(record) {
  return SURVIVABILITY_MARKET_KEYS.includes(record?.market);
}

export function buildSurvivabilityMarketCoverage({
  fixtures = [],
  oddsSnapshots = [],
  policy = {},
  now = new Date()
} = {}) {
  const gate = {
    ...DEFAULT_GATE,
    ...(policy.survivabilityMarketGate || {})
  };
  const marketConfigs = configuredMarkets(gate);
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.id).filter(Boolean));
  const fixtureCount = fixtureIds.size || fixtures.length || 0;
  const relevantRecords = oddsSnapshots
    .filter(isSurvivabilityMarketRecord)
    .filter((record) => !fixtureIds.size || fixtureIds.has(record.fixtureId));
  const freshRecords = relevantRecords.filter((record) => recordAgeHours(record, now) <= Number(gate.maxRecordAgeHours));
  const markets = {};

  for (const market of marketConfigs) {
    const records = relevantRecords.filter((record) => record.market === market.key);
    const fresh = freshRecords.filter((record) => record.market === market.key);
    const fixtureGroups = groupBy(fresh, (record) => record.fixtureId || `${record.homeTeam}|${record.awayTeam}`);
    const bookmakerGroups = [...fixtureGroups.values()].map((items) => new Set(items.map((record) => normalizeName(record.bookmaker)).filter(Boolean)));
    const bookmakers = new Set(fresh.map((record) => normalizeName(record.bookmaker)).filter(Boolean));
    const lines = new Set(fresh.map((record) => lineKey(record)).filter(Boolean));
    const outcomes = new Set(fresh.map((record) => normalizeName(record.outcome)).filter(Boolean));
    const thresholds = marketThresholds(gate, market);
    const fixtureCoverage = fixtureCount ? fixtureGroups.size / fixtureCount : 0;
    const averageBookmakersPerFixture = mean(bookmakerGroups.map((group) => group.size));
    const lineDepthSatisfied = !market.requiresLineDepth || lines.size >= thresholds.minLineCount;
    const missing = [];

    if (fresh.length < thresholds.minRecords) {
      missing.push(`needs ${thresholds.minRecords - fresh.length} more fresh records`);
    }

    if (fixtureGroups.size < thresholds.minFixtures) {
      missing.push(`needs ${thresholds.minFixtures - fixtureGroups.size} more covered fixtures`);
    }

    if (fixtureCoverage < thresholds.minFixtureCoverage) {
      missing.push(`needs ${Math.ceil((thresholds.minFixtureCoverage * Math.max(1, fixtureCount)) - fixtureGroups.size)} more fixtures for coverage`);
    }

    if (bookmakers.size < thresholds.minBookmakers) {
      missing.push(`needs ${thresholds.minBookmakers - bookmakers.size} more bookmaker source(s)`);
    }

    if (averageBookmakersPerFixture < thresholds.minAverageBookmakersPerFixture) {
      missing.push("needs deeper bookmaker coverage per fixture");
    }

    if (!lineDepthSatisfied) {
      missing.push(`needs ${thresholds.minLineCount - lines.size} more distinct line(s)`);
    }

    const gateSatisfied = gate.enabled !== false && missing.length === 0;

    markets[market.key] = {
      key: market.key,
      label: market.label,
      family: market.family,
      collectOnly: true,
      gateSatisfied,
      status: gateSatisfied ? "satisfied" : "collecting",
      thresholds,
      missing,
      recordCount: records.length,
      freshRecordCount: fresh.length,
      fixtureCount: fixtureGroups.size,
      totalFixtureCount: fixtureCount,
      fixtureCoverage: round(fixtureCoverage, 3),
      bookmakerCount: bookmakers.size,
      averageBookmakersPerFixture: round(averageBookmakersPerFixture, 2),
      lineCount: lines.size,
      outcomeCount: outcomes.size,
      latestCapturedAt: latestCapturedAt(fresh),
      sampleOutcomes: sampleOutcomes(fresh)
    };
  }

  const satisfiedMarkets = Object.values(markets).filter((market) => market.gateSatisfied).map((market) => market.key);
  const totalRecords = relevantRecords.length;
  const freshRecordCount = freshRecords.length;

  return {
    createdAt: now.toISOString(),
    gateVersion: "survivability-public-web-v1",
    enabled: gate.enabled !== false,
    status: satisfiedMarkets.length ? "satisfied" : "collecting",
    collectOnly: true,
    predictionActivation: {
      enabled: false,
      reason: satisfiedMarkets.length
        ? "Coverage is sufficient for at least one market; betting logic still requires an explicit model/settlement activation step."
        : "Collecting public-web odds until the coverage gate is satisfied."
    },
    fixtureWindow: {
      fixtureCount,
      fixtureIds: [...fixtureIds].slice(0, 80)
    },
    summary: {
      marketCount: Object.keys(markets).length,
      satisfiedMarketCount: satisfiedMarkets.length,
      satisfiedMarkets,
      totalRecords,
      freshRecordCount,
      message: satisfiedMarkets.length
        ? `Coverage gate satisfied for ${satisfiedMarkets.length} collect-only market(s).`
        : "Survivability markets are being gathered and audited before betting logic can use them."
    },
    markets
  };
}

function configuredMarkets(gate) {
  const byKey = new Map(SURVIVABILITY_MARKETS.map((market) => [market.key, market]));
  const requested = Array.isArray(gate.markets) && gate.markets.length
    ? gate.markets
    : SURVIVABILITY_MARKETS;

  return requested
    .map((item) => {
      const key = typeof item === "string" ? item : item.key;
      const base = byKey.get(key);

      return base ? { ...base, ...(typeof item === "object" ? item : {}) } : null;
    })
    .filter(Boolean);
}

function marketThresholds(gate, market) {
  return {
    minRecords: Number(market.minRecords ?? gate.minRecords),
    minFixtures: Number(market.minFixtures ?? gate.minFixtures),
    minFixtureCoverage: Number(market.minFixtureCoverage ?? gate.minFixtureCoverage),
    minBookmakers: Number(market.minBookmakers ?? gate.minBookmakers),
    minAverageBookmakersPerFixture: Number(market.minAverageBookmakersPerFixture ?? gate.minAverageBookmakersPerFixture),
    minLineCount: Number(market.minLineCount ?? gate.minLineCount),
    maxRecordAgeHours: Number(gate.maxRecordAgeHours)
  };
}

function recordAgeHours(record, now) {
  if (!record?.capturedAt) {
    return Number.POSITIVE_INFINITY;
  }

  return hoursBetween(record.capturedAt, now);
}

function groupBy(items, keyFn) {
  const groups = new Map();

  for (const item of items) {
    const key = keyFn(item);

    if (!key) {
      continue;
    }

    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }

  return groups;
}

function lineKey(record) {
  const line = record.line ?? record.goalLine ?? record.handicapLine;

  if (line === undefined || line === null || line === "") {
    return "";
  }

  return `${record.market}|${record.team || ""}|${record.side || ""}|${line}`;
}

function latestCapturedAt(records) {
  return records
    .map((record) => record.capturedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
}

function sampleOutcomes(records) {
  const byOutcome = new Map();

  for (const record of records) {
    const key = `${record.fixtureId}|${record.bookmaker}|${record.outcome}`;

    if (!byOutcome.has(key)) {
      byOutcome.set(key, {
        fixtureId: record.fixtureId,
        fixture: `${record.homeTeam} v ${record.awayTeam}`,
        bookmaker: record.bookmaker,
        outcome: record.outcome,
        line: record.line,
        team: record.team,
        decimalOdds: record.decimalOdds,
        capturedAt: record.capturedAt
      });
    }

    if (byOutcome.size >= 8) {
      break;
    }
  }

  return [...byOutcome.values()];
}
