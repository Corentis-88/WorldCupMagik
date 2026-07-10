const STANDARD_TOTAL_MARKETS = new Map([
  ["over_1_5_goals", { side: "Over", line: 1.5 }],
  ["over_2_5_goals", { side: "Over", line: 2.5 }],
  ["under_2_5_goals", { side: "Under", line: 2.5 }],
  ["under_3_5_goals", { side: "Under", line: 3.5 }],
  ["under_4_5_goals", { side: "Under", line: 4.5 }]
]);

const TWO_WAY_MARKETS = new Set([
  "both_teams_to_score",
  "draw_no_bet",
  "penalty_awarded",
  "red_card",
  "team_to_score",
  "clean_sheet",
  "win_to_nil",
  "asian_total_goals",
  "team_total_goals",
  "total_corners",
  "team_corners",
  "total_cards",
  "team_cards"
]);

const TWO_WAY_MIN_IMPLIED_SUM = 0.75;
const TWO_WAY_MAX_IMPLIED_SUM = 1.35;
const THREE_WAY_MIN_IMPLIED_SUM = 0.8;
const THREE_WAY_MAX_IMPLIED_SUM = 1.4;

export function filterOddsIntegrity(records = []) {
  const quarantined = [];
  const candidates = [];
  const bySelection = new Map();

  for (const record of records) {
    if (!validDecimalOdds(record?.decimalOdds)) {
      quarantined.push(quarantine(record, "malformed_price"));
      continue;
    }

    const key = selectionKey(record);
    const group = bySelection.get(key) || [];
    group.push(record);
    bySelection.set(key, group);
  }

  for (const group of bySelection.values()) {
    const prices = new Set(group.map((record) => Number(record.decimalOdds).toFixed(6)));

    if (prices.size > 1) {
      quarantined.push(...group.map((record) => quarantine(record, "conflicting_selection_prices")));
      continue;
    }

    candidates.push(group[0]);
    quarantined.push(...group.slice(1).map((record) => quarantine(record, "duplicate_selection")));
  }

  const rejected = new Map();
  rejectNonMonotonicStandardTotals(candidates, rejected);
  rejectImplausibleMarketSums(candidates, rejected);

  const accepted = [];
  for (const record of candidates) {
    const reasons = rejected.get(record);
    if (reasons?.size) {
      quarantined.push(quarantine(record, [...reasons].sort().join(",")));
    } else {
      accepted.push(record);
    }
  }

  return {
    accepted,
    quarantined,
    reasonCounts: countReasons(quarantined)
  };
}

function validDecimalOdds(value) {
  const price = Number(value);
  return Number.isFinite(price) && price >= 1.01 && price <= 1001;
}

function rejectNonMonotonicStandardTotals(records, rejected) {
  const groups = groupBy(records.filter((record) => STANDARD_TOTAL_MARKETS.has(record.market)), marketCaptureKey);

  for (const group of groups.values()) {
    const totals = group
      .map((record) => ({ record, ...STANDARD_TOTAL_MARKETS.get(record.market) }))
      .sort((left, right) => left.line - right.line);

    for (const side of ["Over", "Under"]) {
      const sameSide = totals.filter((item) => item.side === side);
      for (let index = 1; index < sameSide.length; index += 1) {
        const lower = sameSide[index - 1];
        const higher = sameSide[index];
        const impossible = side === "Over"
          ? Number(lower.record.decimalOdds) > Number(higher.record.decimalOdds)
          : Number(lower.record.decimalOdds) < Number(higher.record.decimalOdds);

        if (impossible) {
          reject(rejected, lower.record, "non_monotonic_total_odds");
          reject(rejected, higher.record, "non_monotonic_total_odds");
        }
      }
    }
  }
}

function rejectImplausibleMarketSums(records, rejected) {
  const threeWay = groupBy(records.filter((record) => record.market === "match_winner"), marketCaptureKey);
  for (const group of threeWay.values()) {
    if (new Set(group.map((record) => record.outcome)).size !== 3) {
      continue;
    }
    rejectGroupForImpliedSum(group, rejected, THREE_WAY_MIN_IMPLIED_SUM, THREE_WAY_MAX_IMPLIED_SUM, "implausible_three_way_implied_sum");
  }

  const twoWay = groupBy(records.filter(isTwoWayCandidate), twoWayGroupKey);
  for (const group of twoWay.values()) {
    if (!isCompleteTwoWayGroup(group)) {
      continue;
    }
    rejectGroupForImpliedSum(group, rejected, TWO_WAY_MIN_IMPLIED_SUM, TWO_WAY_MAX_IMPLIED_SUM, "implausible_two_way_implied_sum");
  }

  const standardTwoPointFive = groupBy(records.filter((record) => ["over_2_5_goals", "under_2_5_goals"].includes(record.market)), marketCaptureKey);
  for (const group of standardTwoPointFive.values()) {
    if (new Set(group.map((record) => record.market)).size === 2) {
      rejectGroupForImpliedSum(group, rejected, TWO_WAY_MIN_IMPLIED_SUM, TWO_WAY_MAX_IMPLIED_SUM, "implausible_two_way_implied_sum");
    }
  }
}

function isTwoWayCandidate(record) {
  return TWO_WAY_MARKETS.has(record.market);
}

function isCompleteTwoWayGroup(group) {
  if (group.length !== 2) {
    return false;
  }

  const outcomes = group.map((record) => String(record.outcome || "").toLowerCase());
  if (outcomes.some((outcome) => /(?:^|:\s*)(yes|no)$/.test(outcome))) {
    return outcomes.some((outcome) => /(?:^|:\s*)yes$/.test(outcome))
      && outcomes.some((outcome) => /(?:^|:\s*)no$/.test(outcome));
  }

  if (outcomes.some((outcome) => /\bover\b/.test(outcome))) {
    return outcomes.some((outcome) => /\bover\b/.test(outcome))
      && outcomes.some((outcome) => /\bunder\b/.test(outcome));
  }

  return new Set(outcomes).size === 2;
}

function rejectGroupForImpliedSum(group, rejected, minimum, maximum, reason) {
  const impliedSum = group.reduce((sum, record) => sum + (1 / Number(record.decimalOdds)), 0);
  if (impliedSum >= minimum && impliedSum <= maximum) {
    return;
  }
  for (const record of group) {
    reject(rejected, record, reason);
  }
}

function marketCaptureKey(record) {
  return [record.capturedAt, record.fixtureId, record.pricePublisher || record.source, record.bookmaker || "unattributed"].join("|");
}

function twoWayGroupKey(record) {
  return [
    marketCaptureKey(record),
    record.market,
    record.line || "",
    record.team || record.side || ""
  ].join("|");
}

function selectionKey(record) {
  return [
    marketCaptureKey(record),
    record.market,
    record.outcome,
    record.line || "",
    record.side || "",
    record.team || "",
    record.playerName || ""
  ].join("|");
}

function groupBy(records, keyFn) {
  const groups = new Map();
  for (const record of records) {
    const key = keyFn(record);
    const group = groups.get(key) || [];
    group.push(record);
    groups.set(key, group);
  }
  return groups;
}

function reject(rejected, record, reason) {
  const reasons = rejected.get(record) || new Set();
  reasons.add(reason);
  rejected.set(record, reasons);
}

function quarantine(record, reason) {
  return { record, reason };
}

function countReasons(quarantined) {
  const counts = {};
  for (const item of quarantined) {
    for (const reason of String(item.reason || "unknown").split(",")) {
      counts[reason] = (counts[reason] || 0) + 1;
    }
  }
  return counts;
}
