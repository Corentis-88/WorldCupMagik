export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

export function mean(values) {
  const valid = values.map(Number).filter((value) => Number.isFinite(value));
  return valid.length ? valid.reduce((total, value) => total + value, 0) / valid.length : 0;
}

export function logistic(value) {
  return 1 / (1 + Math.exp(-value));
}

export function decimalToImpliedProbability(decimalOdds) {
  const odds = Number(decimalOdds);
  return odds > 1 ? 1 / odds : 0;
}

export function product(values) {
  return values.reduce((total, value) => total * Number(value || 1), 1);
}

export function makeId(prefix, parts) {
  const text = parts.filter(Boolean).map(String).join("|");
  let hash = 0;

  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }

  return `${prefix}_${hash.toString(16)}`;
}

export function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function hoursBetween(left, right = new Date()) {
  return Math.abs(new Date(right).getTime() - new Date(left).getTime()) / 3600000;
}

export function daysBetween(left, right = new Date()) {
  return hoursBetween(left, right) / 24;
}

export function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function combinations(items, size, limit = 25000) {
  const results = [];

  function visit(start, chosen) {
    if (results.length >= limit) {
      return;
    }

    if (chosen.length === size) {
      results.push([...chosen]);
      return;
    }

    for (let index = start; index < items.length; index += 1) {
      chosen.push(items[index]);
      visit(index + 1, chosen);
      chosen.pop();
    }
  }

  visit(0, []);
  return results;
}

export function latestBy(records, keyFn, dateField = "capturedAt") {
  const byKey = new Map();

  for (const record of records) {
    const key = keyFn(record);
    const existing = byKey.get(key);

    if (!existing || new Date(record[dateField] || 0) > new Date(existing[dateField] || 0)) {
      byKey.set(key, record);
    }
  }

  return byKey;
}
