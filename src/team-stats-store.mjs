import { normalizeName } from "./utils.mjs";

export function mergeTeamStatsRecords(existing = [], fresh = [], { now = new Date(), staleAfterDays = 35 } = {}) {
  const byTeam = new Map(existing.map((record) => [normalizeName(record.team), record]));

  for (const record of fresh) {
    const key = normalizeName(record.team);
    if (!key) {
      continue;
    }

    const previous = byTeam.get(key);
    byTeam.set(key, preferredTeamRecord(previous, record, now, staleAfterDays));
  }

  return [...byTeam.values()].sort((left, right) => String(left.team || "").localeCompare(String(right.team || "")));
}

function preferredTeamRecord(previous, fresh, now, staleAfterDays) {
  if (!previous) {
    return fresh;
  }

  const previousAgeDays = Math.max(0, (new Date(now).getTime() - new Date(previous.updatedAt || 0).getTime()) / 86400000);
  const previousQuality = recordQuality(previous);
  const freshQuality = recordQuality(fresh);

  if (freshQuality >= previousQuality - 0.04 || previousAgeDays > staleAfterDays) {
    return fresh;
  }

  return {
    ...previous,
    staleFallbackAt: new Date(now).toISOString(),
    staleFallbackReason: "fresh public-web scan had materially weaker coverage"
  };
}

function recordQuality(record = {}) {
  const matches = Math.min(20, Number(record.sourceMatchCount || record.longForm?.matchCount || 0)) / 20;
  const completeness = Number(record.statsCompleteness || 0);
  const eventQuality = Number(record.eventMetricQuality || 0);
  const realMatches = Math.min(8, Number(record.realMetricMatchCount || 0)) / 8;
  return matches * 0.42 + completeness * 0.28 + eventQuality * 0.18 + realMatches * 0.12;
}
