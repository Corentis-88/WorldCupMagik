const state = {
  data: null
};
const standardSlip = [
  ["single", "Single"],
  ["double", "Double"],
  ["trixie", "Trixie"],
  ["accumulator_3", "3-leg accumulator"],
  ["accumulator_4", "4-leg accumulator"],
  ["accumulator_5", "5-leg accumulator"],
  ["accumulator_6", "6-leg accumulator"],
  ["accumulator_8", "8-leg accumulator"]
];
const pickOfDaySlip = [
  ["single", "Single"],
  ["double", "Double"],
  ["trixie", "Trixie"],
  ["accumulator_4", "4-leg accumulator"],
  ["accumulator_8", "8-leg accumulator"]
];
const defaultGatheringSchedule = {
  automaticRunMinutesUtc: [323, 503, 683, 863, 1043, 1223, 1403],
  gatheringWindowMinutes: 5,
  gatheringMessage: "Data Gathering: Come back in 5"
};
const usageInstructions = "1. Input stake per bet 2. Choose Date From 3. Choose Date To 4. Adjust risk slider 5. We add our secret sauce and some luck, we don't just go by the bookies! Enjoy!";

const el = {
  scanStamp: document.getElementById("scanStamp"),
  gatheringNotice: document.getElementById("gatheringNotice"),
  stake: document.getElementById("stakeInput"),
  dateFrom: document.getElementById("dateFromInput"),
  dateTo: document.getElementById("dateToInput"),
  risk: document.getElementById("riskInput"),
  riskValue: document.getElementById("riskValue"),
  engineNotes: document.getElementById("engineNotes"),
  fixtureCount: document.getElementById("fixtureCount"),
  edgeCount: document.getElementById("edgeCount"),
  memoryCount: document.getElementById("memoryCount"),
  returnTotal: document.getElementById("returnTotal"),
  marketLine: document.getElementById("marketLine"),
  betslip: document.getElementById("betslipList"),
  pickOfDay: document.getElementById("pickOfDayList")
};

for (const input of [el.stake, el.dateFrom, el.dateTo, el.risk]) {
  input.addEventListener("input", render);
}

loadData();
registerServiceWorker();

async function loadData() {
  el.scanStamp.textContent = "Loading latest database...";

  try {
    const response = await fetch(`./data/latest.json?v=${Date.now()}`);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    state.data = await response.json();
    initialiseDateInputs();
    render();
  } catch (error) {
    el.scanStamp.textContent = `No generated database yet: ${error.message}`;
    el.betslip.innerHTML = `<article class="bet-card">Run <strong>npm run web:build-data</strong> locally or let GitHub Actions publish the latest database.</article>`;
  }
}

function render() {
  if (!state.data) {
    return;
  }

  const risk = Number(el.risk.value);
  const stake = Number(el.stake.value || 10);
  const riskBucket = nearest(state.data.riskBuckets, risk);
  const dateRange = selectedDateRange();
  const profile = buildRangeProfile({ data: state.data, riskBucket, dateRange });
  const gathering = automaticGatheringState(state.data);
  const stakePerBet = round(stake, 2);
  const slip = (profile?.betslip || []).map((bet) => ({
    ...bet,
    stake: stakePerBet,
    potentialReturn: recalculateReturn(bet, stakePerBet)
  }));
  const pickProfile = buildPickOfDayRangeProfile({ data: state.data, dateRange }) || null;
  const pickSlip = (pickProfile?.betslip || []).map((bet) => ({
    ...bet,
    stake: stakePerBet,
    potentialReturn: recalculateReturn(bet, stakePerBet)
  }));

  el.riskValue.textContent = risk;
  el.scanStamp.textContent = gathering.active ? gathering.message : `Latest database: ${new Date(state.data.generatedAt).toLocaleString()} | build time ${state.data.collection?.totalBuildDurationSeconds || state.data.collection?.durationSeconds || "?"}s`;
  el.gatheringNotice.hidden = !gathering.active;
  el.gatheringNotice.textContent = gathering.message;
  el.engineNotes.textContent = usageInstructions;
  el.fixtureCount.textContent = `${profile?.fixtureCount || 0} games`;
  el.edgeCount.textContent = `${profile?.eligibleLegCount || 0}`;
  el.memoryCount.textContent = `${state.data.intelligence?.teamCount || 0}`;
  el.returnTotal.textContent = money(slip.reduce((total, bet) => total + Number(bet.potentialReturn || 0), 0));
  if (el.marketLine) {
    el.marketLine.textContent = marketLine(state.data);
  }
  renderSlip(slip, profile);
  renderPickOfDay(pickSlip, pickProfile || profile);
}

function initialiseDateInputs() {
  const range = state.data?.dateRange || fallbackDateRange();

  for (const input of [el.dateFrom, el.dateTo]) {
    input.min = range.min || "";
    input.max = range.max || "";
  }

  if (!el.dateFrom.value) {
    el.dateFrom.value = range.defaultFrom || range.min || "";
  }

  if (!el.dateTo.value) {
    el.dateTo.value = range.defaultTo || range.max || el.dateFrom.value || "";
  }
}

function selectedDateRange() {
  const fallback = state.data?.dateRange || fallbackDateRange();
  let from = el.dateFrom.value || fallback.defaultFrom || fallback.min;
  let to = el.dateTo.value || fallback.defaultTo || fallback.max || from;

  if (from && to && from > to) {
    [from, to] = [to, from];
  }

  return { from, to };
}

function fallbackDateRange() {
  const today = new Date().toISOString().slice(0, 10);

  return {
    min: today,
    max: today,
    defaultFrom: today,
    defaultTo: today
  };
}

function buildRangeProfile({ data, riskBucket, dateRange }) {
  if (!data.legCandidatesByRisk) {
    const fallbackRisk = nearest(data.riskBuckets || [riskBucket], riskBucket);
    const fallbackDay = nearest(data.dayBuckets || [14], 14);
    return data.profiles?.[`d${fallbackDay}_r${fallbackRisk}`] || Object.values(data.profiles || {})[0] || null;
  }

  const fixtures = fixturesInRange(data.fixtures || [], dateRange);
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.id));
  const candidates = (data.legCandidatesByRisk[riskBucket] || [])
    .filter((leg) => fixtureIds.has(leg.fixtureId));
  const policy = { riskProfile: data.riskProfiles?.[riskBucket] || {} };
  const recommendations = buildBetRecommendations(candidates, policy);

  return {
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
    risk: riskBucket,
    dataQuality: data.collection?.dataQuality,
    fixtureCount: fixtures.length,
    eligibleLegCount: recommendations.eligibleLegCount,
    betslip: selectRangeBetslip({ recommendations, risk: riskBucket })
  };
}

function buildPickOfDayRangeProfile({ data, dateRange }) {
  const fixtures = fixturesInRange(data.fixtures || [], dateRange);
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.id));
  const candidates = (data.mostLikelyLegCandidates || [])
    .filter((leg) => fixtureIds.has(leg.fixtureId));

  return {
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
    mode: "most_likely",
    dataQuality: data.collection?.dataQuality,
    fixtureCount: fixtures.length,
    eligibleLegCount: candidates.length,
    betslip: buildMostLikelyPicks(candidates, { fixtureCount: fixtures.length })
  };
}

function fixturesInRange(fixtures, dateRange) {
  return fixtures.filter((fixture) => {
    const key = fixture.dateKey || dateKey(fixture.date);
    return key >= dateRange.from && key <= dateRange.to;
  });
}

function renderSlip(slip, profile) {
  if (!slip.length) {
    el.betslip.innerHTML = standardSlip.map(([, label]) => unavailableCard(label, profile)).join("");
    return;
  }

  const present = new Set(slip.map(categoryForBet));
  const missingCards = standardSlip
    .filter(([key]) => !present.has(key))
    .map(([, label]) => unavailableCard(label, profile));

  el.betslip.innerHTML = slip.map((bet) => `
    <article class="bet-card">
      <header>
        <span class="tag">${escapeHtml(bet.label || bet.type)}</span>
        <span class="score">${escapeHtml(confidenceLabel(bet))}</span>
      </header>
      <ul class="legs">
        ${bet.legs.map((leg) => `
          <li>
            ${escapeHtml(leg.selectionLabel)} <strong>@ ${Number(leg.decimalOdds || 0).toFixed(2)}</strong>
            <span class="leg-note">${escapeHtml(formatLegNote(leg))}</span>
          </li>
        `).join("")}
      </ul>
      <p class="why">${escapeHtml(bet.thesis || "The shared model found enough value, confidence, and fixture separation for this slip.")}</p>
      <div class="bet-meta">
        <div><span>Odds</span><strong>${Number(bet.combinedDecimalOdds || 0).toFixed(2)}</strong></div>
        <div><span>Stake</span><strong>${money(bet.stake)}</strong></div>
        <div><span>Return</span><strong>${money(bet.potentialReturn)}</strong></div>
      </div>
    </article>
  `).concat(missingCards).join("");
}

function renderPickOfDay(slip, profile) {
  if (!el.pickOfDay) {
    return;
  }

  if (!slip.length) {
    const supported = supportedPickOfDaySlip(profile);
    el.pickOfDay.innerHTML = supported.length
      ? supported.map(([, label]) => unavailableCard(label, profile, "No most-likely pick passed the current database checks yet.")).join("")
      : unavailableCard("Picks of the Day", profile, "No matches exist in this selected date range yet.");
    return;
  }

  const present = new Set(slip.map(categoryForBet));
  const missingCards = supportedPickOfDaySlip(profile)
    .filter(([key]) => !present.has(key))
    .map(([, label]) => unavailableCard(label, profile, "Not enough real data passed the most-likely checks for this supported card yet."));

  el.pickOfDay.innerHTML = slip.map((bet) => `
    <article class="bet-card pick-card">
      <header>
        <span class="tag pick-tag">${escapeHtml(bet.label || bet.type)}</span>
        <span class="score">${escapeHtml(likelihoodLabel(bet))}</span>
      </header>
      <ul class="legs">
        ${bet.legs.map((leg) => `
          <li>
            ${escapeHtml(leg.selectionLabel)} <strong>@ ${Number(leg.decimalOdds || 0).toFixed(2)}</strong>
            <span class="leg-note">${escapeHtml(formatLikelyLegNote(leg))}</span>
          </li>
        `).join("")}
      </ul>
      <p class="why">${escapeHtml(bet.thesis || "The most-likely engine ranked this by model probability, confidence, fresh odds, and positive edge.")}</p>
      <div class="bet-meta">
        <div><span>Odds</span><strong>${Number(bet.combinedDecimalOdds || 0).toFixed(2)}</strong></div>
        <div><span>Stake</span><strong>${money(bet.stake)}</strong></div>
        <div><span>Return</span><strong>${money(bet.potentialReturn)}</strong></div>
      </div>
    </article>
  `).concat(missingCards).join("");
}

function unavailableCard(label, profile, prefix = "No real-data pick passed this date/risk profile yet.") {
  const message = profile?.dataQuality?.message || state.data?.collection?.dataQuality?.message || "The database is still collecting public-web source data.";

  return `
    <article class="bet-card unavailable">
      <header>
        <span class="tag">${escapeHtml(label)}</span>
        <span class="score">waiting</span>
      </header>
      <p class="why">${escapeHtml(prefix)} ${escapeHtml(message)}</p>
    </article>
  `;
}

function supportedPickOfDaySlip(profile) {
  const fixtureCount = Number(profile?.fixtureCount || 0);

  return pickOfDaySlip.filter(([key]) => fixtureCount >= legCountForPickCategory(key));
}

function legCountForPickCategory(key) {
  if (key === "single") {
    return 1;
  }
  if (key === "double") {
    return 2;
  }
  if (key === "trixie") {
    return 3;
  }

  return Number(String(key).replace("accumulator_", "")) || 1;
}

function categoryForBet(bet) {
  if (bet.category) {
    return bet.category;
  }

  if (bet.type === "single") {
    return "single";
  }
  if (bet.type === "double") {
    return "double";
  }
  if (bet.type === "trixie") {
    return "trixie";
  }
  if (bet.type === "accumulator") {
    return `accumulator_${bet.legCount}`;
  }

  return bet.type;
}

function buildBetRecommendations(legs, policy) {
  const eligibleLegs = legs
    .filter((leg) => Number(leg.modelProbability || 0) > 0)
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  const accumulatorsByLegCount = buildAccumulatorRecommendationsByLegCount(eligibleLegs, policy);

  return {
    eligibleLegCount: eligibleLegs.length,
    singles: rankCombos(eligibleLegs.map((leg) => [leg]), "single", policy).slice(0, 12),
    doubles: rankCombos(combinations(eligibleLegs.slice(0, 30), 2, 10000), "double", policy).slice(0, 8),
    trixies: rankCombos(combinations(eligibleLegs.slice(0, 28), 3, 12000), "trixie", policy).slice(0, 8),
    accumulatorsByLegCount,
    accumulators: Object.values(accumulatorsByLegCount).flat().sort((left, right) => right.score - left.score).slice(0, 16)
  };
}

function buildAccumulatorRecommendationsByLegCount(eligibleLegs, policy) {
  const byLegCount = {};

  for (const size of [3, 4, 5, 6, 8]) {
    const pool = eligibleLegs.slice(0, accumulatorPoolSize(size));
    byLegCount[size] = rankCombos(combinations(pool, size, accumulatorCombinationLimit(size)), "accumulator", policy).slice(0, 8);
  }

  return byLegCount;
}

function accumulatorPoolSize(size) {
  if (size >= 8) {
    return 18;
  }

  if (size >= 6) {
    return 22;
  }

  return 28;
}

function accumulatorCombinationLimit(size) {
  if (size >= 8) {
    return 9000;
  }

  if (size >= 6) {
    return 10000;
  }

  return 12000;
}

function rankCombos(combos, type, policy) {
  return combos
    .map((legs) => scoreCombo(legs, type, policy))
    .filter((combo) => combo && !combo.hardBlocks.length)
    .sort((left, right) => right.score - left.score);
}

function scoreCombo(legs, type, policy) {
  const hardBlocks = [];
  const fixtureIds = new Set(legs.map((leg) => leg.fixtureId));
  const combinedDecimalOdds = product(legs.map((leg) => leg.decimalOdds));
  const combinedProbability = product(legs.map((leg) => leg.modelProbability));
  const expectedValue = combinedProbability * combinedDecimalOdds - 1;
  const averageEdge = mean(legs.map((leg) => leg.edge));
  const averageConfidence = mean(legs.map((leg) => leg.confidence));
  const riskLegs = legs.filter((leg) => ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag));
  const intelligenceConfidence = mean(legs.map((leg) => leg.components?.intelligenceConfidence || 0.45));
  const marketConfirmedLegs = legs.filter((leg) => leg.riskTag === "market_confirmed_edge");
  const contrarianLegs = legs.filter((leg) => leg.riskTag === "contrarian_value");
  const favouriteLegs = legs.filter((leg) => Number(leg.impliedProbability) >= Number(policy.riskProfile?.maxFavoriteImpliedProbability || 0.72));
  const preferred = preferredOddsRange(type, legs.length, policy);

  if (fixtureIds.size !== legs.length) {
    hardBlocks.push("same_fixture_correlation");
  }

  if (combinedDecimalOdds < preferred.min || combinedDecimalOdds > preferred.max) {
    hardBlocks.push("combined_odds_outside_policy_range");
  }

  if (combinedDecimalOdds > Number(policy.riskProfile?.maxCombinedOdds || 50)) {
    hardBlocks.push("combined_odds_above_absolute_cap");
  }

  if (type === "trixie" && riskLegs.length < Number(policy.riskProfile?.minRiskLegsForTrixie || 0)) {
    hardBlocks.push("trixie_missing_calculated_risk_leg");
  }

  if ((type === "trixie" || type === "accumulator") && favouriteLegs.length === legs.length) {
    hardBlocks.push("all_legs_are_high_implied_probability_favourites");
  }

  const oddsFit = oddsFitScore(combinedDecimalOdds, preferred.min, preferred.max);
  const diversityBonus = riskLegs.length > 0 ? Math.min(8, riskLegs.length * 3.5) : -5;
  const intelligenceBonus = clamp((intelligenceConfidence - 0.5) * 11 + marketConfirmedLegs.length * 1.5 + contrarianLegs.length * 2, -5, 10);
  const favouritePenalty = favouriteLegs.length * 4;
  const sizePenalty = type === "accumulator" ? Math.max(0, legs.length - 3) * 3 : 0;
  const score = clamp(34
    + averageEdge * 95
    + averageConfidence * 22
    + clamp(expectedValue * 8, -8, 8)
    + oddsFit * 0.8
    + diversityBonus
    + intelligenceBonus
    - favouritePenalty
    - sizePenalty, 0, 100);

  return {
    id: `${type}_${legs.map((leg) => leg.id).join("_").slice(0, 48)}`,
    type,
    legCount: legs.length,
    legs,
    combinedDecimalOdds: round(combinedDecimalOdds, 2),
    combinedProbability: round(combinedProbability, 4),
    expectedValue: round(expectedValue, 4),
    averageEdge: round(averageEdge, 4),
    averageConfidence: round(averageConfidence, 4),
    displayRating: displayConfidenceRating(legs),
    riskLegCount: riskLegs.length,
    score: round(score, 2),
    hardBlocks,
    thesis: buildComboThesis({ type, legs, combinedDecimalOdds, expectedValue, riskLegs, favouriteLegs })
  };
}

function selectRangeBetslip({ recommendations, risk }) {
  return standardSlip
    .map((category) => ({ category, combo: pickCategoryCombo(recommendations, category, risk) }))
    .filter((item) => item.combo)
    .map(({ category, combo }, index) => ({
      id: combo.id,
      rank: index + 1,
      category: category[0],
      label: category[1],
      type: combo.type,
      score: combo.score,
      legCount: combo.legCount,
      combinedDecimalOdds: combo.combinedDecimalOdds,
      combinedProbability: combo.combinedProbability,
      expectedValue: combo.expectedValue,
      averageConfidence: combo.averageConfidence,
      riskLegCount: combo.riskLegCount,
      legs: combo.legs,
      thesis: combo.thesis
    }));
}

function pickCategoryCombo(recommendations, category, risk = 50) {
  const [key] = category;

  if (key === "single") {
    return bestSingleForRisk(recommendations.singles || [], risk);
  }

  if (key === "double") {
    return bestCombo(recommendations.doubles || []);
  }

  if (key === "trixie") {
    return bestCombo(recommendations.trixies || []);
  }

  const legCount = Number(key.replace("accumulator_", ""));
  return bestCombo(recommendations.accumulatorsByLegCount?.[legCount] || []);
}

function bestSingleForRisk(combos, risk) {
  const appetite = clamp(Number(risk || 0), 0, 100) / 100;
  const targetOdds = 1.48 + appetite * 2.35;
  const targetRisk = appetite * 3;

  return [...combos].sort((left, right) => {
    return singleRiskFit(right, targetOdds, targetRisk, appetite) - singleRiskFit(left, targetOdds, targetRisk, appetite);
  })[0] || null;
}

function singleRiskFit(combo, targetOdds, targetRisk, appetite) {
  const leg = combo.legs?.[0] || {};
  const odds = Number(combo.combinedDecimalOdds || leg.decimalOdds || 1);
  const confidence = Number(combo.averageConfidence || leg.confidence || 0);
  const edge = Number(combo.averageEdge || leg.edge || 0);
  const expectedValue = Number(combo.expectedValue || 0);
  const oddsFit = Math.max(0, 1 - Math.abs(Math.log(Math.max(1.01, odds) / targetOdds)) / 0.78);
  const tagFit = Math.max(0, 1 - Math.abs(riskTagLevel(leg.riskTag) - targetRisk) / 3);
  const lowRiskStability = appetite < 0.38 && ["steady_edge", "value_favourite", "market_confirmed_edge"].includes(leg.riskTag) ? 9 : 0;
  const highRiskPrice = appetite > 0.55 && ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag) ? 6 : 0;

  return (Number(combo.score || 0) * 0.1)
    + oddsFit * 42
    + tagFit * 14
    + confidence * (30 - appetite * 8)
    + edge * (18 + appetite * 40)
    + clamp(expectedValue * 8, -6, 12) * appetite
    + lowRiskStability
    + highRiskPrice;
}

function riskTagLevel(tag) {
  if (tag === "value_favourite" || tag === "market_confirmed_edge") {
    return 0.6;
  }

  if (tag === "calculated_risk") {
    return 1.8;
  }

  if (tag === "longshot_value") {
    return 2.6;
  }

  if (tag === "contrarian_value") {
    return 3;
  }

  return 0;
}

function bestCombo(combos) {
  return [...combos].sort((left, right) => {
    const leftScore = Number(left.score || 0) + Number(left.expectedValue || 0) * 8 + Number(left.averageConfidence || 0) * 5;
    const rightScore = Number(right.score || 0) + Number(right.expectedValue || 0) * 8 + Number(right.averageConfidence || 0) * 5;
    return rightScore - leftScore;
  })[0] || null;
}

function buildMostLikelyPicks(legs, { fixtureCount = null } = {}) {
  const bestPerFixture = bestLikelyLegPerFixture(legs);
  const availableFixtureCount = Number.isFinite(Number(fixtureCount)) && Number(fixtureCount) > 0
    ? Number(fixtureCount)
    : bestPerFixture.length;

  return pickOfDaySlip
    .map(([category, label], index) => {
      const legCount = legCountForPickCategory(category);

      if (availableFixtureCount < legCount) {
        return null;
      }

      const selectedLegs = selectMostLikelyLegsForTarget({
        fixtureSeparatedLegs: bestPerFixture,
        eligibleLegs: legs,
        legCount
      });

      if (!selectedLegs.length) {
        return null;
      }

      return scoreMostLikelyCombo(selectedLegs, { category, label, type: pickTypeForCategory(category), legCount }, index + 1);
    })
    .filter(Boolean);
}

function pickTypeForCategory(category) {
  if (category === "single") {
    return "single";
  }
  if (category === "double") {
    return "double";
  }
  if (category === "trixie") {
    return "trixie";
  }

  return "accumulator";
}

function bestLikelyLegPerFixture(legs) {
  const byFixture = new Map();

  for (const leg of legs) {
    const existing = byFixture.get(leg.fixtureId);

    if (!existing || likelyLegScore(leg) > likelyLegScore(existing)) {
      byFixture.set(leg.fixtureId, leg);
    }
  }

  return [...byFixture.values()].sort((left, right) => likelyLegScore(right) - likelyLegScore(left));
}

function selectMostLikelyLegsForTarget({ fixtureSeparatedLegs, eligibleLegs, legCount }) {
  const selected = [];
  const selectedIds = new Set();

  for (const leg of fixtureSeparatedLegs) {
    if (selected.length >= legCount) {
      break;
    }

    selected.push(leg);
    selectedIds.add(leg.id);
  }

  for (const leg of eligibleLegs) {
    if (selected.length >= legCount) {
      break;
    }

    if (!selectedIds.has(leg.id)) {
      selected.push({
        ...leg,
        shortWindowFallback: selected.some((item) => item.fixtureId === leg.fixtureId)
      });
      selectedIds.add(leg.id);
    }
  }

  if (!selected.length) {
    return [];
  }

  const fillPool = [...selected];
  let repeatIndex = 1;

  while (selected.length < legCount) {
    const leg = fillPool[(repeatIndex - 1) % fillPool.length];
    selected.push({
      ...leg,
      id: `${leg.id}_short_window_repeat_${repeatIndex}`,
      shortWindowFallback: true,
      reusedSignal: true
    });
    repeatIndex += 1;
  }

  return selected;
}

function likelyLegScore(leg) {
  return likelyWinProbability(leg) * 64
    + Number(leg.confidence || 0) * 22
    + Number(leg.components?.intelligenceConfidence || 0.45) * 7
    + Number(leg.components?.oddsFreshness || 0.75) * 4
    + clamp(Number(leg.edge || 0), 0, 0.12) * 35;
}

function likelyWinProbability(leg) {
  const model = Number(leg.modelProbability || 0);
  const market = Number(leg.marketImpliedProbability || leg.impliedProbability || 0);
  const confidence = Number(leg.confidence || 0);
  const edge = Number(leg.edge || 0);

  if (!market) {
    return clamp(model, 0.03, 0.92);
  }

  const modelLiftCap = 0.16 + confidence * 0.05 + clamp(edge, 0, 0.12) * 0.5;
  const marketSaneModel = Math.min(model, market + modelLiftCap);

  return clamp((marketSaneModel * 0.82) + (model * 0.12) + (confidence * 0.06), 0.03, 0.92);
}

function scoreMostLikelyCombo(legs, target, rank) {
  const combinedDecimalOdds = product(legs.map((leg) => leg.decimalOdds));
  const combinedProbability = product(legs.map(likelyWinProbability));
  const expectedValue = combinedProbability * combinedDecimalOdds - 1;
  const averageEdge = mean(legs.map((leg) => leg.edge));
  const averageConfidence = mean(legs.map((leg) => leg.confidence));
  const uniqueFixtureCount = new Set(legs.map((leg) => leg.fixtureId)).size;
  const reusedSignalCount = legs.filter((leg) => leg.reusedSignal).length;
  const shortWindowFallback = uniqueFixtureCount < legs.length || reusedSignalCount > 0;
  const heatLegs = legs.filter((leg) => Number(leg.components?.heatConfidence || 0) > 0.18 && Number(leg.components?.heatStress || 0) > 0.2);
  const heatText = heatLegs.length ? ` Heat layer active on ${heatLegs.length} leg(s) as a capped weather nudge.` : "";

  return {
    id: `most_likely_${target.category}_${legs.map((leg) => leg.id).join("_").slice(0, 48)}`,
    rank,
    category: target.category,
    label: target.label,
    type: target.type,
    legCount: target.legCount,
    legs: legs.map((leg) => ({ ...leg, likelyProbability: round(likelyWinProbability(leg), 4) })),
    combinedDecimalOdds: round(combinedDecimalOdds, 2),
    combinedProbability: round(combinedProbability, 4),
    expectedValue: round(expectedValue, 4),
    averageEdge: round(averageEdge, 4),
    averageConfidence: round(averageConfidence, 4),
    score: round(combinedProbability * 100 + averageConfidence * 18 + clamp(averageEdge, 0, 0.12) * 55, 2),
    riskLegCount: legs.filter((leg) => ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag)).length,
    displayRating: displayConfidenceRating(legs, { likely: true }),
    shortWindowFallback,
    uniqueFixtureCount,
    reusedSignalCount,
    thesis: `${target.label} chosen by the most-likely engine, ignoring the risk slider and ranking by AI rating, confidence, fresh odds, and positive edge. Combined odds ${round(combinedDecimalOdds, 2)}.${heatText}${shortWindowFallback ? ` Short-window fallback used ${uniqueFixtureCount} fixture(s) and ${legs.length} signal(s) so this Picks of the Day card stays populated.` : ""}`
  };
}

function preferredOddsRange(type, legCount, policy) {
  const riskProfile = policy.riskProfile || {};

  if (type === "accumulator") {
    return riskProfile.preferredCombinedOdds?.accumulatorByLegCount?.[legCount]
      || riskProfile.preferredCombinedOdds?.accumulator
      || { min: 1, max: riskProfile.maxCombinedOdds || 50 };
  }

  return riskProfile.preferredCombinedOdds?.[type] || { min: 1, max: riskProfile.maxCombinedOdds || 50 };
}

function oddsFitScore(value, min, max) {
  if (value < min || value > max) {
    return -12;
  }

  const midpoint = (min + max) / 2;
  const spread = Math.max(1, (max - min) / 2);
  return 10 * (1 - Math.min(1, Math.abs(value - midpoint) / spread));
}

function buildComboThesis({ type, legs, combinedDecimalOdds, expectedValue, riskLegs, favouriteLegs }) {
  const selections = legs.map((leg) => leg.selectionLabel).join(" | ");
  const riskText = riskLegs.length
    ? `${riskLegs.length} calculated-risk/value leg(s) stop this from being a favourite-only ${type}.`
    : "No calculated-risk leg; this should only survive if the edge is exceptional.";
  const favouriteText = favouriteLegs.length ? `${favouriteLegs.length} high-implied-probability favourite leg(s).` : "No high-implied-probability favourite crowding.";
  const heatLegs = legs.filter((leg) => Number(leg.components?.heatConfidence || 0) > 0.18 && Number(leg.components?.heatStress || 0) > 0.2);
  const heatText = heatLegs.length
    ? `Heat layer active on ${heatLegs.length} leg(s), capped as a small xG/result adjustment.`
    : "Heat layer neutral or low impact on this slip.";

  return `${type} at combined odds ${round(combinedDecimalOdds, 2)} with expected value ${round(expectedValue * 100, 2)}%. ${riskText} ${favouriteText} ${heatText} Legs: ${selections}.`;
}

function nearest(values, value) {
  return values.reduce((winner, item) => Math.abs(item - value) < Math.abs(winner - value) ? item : winner, values[0]);
}

function combinations(items, size, limit = 12000) {
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

function product(values) {
  return values.reduce((total, value) => total * Number(value || 1), 1);
}

function mean(values) {
  const valid = values.map(Number).filter((value) => Number.isFinite(value));
  return valid.length ? valid.reduce((total, value) => total + value, 0) / valid.length : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function automaticGatheringState(data, now = new Date()) {
  const schedule = data?.collection?.schedule || defaultGatheringSchedule;
  const runMinutes = Array.isArray(schedule.automaticRunMinutesUtc) && schedule.automaticRunMinutesUtc.length
    ? schedule.automaticRunMinutesUtc
    : defaultGatheringSchedule.automaticRunMinutesUtc;
  const windowMinutes = Number(schedule.gatheringWindowMinutes || defaultGatheringSchedule.gatheringWindowMinutes);
  const message = schedule.gatheringMessage || defaultGatheringSchedule.gatheringMessage;
  const currentMinute = (now.getUTCHours() * 60) + now.getUTCMinutes() + (now.getUTCSeconds() / 60);
  const active = runMinutes.some((startMinute) => {
    const endMinute = startMinute + windowMinutes;

    if (endMinute < 1440) {
      return currentMinute >= startMinute && currentMinute < endMinute;
    }

    return currentMinute >= startMinute || currentMinute < (endMinute - 1440);
  });

  return { active, message };
}

function money(value) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Number(value || 0));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function formatLegNote(leg) {
  const edge = percent(leg.edge);
  const confidence = percent(leg.confidence);
  const tag = String(leg.riskTag || "edge").replace(/_/g, " ");
  const bookmaker = leg.bookmaker ? ` via ${leg.bookmaker}` : "";

  return `${tag}${bookmaker} | AI leg rating ${percent(displayLegRating(leg))} | edge ${edge} | data confidence ${confidence}`;
}

function confidenceLabel(bet) {
  return `AI rating ${percent(displayRatingForBet(bet))}`;
}

function likelihoodLabel(bet) {
  return `AI rating ${percent(displayRatingForBet(bet, { likely: true }))}`;
}

function formatLikelyLegNote(leg) {
  const confidence = percent(leg.confidence);
  const bookmaker = leg.bookmaker ? ` via ${leg.bookmaker}` : "";

  return `AI leg rating ${percent(displayLegRating(leg, { likely: true }))}${bookmaker} | data confidence ${confidence}`;
}

function displayRatingForBet(bet, options = {}) {
  if (Number.isFinite(Number(bet.displayRating)) && Number(bet.displayRating) > 0) {
    return Number(bet.displayRating);
  }

  return displayConfidenceRating(bet.legs || [], options);
}

function displayConfidenceRating(legs, { likely = false } = {}) {
  const legRatings = legs.map((leg) => displayLegRating(leg, { likely })).filter((value) => Number.isFinite(value));
  const averageLegRating = mean(legRatings);
  const confidence = mean(legs.map((leg) => leg.confidence));
  const edgeLift = clamp(mean(legs.map((leg) => leg.edge)), 0, 0.18) / 0.18;
  const rating = (averageLegRating * 0.74) + (confidence * 0.16) + (edgeLift * 0.1) + (likely ? 0.035 : 0);

  return round(clamp(rating, 0.58, likely ? 0.97 : 0.95), 4);
}

function displayLegRating(leg, { likely = false } = {}) {
  const probability = Number(likely ? (leg.likelyProbability || likelyWinProbability(leg)) : (leg.modelProbability || leg.likelyProbability || 0));
  const confidence = Number(leg.confidence || 0);
  const intelligence = Number(leg.components?.intelligenceConfidence || 0.5);
  const freshness = Number(leg.components?.oddsFreshness || 0.75);
  const edgeLift = clamp(Number(leg.edge || 0), 0, 0.18) / 0.18;
  const rawRating = (probability * 0.42) + (confidence * 0.25) + (intelligence * 0.14) + (freshness * 0.08) + (edgeLift * 0.11);
  const rating = 0.48 + (rawRating * 0.5) + (likely ? 0.025 : 0);

  return clamp(rating, 0.55, likely ? 0.97 : 0.95);
}

function marketLine(data) {
  const labels = {
    match_winner: "Match winner",
    draw_no_bet: "Draw no bet",
    anytime_scorer: "Anytime scorer",
    both_teams_to_score: "Both teams to score",
    over_2_5_goals: "Over 2.5 goals",
    under_2_5_goals: "Under 2.5 goals"
  };
  const configured = data?.markets?.configured || [];
  const observed = data?.markets?.observed || {};
  const active = configured.map((market) => labels[market] || market).join(", ");
  const scorerCount = Number(observed.anytime_scorer || 0);
  const scorerText = scorerCount ? ` Anytime scorer prices found: ${scorerCount}.` : " Anytime scorer is switched on, but current public sources have not exposed scorer prices yet.";

  return `Markets: ${active}.${scorerText}`;
}

function percent(value) {
  return `${Math.round(Number(value || 0) * 1000) / 10}%`;
}

function recalculateReturn(bet, stake) {
  if (bet.type !== "trixie" || !Array.isArray(bet.legs) || bet.legs.length !== 3) {
    return round(stake * Number(bet.combinedDecimalOdds || 0), 2);
  }

  const odds = bet.legs.map((leg) => Number(leg.decimalOdds || 1));
  const unit = stake / 4;
  return round(unit * ((odds[0] * odds[1]) + (odds[0] * odds[2]) + (odds[1] * odds[2]) + (odds[0] * odds[1] * odds[2])), 2);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") {
    return;
  }

  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
