const state = {
  data: null,
  lineups: null,
  lineupRefreshTimer: null,
  renderFrame: null,
  profileCache: new Map(),
  pickProfileCache: new Map()
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
  automaticRunMinutesUtc: [323, 503, 683, 863, 1043, 1223, 1283, 1403],
  gatheringWindowMinutes: 5,
  gatheringMessage: "Data Gathering: Come back in 5"
};
const scorerLineupGate = {
  maxMinutesBeforeKickoff: 75,
  minMinutesBeforeKickoff: -10,
  refreshMs: 30000
};
const tournamentEndDate = "2026-07-19";

const el = {
  scanStamp: document.getElementById("scanStamp"),
  gatheringNotice: document.getElementById("gatheringNotice"),
  stake: document.getElementById("stakeInput"),
  dateFrom: document.getElementById("dateFromInput"),
  dateTo: document.getElementById("dateToInput"),
  risk: document.getElementById("riskInput"),
  riskSteps: document.querySelectorAll("[data-risk-step]"),
  riskValue: document.getElementById("riskValue"),
  fixtureCount: document.getElementById("fixtureCount"),
  edgeCount: document.getElementById("edgeCount"),
  memoryCount: document.getElementById("memoryCount"),
  returnTotal: document.getElementById("returnTotal"),
  marketLine: document.getElementById("marketLine"),
  betslip: document.getElementById("betslipList"),
  pickOfDay: document.getElementById("pickOfDayList"),
  likelyScorers: document.getElementById("likelyScorersList"),
  likelyAssists: document.getElementById("likelyAssistsList"),
  likelyPlayerShots: document.getElementById("likelyPlayerShotsList"),
  likelyShots: document.getElementById("likelyShotsList"),
  likelyKeeperSaves: document.getElementById("likelyKeeperSavesList"),
  likelyTeamShots: document.getElementById("likelyTeamShotsList"),
  likelyTeamShotsOnTarget: document.getElementById("likelyTeamShotsOnTargetList"),
  likelyCorners: document.getElementById("likelyCornersList"),
  likelyTeamCards: document.getElementById("likelyTeamCardsList"),
  likelyCleanSheets: document.getElementById("likelyCleanSheetsList"),
  likelyWinToNil: document.getElementById("likelyWinToNilList"),
  likelyCards: document.getElementById("likelyCardsList"),
  likelyPenalties: document.getElementById("likelyPenaltiesList"),
  likelyRedCards: document.getElementById("likelyRedCardsList")
};

for (const input of [el.stake, el.dateFrom, el.dateTo, el.risk]) {
  input.addEventListener("input", () => {
    if (input === el.risk) {
      el.riskValue.textContent = el.risk.value;
    }

    scheduleRender();
  });
  input.addEventListener("change", () => {
    if (input === el.risk) {
      el.riskValue.textContent = el.risk.value;
    }

    scheduleRender();
  });
}

for (const button of el.riskSteps) {
  button.addEventListener("click", () => adjustRisk(Number(button.dataset.riskStep || 0)));
}

loadData();
registerServiceWorker();

async function loadData() {
  el.scanStamp.textContent = "Loading mobile database...";

  try {
    const [database, lineups] = await Promise.all([
      fetchRequiredJson("./data/mobile-latest.json"),
      fetchOptionalJson("./data/lineups-latest.json")
    ]);

    state.data = database;
    state.lineups = lineups;
    initialiseDateInputs();
    render();
    startLineupRefresh();
  } catch (error) {
    el.scanStamp.textContent = `No mobile database yet: ${error.message}`;
    el.betslip.innerHTML = `<article class="bet-card">The mobile database is still publishing.</article>`;
  }
}

async function fetchRequiredJson(path) {
  const response = await fetch(`${path}?v=${Date.now()}`);

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function fetchOptionalJson(path) {
  try {
    const response = await fetch(`${path}?v=${Date.now()}`);
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

function startLineupRefresh() {
  if (state.lineupRefreshTimer) {
    clearInterval(state.lineupRefreshTimer);
  }

  state.lineupRefreshTimer = setInterval(refreshLineupAdjustments, scorerLineupGate.refreshMs);
}

async function refreshLineupAdjustments() {
  if (!state.data || !hasLineupSensitiveFixture()) {
    return;
  }

  const lineups = await fetchOptionalJson("./data/lineups-latest.json");

  if (!lineups || lineupFeedKey(lineups) === lineupFeedKey(state.lineups)) {
    return;
  }

  state.lineups = lineups;
  scheduleRender();
}

function lineupFeedKey(lineups) {
  return `${lineups?.generatedAt || ""}|${lineups?.lineups?.length || 0}|${lineups?.diagnostics?.length || 0}`;
}

function hasLineupSensitiveFixture() {
  return (state.data?.fixtures || []).some((fixture) => {
    const minutes = minutesUntilKickoff(fixture);
    return minutes >= -15 && minutes <= 130;
  });
}

function adjustRisk(step) {
  const min = Number(el.risk.min || 0);
  const max = Number(el.risk.max || 100);
  const next = Math.max(min, Math.min(max, Number(el.risk.value || 0) + step));

  el.risk.value = String(next);
  el.riskValue.textContent = el.risk.value;
  scheduleRender();
}

function scheduleRender() {
  if (!state.data) {
    return;
  }

  if (state.renderFrame) {
    cancelAnimationFrame(state.renderFrame);
  }

  state.renderFrame = requestAnimationFrame(() => {
    state.renderFrame = null;
    render();
  });
}

function render() {
  const risk = Number(el.risk.value);
  const riskBucket = nearest(state.data.riskBuckets || [risk], risk);
  const dateRange = selectedDateRange();
  const profile = buildRangeProfile({ data: state.data, riskBucket, dateRange });
  const pickProfile = buildPickOfDayRangeProfile({ data: state.data, dateRange }) || profile;
  const stakePerBet = round(Number(el.stake.value || 10), 2);
  const slip = recalculateSlip(profile?.betslip || [], stakePerBet);
  const pickSlip = recalculateSlip(pickProfile?.betslip || [], stakePerBet);
  const gathering = automaticGatheringState(state.data);

  el.riskValue.textContent = String(risk);
  el.scanStamp.textContent = gathering.active
    ? gathering.message
    : `Latest database: ${new Date(state.data.generatedAt).toLocaleString()} | mobile`;
  el.gatheringNotice.hidden = !gathering.active;
  el.gatheringNotice.textContent = gathering.message;
  el.fixtureCount.textContent = `${profile?.fixtureCount || 0}`;
  el.edgeCount.textContent = `${profile?.eligibleLegCount || 0}`;
  el.memoryCount.textContent = `${state.data.summary?.memoryTeamCount || 0}`;
  el.returnTotal.textContent = money(slip.reduce((total, bet) => total + Number(bet.potentialReturn || 0), 0));
  el.marketLine.textContent = marketLine(state.data);

  renderSlip(slip, profile);
  renderPickOfDay(pickSlip, pickProfile || profile);
  renderLikelyGoalscorers(todayScorerGroups());
  renderLikelyAssists(todayAssistGroups());
  renderLikelyPlayerEvents(el.likelyPlayerShots, todayPlayerEventGroups("playerShots"), "No player-shot event data is available for today yet.");
  renderLikelyPlayerEvents(el.likelyShots, todayPlayerEventGroups("playerShotsOnTarget"), "No player shots-on-target event data is available for today yet.");
  renderLikelyPlayerEvents(el.likelyKeeperSaves, todayPlayerEventGroups("goalkeeperSaves"), "No goalkeeper-save event data is available for today yet.");
  renderLikelyBinaryEvents(el.likelyTeamShots, todayBinaryEventGroups("teamShots"), "No team-shot event data is available for today yet.");
  renderLikelyBinaryEvents(el.likelyTeamShotsOnTarget, todayBinaryEventGroups("teamShotsOnTarget"), "No team-shots-on-target event data is available for today yet.");
  renderLikelyBinaryEvents(el.likelyCorners, todayBinaryEventGroups("corners"), "No corner event data is available for today yet.");
  renderLikelyBinaryEvents(el.likelyTeamCards, todayBinaryEventGroups("teamCards"), "No team-card event data is available for today yet.");
  renderLikelyBinaryEvents(el.likelyCleanSheets, todayBinaryEventGroups("cleanSheets"), "No clean-sheet event data is available for today yet.");
  renderLikelyBinaryEvents(el.likelyWinToNil, todayBinaryEventGroups("winToNil"), "No win-to-nil event data is available for today yet.");
  renderLikelyPlayerEvents(el.likelyCards, todayPlayerEventGroups("playerCards"), "No player-card event data is available for today yet.");
  renderLikelyBinaryEvents(el.likelyPenalties, todayBinaryEventGroups("penalties"), "No penalty-awarded event data is available for today yet.");
  renderLikelyBinaryEvents(el.likelyRedCards, todayBinaryEventGroups("redCards"), "No red-card event data is available for today yet.");
}

function initialiseDateInputs() {
  const range = defaultDateRange();
  const rawRange = state.data?.dateRange || {};

  for (const input of [el.dateFrom, el.dateTo]) {
    input.min = range.min || "";
    input.max = range.max || "";
  }

  if (!el.dateFrom.value || el.dateFrom.value === rawRange.defaultFrom) {
    el.dateFrom.value = range.defaultFrom || range.min || "";
  }

  if (!el.dateTo.value || el.dateTo.value === rawRange.defaultTo) {
    el.dateTo.value = range.defaultTo || range.max || el.dateFrom.value || "";
  }
}

function selectedDayBucket() {
  const range = defaultDateRange();
  const buckets = state.data?.dayBuckets || [0];
  const selected = selectedDateRange();
  const base = parseDateKey(range.defaultFrom || range.min || selected.from);
  const to = parseDateKey(selected.to || selected.from);
  const days = base && to ? Math.max(0, Math.round((to - base) / 86400000)) : 0;

  return nearest(buckets, days);
}

function selectedDateRange() {
  const fallback = defaultDateRange();
  let from = el.dateFrom.value || fallback.defaultFrom || fallback.min;
  let to = el.dateTo.value || fallback.defaultTo || fallback.max || from;

  if (from && to && from > to) {
    [from, to] = [to, from];
  }

  return { from, to };
}

function defaultDateRange(now = new Date()) {
  const dataRange = state.data?.dateRange || {};
  const today = localDateKey(now);
  const min = minDateKey([dataRange.min, today]);
  const max = maxDateKey([dataRange.max, tournamentEndDate, today]);

  return {
    min,
    max,
    defaultFrom: today,
    defaultTo: tournamentEndDate
  };
}

function buildRangeProfile({ data, riskBucket, dateRange }) {
  const cacheKey = rangeCacheKey(data, riskBucket, dateRange);

  if (state.profileCache.has(cacheKey)) {
    return state.profileCache.get(cacheKey);
  }

  if (Number(riskBucket || 0) <= 0) {
    const pickProfile = buildPickOfDayRangeProfile({ data, dateRange, slipTypes: standardSlip });
    return rememberCache(state.profileCache, cacheKey, {
      ...pickProfile,
      risk: riskBucket,
      riskProfile: data.riskProfiles?.[riskBucket] || { mode: "most_likely" }
    });
  }

  if (!data.legCandidatesByRisk || !data.riskProfiles) {
    return rememberCache(state.profileCache, cacheKey, prebuiltRangeProfile(data, riskBucket) || null);
  }

  const fixtures = fixturesInRange(data.fixtures || [], dateRange);
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.id));
  const candidates = (data.legCandidatesByRisk[riskBucket] || [])
    .filter((leg) => fixtureIds.has(leg.fixtureId));
  const betslip = buildMobileRiskBetslip({
    candidates,
    risk: Number(riskBucket || 0),
    profile: data.riskProfiles?.[riskBucket] || {}
  });

  return rememberCache(state.profileCache, cacheKey, {
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
    risk: riskBucket,
    dataQuality: data.collection?.dataQuality,
    fixtureCount: fixtures.length,
    eligibleLegCount: candidates.filter((leg) => !leg.hardBlocks?.length).length,
    betslip
  });
}

function buildPickOfDayRangeProfile({ data, dateRange, slipTypes = pickOfDaySlip }) {
  const cacheKey = rangeCacheKey(data, `pick_${slipTypes.length}`, dateRange);

  if (state.pickProfileCache.has(cacheKey)) {
    return state.pickProfileCache.get(cacheKey);
  }

  if (!data.mostLikelyLegCandidates) {
    return rememberCache(state.pickProfileCache, cacheKey, prebuiltPickProfile(data) || null);
  }

  const fixtures = fixturesInRange(data.fixtures || [], dateRange);
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.id));
  const candidates = (data.mostLikelyLegCandidates || [])
    .filter((leg) => fixtureIds.has(leg.fixtureId));

  return rememberCache(state.pickProfileCache, cacheKey, {
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
    mode: "most_likely",
    dataQuality: data.collection?.dataQuality,
    fixtureCount: fixtures.length,
    eligibleLegCount: candidates.length,
    betslip: buildMobileMostLikelyPicks(candidates, {
      fixtureCount: fixtures.length,
      slipTypes
    })
  });
}

function prebuiltRangeProfile(data, riskBucket) {
  const dayBucket = selectedDayBucket();
  return data.profiles?.[`d${dayBucket}_r${riskBucket}`] || null;
}

function prebuiltPickProfile(data) {
  const dayBucket = selectedDayBucket();
  return data.pickOfTheDay?.[`d${dayBucket}`] || null;
}

function rangeCacheKey(data, bucket, dateRange) {
  return [
    data?.generatedAt || "database",
    bucket,
    dateRange.from,
    dateRange.to
  ].join("|");
}

function rememberCache(cache, key, value) {
  cache.set(key, value);

  if (cache.size > 36) {
    cache.delete(cache.keys().next().value);
  }

  return value;
}

function fixturesInRange(fixtures, dateRange) {
  return (fixtures || []).filter((fixture) => {
    const key = fixture.dateKey || dateKey(fixture.date);
    return key >= dateRange.from && key <= dateRange.to;
  });
}

function buildMobileRiskBetslip({ candidates, risk, profile }) {
  const eligible = (candidates || [])
    .filter((leg) => !leg.hardBlocks?.length)
    .filter((leg) => Number(leg.modelProbability || 0) > 0)
    .filter((leg) => Number(leg.decimalOdds || 0) > 1)
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));

  return standardSlip
    .map(([key, label]) => {
      const legCount = legCountForKey(key);
      const type = key === "trixie" ? "trixie" : key.startsWith("accumulator_") ? "accumulator" : key;
      const selected = selectMobileLegs({
        candidates: eligible,
        legCount,
        risk,
        profile,
        type
      });

      return selected.length === legCount
        ? scoreMobileCombo({
          key,
          label,
          type,
          legs: selected,
          risk,
          shortWindowFallback: isMobileFallbackSelection(selected)
        })
        : null;
    })
    .filter(Boolean);
}

function buildMobileMostLikelyPicks(candidates, { fixtureCount, slipTypes }) {
  const eligible = (candidates || [])
    .filter((leg) => !leg.hardBlocks?.length)
    .filter((leg) => Number(leg.modelProbability || leg.likelyProbability || 0) > 0)
    .sort((left, right) => mobileMostLikelyLegScore(right, 1) - mobileMostLikelyLegScore(left, 1));

  return slipTypes
    .map(([key, label], index) => {
      const legCount = legCountForKey(key);
      const selected = selectMobileMostLikelyLegs(eligible, legCount);
      const type = key === "trixie" ? "trixie" : key.startsWith("accumulator_") ? "accumulator" : key;

      return selected.length === legCount
        ? scoreMobileCombo({
          key,
          label,
          type,
          legs: selected,
          risk: 0,
          likely: true,
          rank: index + 1,
          shortWindowFallback: isMobileFallbackSelection(selected)
        })
        : null;
    })
    .filter(Boolean);
}

function selectMobileMostLikelyLegs(candidates, legCount) {
  const selected = [];
  const selectedIds = new Set();
  const ranked = [...candidates]
    .filter((leg) => mobileMostLikelyLegAllowed(leg, selected, legCount))
    .sort((left, right) => mobileMostLikelyLegScore(right, legCount) - mobileMostLikelyLegScore(left, legCount));

  for (const leg of ranked) {
    if (selected.length >= legCount) {
      break;
    }

    if (selectedIds.has(leg.id) || selected.some((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg))) {
      continue;
    }

    if (!mobileMostLikelyLegAllowed(leg, selected, legCount)) {
      continue;
    }

    selected.push(leg);
    selectedIds.add(leg.id);
  }

  addMobileSameFixtureFallbackLegs({ selected, selectedIds, ranked, legCount, likely: true });

  return selected;
}

function selectMobileLegs({ candidates, legCount, risk, profile }) {
  const appetite = clamp(Number(risk || 0) / 100, 0, 1);
  const selected = [];
  const selectedIds = new Set();
  const pool = mobileCandidatePool(candidates, legCount, appetite, profile);
  const uniqueFixtureCount = new Set(pool.map(fixtureKeyForLeg)).size;
  const uniqueTarget = Math.min(legCount, uniqueFixtureCount);

  addMobileLegs({
    selected,
    selectedIds,
    pool,
    legCount: uniqueTarget,
    risk,
    allowSameFixture: false
  });

  addMobileLegs({
    selected,
    selectedIds,
    pool,
    legCount,
    risk,
    allowSameFixture: true
  });

  upgradeMobilePayout({ selected, selectedIds, pool, legCount, risk });

  return selected;
}

function mobileCandidatePool(candidates, legCount, appetite, profile) {
  const maxCombinedOdds = Number(profile?.maxCombinedOdds || 50);
  const perLegCombinedCap = legCount > 1 && maxCombinedOdds > 1
    ? Math.pow(maxCombinedOdds, 1 / legCount) * (1.04 + appetite * 0.42)
    : Infinity;
  const marketCap = mobileMaxLegOdds(legCount, appetite);
  const primaryCap = Math.max(1.18, Math.min(perLegCombinedCap || Infinity, marketCap));
  const sorted = [...(candidates || [])]
    .sort((left, right) => mobileLegScore(right, legCount, appetite) - mobileLegScore(left, legCount, appetite));
  const capped = sorted.filter((leg) => Number(leg.decimalOdds || 99) <= primaryCap);

  if (capped.length >= legCount) {
    return capped;
  }

  const relaxedMultiplier = legCount >= 6
    ? 1.05 + appetite * 0.45
    : 1.15 + appetite * 0.7;
  const relaxedCap = Math.max(primaryCap, marketCap * relaxedMultiplier);
  const relaxed = sorted.filter((leg) => Number(leg.decimalOdds || 99) <= relaxedCap);

  return relaxed.length >= legCount ? relaxed : sorted;
}

function addMobileLegs({ selected, selectedIds, pool, legCount, risk, allowSameFixture }) {
  const appetite = clamp(Number(risk || 0) / 100, 0, 1);

  while (selected.length < legCount) {
    const candidate = pool
      .filter((leg) => !selectedIds.has(leg.id))
      .filter((leg) => mobileCandidateAllowed(leg, selected, legCount, appetite))
      .filter((leg) => allowSameFixture || !selected.some((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg)))
      .map((leg) => ({
        leg,
        fit: mobilePortfolioFit(leg, selected, legCount, appetite)
      }))
      .sort((left, right) => right.fit - left.fit)[0]?.leg;

    if (!candidate) {
      break;
    }

    selected.push(candidate);
    selectedIds.add(candidate.id);
  }
}

function addMobileSameFixtureFallbackLegs({ selected, selectedIds, ranked, legCount, likely = false, risk = 0 }) {
  const appetite = clamp(Number(risk || 0) / 100, 0, 1);

  while (selected.length < legCount) {
    const candidate = ranked
      .filter((leg) => !selectedIds.has(leg.id))
      .filter((leg) => likely ? mobileMostLikelyLegAllowed(leg, selected, legCount) : mobileCandidateAllowed(leg, selected, legCount, appetite))
      .map((leg) => ({
        leg,
        fit: (likely ? mobileMostLikelyLegScore(leg, legCount) : mobilePortfolioFit(leg, selected, legCount, appetite))
          - (selected.some((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg)) ? 12 : 0)
      }))
      .sort((left, right) => right.fit - left.fit)[0]?.leg;

    if (!candidate) {
      break;
    }

    selected.push({
      ...candidate,
      shortWindowFallback: true
    });
    selectedIds.add(candidate.id);
  }
}

function upgradeMobilePayout({ selected, selectedIds, pool, legCount, risk }) {
  const appetite = clamp(Number(risk || 0) / 100, 0, 1);
  const edgeBlend = clamp((appetite - 0.8) / 0.2, 0, 1);

  if (edgeBlend <= 0 || selected.length < Math.min(5, legCount)) {
    return;
  }

  const maxCandidateOdds = mobileMaxLegOdds(legCount, appetite) * (legCount >= 6 ? 1.16 + edgeBlend * 0.14 : 1.45 + edgeBlend * 0.22);
  const attempts = legCount >= 8 ? 2 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let bestSwap = null;

    for (const candidate of pool) {
      if (selectedIds.has(candidate.id)) {
        continue;
      }

      if (!mobileCandidateAllowed(candidate, selected, legCount, appetite)) {
        continue;
      }

      const candidateOdds = Number(candidate.decimalOdds || 1);

      if (candidateOdds <= 1 || candidateOdds > maxCandidateOdds) {
        continue;
      }

      for (let index = 0; index < selected.length; index += 1) {
        const outgoing = selected[index];
        const outgoingOdds = Number(outgoing.decimalOdds || 1);
        const sameFixtureSwap = fixtureKeyForLeg(candidate) === fixtureKeyForLeg(outgoing);

        if (legCount >= 6 && !sameFixtureSwap) {
          continue;
        }

        if (candidateOdds < outgoingOdds * (1.08 + (1 - edgeBlend) * 0.08)) {
          continue;
        }

        const fit = (candidateOdds / outgoingOdds - 1) * 100
          + mobileLegScore(candidate, legCount, appetite)
          - mobileLegScore(outgoing, legCount, appetite);

        if (!bestSwap || fit > bestSwap.fit) {
          bestSwap = { candidate, outgoing, index, fit };
        }
      }
    }

    if (!bestSwap) {
      break;
    }

    selected[bestSwap.index] = bestSwap.candidate;
    selectedIds.delete(bestSwap.outgoing.id);
    selectedIds.add(bestSwap.candidate.id);
  }
}

function scoreMobileCombo({ key, label, type, legs, risk, likely = false, rank = null, shortWindowFallback = false }) {
  const legCount = legs.length;
  const probabilities = legs.map((leg) => mobileLikelyWinProbability(leg, { legCount }));
  const appetite = clamp(Number(risk || 0) / 100, 0, 1);
  const uncappedCombinedDecimalOdds = product(legs.map((leg) => leg.decimalOdds));
  const uniqueFixtureCount = new Set(legs.map(fixtureKeyForLeg)).size;
  const fallbackCombinedOddsCap = shortWindowFallback
    ? mobileFallbackCombinedOddsCap(legCount, appetite, uniqueFixtureCount)
    : Infinity;
  const combinedDecimalOdds = Math.min(uncappedCombinedDecimalOdds, fallbackCombinedOddsCap);
  const oddsCapped = uncappedCombinedDecimalOdds > combinedDecimalOdds + 0.005;
  const combinedProbability = product(likely ? probabilities : legs.map((leg) => leg.modelProbability || mobileLikelyWinProbability(leg, { legCount })));
  const survivalCombinedProbability = product(probabilities);
  const averageSurvivalProbability = mean(probabilities);
  const averageConfidence = mean(legs.map((leg) => leg.confidence));
  const averageEdge = mean(legs.map((leg) => leg.edge));
  const averageIndependentEdge = mean(legs.map((leg) => leg.independentEdge ?? leg.edge));
  const averageNonMarketSignalCount = mean(legs.map((leg) => leg.components?.nonMarketSignalCount || 0));
  const averagePerformancePenalty = mean(legs.map((leg) => Number(leg.components?.bettingPerformanceScorePenalty || 0) + (leg.components?.priceGone ? 8 : 0)));
  const expectedValue = combinedProbability * combinedDecimalOdds - 1;
  const riskLegCount = legs.filter((leg) => ["calculated_risk", "longshot_value", "contrarian_value"].includes(leg.riskTag)).length;
  const bttsLegCount = legs.filter(isBttsYesLeg).length;
  const scorerLegCount = legs.filter(isScorerLeg).length;
  const firstScorerLegCount = legs.filter((leg) => leg.market === "first_goalscorer").length;
  const reusedSignalCount = legs.filter((leg) => leg.reusedSignal).length;
  const fragileLegCount = legs.filter((leg) => mobilePortfolioLegPenalty(leg, legCount, appetite) >= 0.025).length;
  const fallbackRatingPenalty = shortWindowFallback
    ? mobileFallbackDisplayPenalty({ legs, legCount, reusedSignalCount, fragileLegCount })
    : 0;
  const scorerOverage = Math.max(0, scorerLegCount - maxMobileScorerLegs(legCount, appetite));
  const firstScorerOverage = Math.max(0, firstScorerLegCount - maxMobileFirstScorerLegs(legCount, appetite));
  const score = clamp(
    survivalCombinedProbability * (type === "single" ? 70 : type === "double" ? 90 : 130)
      + averageSurvivalProbability * 34
      + averageConfidence * 18
      + averageIndependentEdge * (24 + Number(risk || 0) * 0.22)
      + Math.min(8, Math.max(-4, expectedValue * 4))
      - fallbackRatingPenalty * 45
      - scorerOverage * 4
      - firstScorerOverage * 5
      - averagePerformancePenalty,
    0,
    100
  );

  return {
    id: `mobile_${key}_${legs.map((leg) => leg.id).join("_").slice(0, 42)}`,
    rank,
    category: key,
    label,
    type,
    score: round(score, 2),
    legCount,
    combinedDecimalOdds: round(combinedDecimalOdds, 2),
    uncappedCombinedDecimalOdds: oddsCapped ? round(uncappedCombinedDecimalOdds, 2) : undefined,
    fallbackCombinedOddsCap: oddsCapped ? round(fallbackCombinedOddsCap, 2) : undefined,
    combinedProbability: round(combinedProbability, 4),
    expectedValue: round(expectedValue, 4),
    averageConfidence: round(averageConfidence, 4),
    averageIndependentEdge: round(averageIndependentEdge, 4),
    survivalCombinedProbability: round(survivalCombinedProbability, 4),
    averageSurvivalProbability: round(averageSurvivalProbability, 4),
    averageNonMarketSignalCount: round(averageNonMarketSignalCount, 2),
    displayRating: round(clamp(
      mobileDisplayRating(legs, { likely })
        - fallbackRatingPenalty
        - scorerOverage * 0.025
        - firstScorerOverage * 0.03,
      0.28,
      likely ? 0.97 : 0.95
    ), 4),
    riskLegCount,
    bttsLegCount,
    scorerLegCount,
    firstScorerLegCount,
    fragileLegCount,
    reusedSignalCount,
    shortWindowFallback,
    legs,
    thesis: mobileComboThesis({
      type,
      legs,
      combinedDecimalOdds,
      uncappedCombinedDecimalOdds,
      oddsCapped,
      expectedValue,
      averageIndependentEdge,
      averageNonMarketSignalCount,
      survivalCombinedProbability,
      averageSurvivalProbability,
      riskLegCount,
      bttsLegCount,
      fragileLegCount,
      shortWindowFallback
    })
  };
}

function mobileComboThesis({ type, legs, combinedDecimalOdds, uncappedCombinedDecimalOdds, oddsCapped = false, expectedValue, averageIndependentEdge, averageNonMarketSignalCount, survivalCombinedProbability, averageSurvivalProbability, riskLegCount, bttsLegCount, fragileLegCount, shortWindowFallback }) {
  const uniqueFixtureCount = new Set(legs.map(fixtureKeyForLeg)).size;
  const reusedSignalCount = legs.filter((leg) => leg.reusedSignal).length;
  const oddsCapText = oddsCapped
    ? ` Displayed fallback odds are capped from raw ${round(uncappedCombinedDecimalOdds, 2)} to ${round(combinedDecimalOdds, 2)} so same-day signals cannot overstate the take-home.`
    : "";
  const fallbackText = shortWindowFallback
    ? `Short-window fallback active: ${uniqueFixtureCount} distinct fixture(s) for ${legs.length} unique leg(s), so the card stays populated with real candidates without repeating exact legs.${oddsCapText} `
    : "";
  const heatCount = legs.filter((leg) => Number(leg.components?.heatConfidence || 0) > 0.18 && Number(leg.components?.heatStress || 0) > 0.2).length;
  const heatText = heatCount ? `Heat layer active on ${heatCount} leg(s). ` : "";
  const selections = legs.map((leg) => leg.selectionLabel).join(" | ");

  return `${type} at combined odds ${round(combinedDecimalOdds, 2)} with estimated slip chance ${round(survivalCombinedProbability * 100, 2)}% and average leg survival ${round(averageSurvivalProbability * 100, 1)}%. ${fallbackText}Expected value is ${round(expectedValue * 100, 2)}%, independent edge averages ${round(averageIndependentEdge * 100, 2)}%, and the model has ${round(averageNonMarketSignalCount, 1)} non-market signals per leg. ${legs.length >= 4 ? `Long-slip controls: ${bttsLegCount} BTTS leg(s), ${fragileLegCount} fragile-value leg(s). ` : ""}${riskLegCount} calculated-risk/value leg(s). ${heatText}Legs: ${selections}.`;
}

function mobileLegScore(leg, legCount, appetite) {
  const probability = mobileLikelyWinProbability(leg, { legCount });
  const confidence = Number(leg.confidence || 0);
  const edge = Number(leg.edge || 0);
  const independentEdge = Number(leg.independentEdge ?? edge);
  const odds = Number(leg.decimalOdds || 1);
  const signalScore = clamp(Number(leg.components?.nonMarketSignalCount || 0) / 4, 0, 1);
  const intelligence = Number(leg.components?.intelligenceConfidence || 0.45);
  const performancePenalty = Number(leg.components?.bettingPerformanceScorePenalty || 0) + (leg.components?.priceGone ? 8 : 0);
  const targetOdds = mobileTargetLegOdds(legCount, appetite);
  const oddsFit = clamp(1 - Math.abs(Math.log(Math.max(1.01, odds) / targetOdds)) / 1.1, 0, 1);
  const edgeBlend = clamp((appetite - 0.8) / 0.2, 0, 1);
  const maxSurvivalOdds = mobileMaxLegOdds(legCount, appetite);
  const cappedPriceLift = clamp(Math.log(Math.max(1.01, Math.min(odds, maxSurvivalOdds * 1.4))), 0, 2.2);
  const longPricePenalty = Math.max(0, odds - maxSurvivalOdds)
    * (legCount >= 8 ? 9 : legCount >= 6 ? 6.8 : legCount >= 4 ? 4.2 : 1.8)
    * (1 - appetite * 0.28 - edgeBlend * 0.24);

  return probability * (78 - appetite * 30)
    + confidence * (18 - appetite * 2)
    + intelligence * 7
    + signalScore * 5
    + clamp(edge, -0.03, 0.24) * (22 + appetite * 44 + edgeBlend * 20)
    + clamp(independentEdge, -0.04, 0.26) * (28 + appetite * 54 + edgeBlend * 24)
    + oddsFit * (12 + appetite * 6)
    + cappedPriceLift * ((4 + appetite * 22) * (1 - mobileSurvivalPressure(legCount) * 0.72))
    - longPricePenalty
    - mobileMarketOnlySurvivalPenalty(leg) * 72
    - mobilePortfolioLegPenalty(leg, legCount, appetite) * 55
    - performancePenalty;
}

function mobileMostLikelyLegScore(leg, legCount) {
  const probability = mobileLikelyWinProbability(leg, { legCount });
  const confidence = Number(leg.confidence || 0);
  const edge = Number(leg.edge || 0);
  const independentEdge = Number(leg.independentEdge ?? edge);
  const signalScore = clamp(Number(leg.components?.nonMarketSignalCount || 0) / 4, 0, 1);

  return probability * 92
    + confidence * 24
    + signalScore * 6
    + clamp(edge, 0, 0.12) * 18
    + clamp(independentEdge, -0.03, 0.12) * 24
    - mobileMarketOnlySurvivalPenalty(leg) * 82
    - mobilePortfolioLegPenalty(leg, legCount, 0) * 48;
}

function mobilePortfolioFit(leg, selected, legCount, appetite) {
  const repeatedFixture = selected.some((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg)) ? 1 : 0;
  const sameMarketCount = selected.filter((item) => item.market === leg.market).length;
  const scorerRepeat = isScorerLeg(leg) && selected.some(isScorerLeg) ? 1 : 0;
  const scorerOverage = isScorerLeg(leg) && selected.filter(isScorerLeg).length >= maxMobileScorerLegs(legCount, appetite) ? 1 : 0;
  const firstScorerOverage = leg.market === "first_goalscorer" && selected.filter((item) => item.market === "first_goalscorer").length >= maxMobileFirstScorerLegs(legCount, appetite) ? 1 : 0;
  const goalsRepeat = isTotalGoalsLeg(leg) && selected.some(isTotalGoalsLeg) ? 1 : 0;

  return mobileLegScore(leg, legCount, appetite)
    - repeatedFixture * (18 - appetite * 7)
    - Math.max(0, sameMarketCount - 1) * (7 - appetite * 2.5)
    - scorerRepeat * (5 - appetite * 1.5)
    - scorerOverage * 18
    - firstScorerOverage * 24
    - goalsRepeat * (3.5 - appetite);
}

function mobileLikelyWinProbability(leg, { legCount = 1 } = {}) {
  const model = Number(leg.modelProbability || leg.likelyProbability || 0);
  const rawModel = Number(leg.rawModelProbability || model);
  const market = Number(leg.marketImpliedProbability || leg.impliedProbability || 0);
  const confidence = Number(leg.confidence || 0);
  const independentEdge = Number(leg.independentEdge ?? (rawModel - market));
  const signalScore = clamp(Number(leg.components?.nonMarketSignalCount || 0) / 4, 0, 1);
  const pressure = mobileSurvivalPressure(legCount);

  if (!market) {
    return clamp(model * (0.68 - pressure * 0.1) + rawModel * (0.24 - pressure * 0.06) + confidence * (0.08 + pressure * 0.16), 0.03, 0.92);
  }

  const modelLiftCap = 0.1
    - pressure * 0.032
    + confidence * (0.035 - pressure * 0.012)
    + clamp(independentEdge, 0, 0.1) * (0.42 - pressure * 0.27)
    + signalScore * (0.025 - pressure * 0.011);
  const marketSaneModel = Math.min(model, market + modelLiftCap);
  const modelWeight = 0.55 - pressure * 0.15;
  const rawWeight = 0.25 - pressure * 0.09;
  const marketWeight = 0.1 + pressure * 0.24;
  const confidenceWeight = 1 - modelWeight - rawWeight - marketWeight;

  return clamp(
    marketSaneModel * modelWeight
      + rawModel * rawWeight
      + market * marketWeight
      + confidence * confidenceWeight
      - mobileMarketOnlySurvivalPenalty(leg)
      - mobilePortfolioLegPenalty(leg, legCount, 0),
    0.03,
    0.92
  );
}

function mobilePortfolioLegPenalty(leg, legCount, appetite) {
  const pressure = mobileSurvivalPressure(legCount);
  const decimalOdds = Number(leg.decimalOdds || 1);
  let penalty = 0;

  if (isScorerLeg(leg) && legCount >= 3) {
    penalty += (0.018 + pressure * 0.028) * (1 - appetite * 0.25);

    const starter = Number(leg.components?.starterLikelihood ?? 0.5);
    const projectedMinutes = Number(leg.components?.projectedMinutes ?? 58);
    const goalsPerTwenty = Number(leg.components?.scorerGoalsPerTwentyTeamMatches ?? 0);
    const scorerConfidence = Number(leg.components?.scorerConfidence ?? 0.45);
    const assistsPerTwenty = Number(leg.components?.assistsPerTwentyTeamMatches ?? 0);
    const assistConfidence = Number(leg.components?.assistConfidence ?? 0);
    const creativeRoleScore = Number(leg.components?.creativeRoleScore ?? 0);

    if (starter < 0.64) {
      penalty += (0.64 - starter) * 0.08;
    }
    if (projectedMinutes < 65) {
      penalty += (65 - projectedMinutes) * 0.0025;
    }
    if (leg.market === "anytime_assist") {
      if (assistsPerTwenty < 1.8) {
        penalty += (1.8 - assistsPerTwenty) * 0.014;
      }
      if (assistConfidence < 0.6) {
        penalty += (0.6 - assistConfidence) * 0.07;
      }
      if (creativeRoleScore < 0.56) {
        penalty += (0.56 - creativeRoleScore) * 0.06;
      }
    } else if (goalsPerTwenty < 3) {
      penalty += (3 - goalsPerTwenty) * 0.012;
    }
    if (leg.market !== "anytime_assist" && scorerConfidence < 0.58) {
      penalty += (0.58 - scorerConfidence) * 0.07;
    }
  }

  if (isBttsYesLeg(leg) && fragileBttsHistory(leg)) {
    penalty += (0.018 + pressure * 0.032) * (1 - appetite * 0.35);
  }

  const longPriceLine = 2.5 + appetite * 1.2;
  if (legCount >= 4 && decimalOdds > longPriceLine) {
    penalty += Math.min(0.045, (decimalOdds - longPriceLine) * 0.03) * (1 - appetite * 0.3);
  }

  penalty += mobileMarketOnlySurvivalPenalty(leg) * (0.7 + pressure * 0.45);

  return clamp(penalty * (1 - appetite * 0.35), 0, 0.16);
}

function mobileCandidateAllowed(leg, selected, legCount, appetite) {
  if (!mobileFallbackLegOddsAllowed(leg, legCount, appetite)) {
    return false;
  }

  if (hasSelectedLegSignal(selected, leg)) {
    return false;
  }

  if (selected.some((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg) && item.market === leg.market)) {
    return false;
  }

  if (leg.market === "first_goalscorer" && appetite < 0.82) {
    return false;
  }

  if (leg.market === "anytime_assist" && appetite < 0.72) {
    return false;
  }

  if (isScorerLeg(leg) && legCount >= 4) {
    const scorerCount = selected.filter(isScorerLeg).length;
    const firstScorerCount = selected.filter((item) => item.market === "first_goalscorer").length;

    if (scorerCount >= maxMobileScorerLegs(legCount, appetite)) {
      return false;
    }
    if (leg.market === "first_goalscorer" && firstScorerCount >= maxMobileFirstScorerLegs(legCount, appetite)) {
      return false;
    }
    if ((leg.market === "anytime_scorer" || leg.market === "anytime_assist") && !isMobileLongSlipAnytimeScorerLeg(leg) && appetite < 0.95) {
      return false;
    }
  }

  return true;
}

function mobileMostLikelyLegAllowed(leg, selected, legCount) {
  if (legCount >= 4 && !mobileFallbackLegOddsAllowed(leg, legCount, 0)) {
    return false;
  }

  if (hasSelectedLegSignal(selected, leg)) {
    return false;
  }

  if (selected.some((item) => fixtureKeyForLeg(item) === fixtureKeyForLeg(leg) && item.market === leg.market)) {
    return false;
  }

  if (leg.market === "first_goalscorer" || leg.market === "anytime_assist") {
    return false;
  }

  if (isScorerLeg(leg) && legCount >= 4) {
    const scorerCount = selected.filter(isScorerLeg).length;
    if (scorerCount >= 1) {
      return false;
    }
    if (!isMobileLongSlipAnytimeScorerLeg(leg)) {
      return false;
    }
  }

  return true;
}

function mobileFallbackLegOddsAllowed(leg, legCount, appetite) {
  const decimalOdds = Number(leg.decimalOdds || 99);
  return decimalOdds > 1 && decimalOdds <= mobileFallbackMaxLegOdds(legCount, appetite);
}

function mobileFallbackMaxLegOdds(legCount, appetite) {
  if (legCount >= 8) {
    return 4.35 + appetite * 0.85;
  }
  if (legCount >= 6) {
    return 4.25 + appetite * 1.35;
  }
  if (legCount >= 4) {
    return 5 + appetite * 1.6;
  }
  return 6 + appetite * 2;
}

function mobileFallbackCombinedOddsCap(legCount, appetite, uniqueFixtureCount = legCount) {
  const fullCoverageCap = legCount >= 8
    ? 220 + appetite * 630
    : legCount >= 6
      ? 140 + appetite * 380
      : legCount >= 5
        ? 95 + appetite * 265
        : legCount >= 4
          ? 60 + appetite * 180
          : legCount >= 3
            ? 35 + appetite * 85
            : Infinity;

  if (!Number.isFinite(fullCoverageCap)) {
    return fullCoverageCap;
  }

  const coverage = clamp(Number(uniqueFixtureCount || legCount) / Math.max(1, legCount), 0.2, 1);
  return fullCoverageCap * (0.45 + coverage * 0.55);
}

function isMobileLongSlipAnytimeScorerLeg(leg) {
  if (leg.market === "anytime_assist") {
    const model = Number(leg.modelProbability || leg.likelyProbability || 0);
    const raw = Number(leg.rawModelProbability || model);
    const confidence = Number(leg.confidence || 0);
    const starter = Number(leg.components?.starterLikelihood ?? 0.5);
    const projectedMinutes = Number(leg.components?.projectedMinutes ?? 0);

    return Number(leg.decimalOdds || 99) <= 7
      && model >= 0.16
      && raw >= 0.14
      && confidence >= 0.62
      && starter >= 0.64
      && projectedMinutes >= 62
      && Number(leg.components?.assistsPerTwentyTeamMatches || 0) >= 1
      && Number(leg.components?.assistConfidence || 0) >= 0.52
      && Number(leg.components?.creativeRoleScore || 0) >= 0.5
      && Number(leg.components?.playerDataCoverage || 0) >= 0.45;
  }

  if (leg.market !== "anytime_scorer") {
    return false;
  }

  const model = Number(leg.modelProbability || leg.likelyProbability || 0);
  const raw = Number(leg.rawModelProbability || model);
  const confidence = Number(leg.confidence || 0);
  const starter = Number(leg.components?.starterLikelihood ?? 0.5);
  const projectedMinutes = Number(leg.components?.projectedMinutes ?? 0);
  const goalsPerTwenty = Number(leg.components?.scorerGoalsPerTwentyTeamMatches ?? 0);
  const scorerConfidence = Number(leg.components?.scorerConfidence ?? 0);

  return model >= 0.22
    && raw >= 0.2
    && confidence >= 0.64
    && starter >= 0.62
    && projectedMinutes >= 63
    && goalsPerTwenty >= 3
    && scorerConfidence >= 0.55;
}

function maxMobileScorerLegs(legCount, appetite = 0) {
  if (legCount >= 6) {
    return appetite >= 0.82 ? 2 : 1;
  }
  if (legCount >= 3) {
    return 1;
  }
  return 1;
}

function maxMobileFirstScorerLegs(legCount, appetite = 0) {
  return legCount >= 6 && appetite >= 0.95 ? 1 : 0;
}

function mobileMarketOnlySurvivalPenalty(leg) {
  const market = Number(leg.marketImpliedProbability || leg.impliedProbability || 0);
  const model = Number(leg.modelProbability || leg.likelyProbability || 0);
  const raw = Number(leg.rawModelProbability || model);
  const independentEdge = Number(leg.independentEdge ?? (raw - market));
  const marketOnlyGap = Math.max(0, market - Math.max(model, raw));

  if (!market || marketOnlyGap <= 0.12 || independentEdge >= -0.025) {
    return 0;
  }

  return clamp(marketOnlyGap * 0.25 + Math.abs(independentEdge) * 0.18, 0, 0.09);
}

function mobileFallbackDisplayPenalty({ legs, legCount, reusedSignalCount, fragileLegCount }) {
  const uniqueFixtureCount = new Set(legs.map(fixtureKeyForLeg)).size;
  const sameFixturePenalty = Math.max(0, legCount - uniqueFixtureCount) * 0.012;
  const repeatPenalty = Number(reusedSignalCount || 0) * 0.018;
  const fragilePenalty = Math.max(0, Number(fragileLegCount || 0) - 1) * 0.01;

  return clamp(0.045 + sameFixturePenalty + repeatPenalty + fragilePenalty, 0, 0.18);
}

function isMobileFallbackSelection(legs) {
  return new Set(legs.map(fixtureKeyForLeg)).size < legs.length
    || legs.some((leg) => leg.shortWindowFallback || leg.reusedSignal);
}

function mobileDisplayRating(legs, { likely = false } = {}) {
  const ratings = legs.map((leg) => {
    const probability = Number(likely ? (leg.likelyProbability || mobileLikelyWinProbability(leg)) : (leg.modelProbability || leg.likelyProbability || 0));
    const confidence = Number(leg.confidence || 0);
    const intelligence = Number(leg.components?.intelligenceConfidence || 0.5);
    const edgeLift = clamp(Number(leg.edge || 0), 0, 0.18) / 0.18;
    return clamp(0.48 + ((probability * 0.42) + (confidence * 0.24) + (intelligence * 0.14) + (edgeLift * 0.1)) * 0.5, 0.32, likely ? 0.97 : 0.95);
  });

  return round(clamp(mean(ratings), 0.34, likely ? 0.97 : 0.95), 4);
}

function mobileMaxLegOdds(legCount, appetite) {
  if (legCount >= 8) {
    return 2.2 + appetite * 1.8;
  }
  if (legCount >= 6) {
    return 2.45 + appetite * 2.35;
  }
  if (legCount >= 4) {
    return 3.3 + appetite * 3.2;
  }
  if (legCount >= 3) {
    return 3.4 + appetite * 3.2;
  }
  return 3 + appetite * 4;
}

function mobileTargetLegOdds(legCount, appetite) {
  if (legCount >= 8) {
    return 1.35 + appetite * 0.62;
  }
  if (legCount >= 6) {
    return 1.42 + appetite * 0.82;
  }
  if (legCount >= 4) {
    return 1.55 + appetite * 1.15;
  }
  if (legCount >= 3) {
    return 1.7 + appetite * 1.65;
  }
  return 1.8 + appetite * 2.2;
}

function mobileSurvivalPressure(legCount) {
  return clamp((Number(legCount || 1) - 2) / 6, 0, 1);
}

function legCountForKey(key) {
  if (key === "single") {
    return 1;
  }
  if (key === "double") {
    return 2;
  }
  if (key === "trixie") {
    return 3;
  }
  return Number(String(key).match(/\d+/)?.[0] || 1);
}

function fixtureKeyForLeg(leg) {
  const home = normalizeFixtureName(leg.homeTeam);
  const away = normalizeFixtureName(leg.awayTeam);

  if (home && away) {
    return `${home}_vs_${away}`;
  }

  const labelFixture = String(leg.selectionLabel || "").split(":")[0].trim();
  if (labelFixture.toLowerCase().includes(" vs ")) {
    return normalizeFixtureName(labelFixture);
  }

  return leg.fixtureId || leg.id;
}

function legSignalKey(leg) {
  return [
    fixtureKeyForLeg(leg),
    normalizeFixtureName(leg.market),
    normalizeFixtureName(leg.outcome || ""),
    normalizeFixtureName(leg.playerName || ""),
    normalizeFixtureName(leg.selectionLabel || "")
  ].join("|");
}

function hasSelectedLegSignal(selected, leg) {
  const key = legSignalKey(leg);
  return selected.some((item) => item.id === leg.id || legSignalKey(item) === key);
}

function normalizeFixtureName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, "_");
}

function isBttsYesLeg(leg) {
  return leg.market === "both_teams_to_score" && String(leg.outcome || leg.selectionLabel || "").toLowerCase().includes("yes");
}

function isTotalGoalsLeg(leg) {
  return ["over_1_5_goals", "over_2_5_goals", "under_2_5_goals", "under_3_5_goals", "under_4_5_goals"].includes(leg.market);
}

function isScorerLeg(leg) {
  return leg.market === "anytime_scorer" || leg.market === "first_goalscorer" || leg.market === "anytime_assist";
}

function fragileBttsHistory(leg) {
  if (!isBttsYesLeg(leg)) {
    return false;
  }

  const minBttsHistory = Math.min(
    Number(leg.components?.homeBttsRate || 0.48),
    Number(leg.components?.awayBttsRate || 0.48)
  );
  const overHistory = mean([
    Number(leg.components?.homeOver25Rate || 0.48),
    Number(leg.components?.awayOver25Rate || 0.48)
  ]);

  return minBttsHistory < 0.3 || overHistory < 0.34;
}

function fallbackDateRange() {
  const today = localDateKey(new Date());

  return {
    min: today,
    max: tournamentEndDate,
    defaultFrom: today,
    defaultTo: tournamentEndDate
  };
}

function minDateKey(values) {
  return values.filter(Boolean).sort()[0] || "";
}

function maxDateKey(values) {
  return values.filter(Boolean).sort().at(-1) || "";
}

function recalculateSlip(slip, stake) {
  return slip.map((bet) => ({
    ...bet,
    stake,
    potentialReturn: recalculateReturn(bet, stake)
  }));
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

  el.betslip.innerHTML = slip.map((bet) => betCard(bet)).concat(missingCards).join("");
}

function renderPickOfDay(slip, profile) {
  if (!slip.length) {
    const supported = supportedPickOfDaySlip(profile);
    el.pickOfDay.innerHTML = supported.length
      ? supported.map(([, label]) => unavailableCard(label, profile, "No most-likely pick passed the current checks yet.")).join("")
      : unavailableCard("Picks of the Day", profile, "No matches exist in this selected date range yet.");
    return;
  }

  const present = new Set(slip.map(categoryForBet));
  const missingCards = supportedPickOfDaySlip(profile)
    .filter(([key]) => !present.has(key))
    .map(([, label]) => unavailableCard(label, profile, "Not enough real data passed the most-likely checks for this card yet."));

  el.pickOfDay.innerHTML = slip.map((bet) => betCard(bet, { pick: true })).concat(missingCards).join("");
}

function betCard(bet, { pick = false } = {}) {
  return `
    <article class="bet-card${pick ? " pick-card" : ""}">
      <header>
        <span class="tag${pick ? " pick-tag" : ""}">${escapeHtml(bet.label || bet.type)}</span>
        <span class="score">${escapeHtml(confidenceLabel(bet, pick))}</span>
      </header>
      <ul class="legs">
        ${(bet.legs || []).map((leg) => `
          <li>
            ${escapeHtml(leg.selectionLabel)} <strong>@ ${Number(leg.decimalOdds || 0).toFixed(2)}</strong>
            <span class="leg-note">${escapeHtml(formatLegNoteWithKickoff(leg, pick))}</span>
          </li>
        `).join("")}
      </ul>
      <p class="why">${escapeHtml(bet.thesis || "The model found enough value, confidence, and fixture separation for this slip.")}</p>
      <div class="bet-meta">
        <div><span>Odds</span><strong>${Number(bet.combinedDecimalOdds || 0).toFixed(2)}</strong></div>
        <div><span>Stake</span><strong>${money(bet.stake)}</strong></div>
        <div><span>Return</span><strong>${money(bet.potentialReturn)}</strong></div>
      </div>
    </article>
  `;
}

function unavailableCard(label, profile, prefix = "No real-data pick passed this date/risk profile yet.") {
  const fixtureText = Number(profile?.fixtureCount || 0) > 0
    ? `${profile.fixtureCount} game(s) checked.`
    : "No games in the selected window.";

  return `
    <article class="bet-card unavailable">
      <header>
        <span class="tag">${escapeHtml(label)}</span>
        <span class="score">waiting</span>
      </header>
      <p class="why">${escapeHtml(`${prefix} ${fixtureText}`)}</p>
    </article>
  `;
}

function supportedPickOfDaySlip(profile) {
  const fixtureCount = Number(profile?.fixtureCount || 0);

  if (fixtureCount <= 0) {
    return [];
  }

  return pickOfDaySlip.filter(([key]) => {
    const legs = key === "single" ? 1 : key === "double" ? 2 : key === "trixie" ? 3 : Number(key.match(/\d+/)?.[0] || 1);
    return fixtureCount >= legs;
  });
}

function categoryForBet(bet) {
  if (bet.category) {
    return bet.category;
  }

  if (bet.type === "accumulator") {
    return `accumulator_${bet.legCount || (bet.legs || []).length}`;
  }

  return bet.type || "unknown";
}

function todayScorerGroups() {
  const today = localDateKey(new Date());
  const groups = state.data?.likelyScorersByDate?.[today] || [];

  return groups.map((group) => {
    const players = applyLineupAdjustments(group.players || [], group.fixture).slice(0, 4);

    return {
      ...group,
      players,
      lineupNotice: scorerLineupNotice(group.fixture, players)
    };
  });
}

function todayAssistGroups() {
  const today = localDateKey(new Date());
  const groups = state.data?.likelyAssistsByDate?.[today] || [];

  return groups.map((group) => {
    const players = applyLineupAdjustments(group.players || [], group.fixture).slice(0, 5);

    return {
      ...group,
      players,
      lineupNotice: assistLineupNotice(group.fixture, players)
    };
  });
}

function todayPlayerEventGroups(marketKey) {
  const today = localDateKey(new Date());
  const groups = state.data?.likelyEventsByDate?.[today]?.[marketKey] || [];

  return groups.map((group) => {
    const players = applyLineupAdjustments(group.players || [], group.fixture).slice(0, 5);

    return {
      ...group,
      players,
      lineupNotice: eventLineupNotice(group.fixture, players)
    };
  });
}

function todayBinaryEventGroups(marketKey) {
  const today = localDateKey(new Date());
  const groups = state.data?.likelyEventsByDate?.[today]?.[marketKey] || [];

  return groups.map((group) => ({
    ...group,
    events: (group.events || []).slice().sort((left, right) => {
      if (left.outcome === "Yes") {
        return -1;
      }

      if (right.outcome === "Yes") {
        return 1;
      }

      return Number(right.probability || 0) - Number(left.probability || 0);
    })
  }));
}

function renderLikelyGoalscorers(groups) {
  if (!groups.length) {
    el.likelyScorers.innerHTML = `
      <article class="scorer-card unavailable">
        <header>
          <span class="tag scorer-tag">Today</span>
          <span class="score">waiting</span>
        </header>
        <p class="why">No World Cup fixtures are listed for today in the current database.</p>
      </article>
    `;
    return;
  }

  el.likelyScorers.innerHTML = groups.map((group) => {
    const emptyText = group.lineupNotice || "Scorer data is still building for this game.";
    const players = group.players.length
      ? group.players.map((player, index) => `
        <li>
          <span class="rank">${index + 1}</span>
          <div>
            <strong>${escapeHtml(player.playerName)}</strong>
            <span>${escapeHtml(player.team)} | ${escapeHtml(player.reason)}</span>
          </div>
          <em>${percent(player.probability)}</em>
        </li>
      `).join("")
      : `<li class="empty-scorers">${escapeHtml(emptyText)}</li>`;
    const notice = group.lineupNotice && group.players.length
      ? `<p class="why">${escapeHtml(group.lineupNotice)}</p>`
      : "";

    return `
      <article class="scorer-card">
        <header>
          <span class="tag scorer-tag">${escapeHtml(group.fixtureLabel)}</span>
          <span class="score">${escapeHtml(formatKickoff(group.fixture.date))}</span>
        </header>
        <ol class="scorers">
          ${players}
        </ol>
        ${notice}
      </article>
    `;
  }).join("");
}

function renderLikelyAssists(groups) {
  if (!el.likelyAssists) {
    return;
  }

  if (!groups.length) {
    el.likelyAssists.innerHTML = `
      <article class="scorer-card unavailable">
        <header>
          <span class="tag scorer-tag">Today</span>
          <span class="score">waiting</span>
        </header>
        <p class="why">No World Cup fixtures are listed for today in the current database.</p>
      </article>
    `;
    return;
  }

  el.likelyAssists.innerHTML = groups.map((group) => {
    const emptyText = group.lineupNotice || "Assist data is still building for this game.";
    const players = group.players.length
      ? group.players.map((player, index) => `
        <li>
          <span class="rank">${index + 1}</span>
          <div>
            <strong>${escapeHtml(player.playerName)}</strong>
            <span>${escapeHtml(player.team)} | ${escapeHtml(player.reason)}</span>
          </div>
          <em>${percent(player.probability)}</em>
        </li>
      `).join("")
      : `<li class="empty-scorers">${escapeHtml(emptyText)}</li>`;
    const notice = group.lineupNotice && group.players.length
      ? `<p class="why">${escapeHtml(group.lineupNotice)}</p>`
      : "";

    return `
      <article class="scorer-card">
        <header>
          <span class="tag scorer-tag">${escapeHtml(group.fixtureLabel)}</span>
          <span class="score">${escapeHtml(formatKickoff(group.fixture.date))}</span>
        </header>
        <ol class="scorers">
          ${players}
        </ol>
        ${notice}
      </article>
    `;
  }).join("");
}

function renderLikelyPlayerEvents(container, groups, emptyMessage) {
  if (!container) {
    return;
  }

  if (!groups.length) {
    container.innerHTML = unavailableEventCard(emptyMessage);
    return;
  }

  container.innerHTML = groups.map((group) => {
    const emptyText = group.lineupNotice || "Event data is still building for this game.";
    const players = group.players.length
      ? group.players.map((player, index) => `
        <li>
          <span class="rank">${index + 1}</span>
          <div>
            <strong>${escapeHtml(player.playerName)}</strong>
            <span>${escapeHtml(player.team)} | ${escapeHtml(player.reason)}</span>
          </div>
          <em>${percent(player.probability)}</em>
        </li>
      `).join("")
      : `<li class="empty-scorers">${escapeHtml(emptyText)}</li>`;
    const notice = group.lineupNotice && group.players.length
      ? `<p class="why">${escapeHtml(group.lineupNotice)}</p>`
      : "";

    return `
      <article class="scorer-card event-card">
        <header>
          <span class="tag scorer-tag">${escapeHtml(group.fixtureLabel)}</span>
          <span class="score">${escapeHtml(formatKickoff(group.fixture.date))}</span>
        </header>
        <ol class="scorers">
          ${players}
        </ol>
        ${notice}
      </article>
    `;
  }).join("");
}

function renderLikelyBinaryEvents(container, groups, emptyMessage) {
  if (!container) {
    return;
  }

  if (!groups.length) {
    container.innerHTML = unavailableEventCard(emptyMessage);
    return;
  }

  container.innerHTML = groups.map((group) => {
    const events = group.events.length
      ? group.events.map((event) => `
        <li>
          <span class="rank">${escapeHtml(event.outcome)}</span>
          <div>
            <strong>${escapeHtml(event.event)}: ${escapeHtml(event.outcome)}</strong>
            <span>${escapeHtml(binaryEventReason(event))}</span>
          </div>
          <em>${percent(event.probability)}</em>
        </li>
      `).join("")
      : `<li class="empty-scorers">Event data is still building for this game.</li>`;

    return `
      <article class="scorer-card event-card">
        <header>
          <span class="tag scorer-tag">${escapeHtml(group.fixtureLabel)}</span>
          <span class="score">${escapeHtml(formatKickoff(group.fixture.date))}</span>
        </header>
        <ol class="scorers event-outcomes">
          ${events}
        </ol>
      </article>
    `;
  }).join("");
}

function unavailableEventCard(message) {
  return `
    <article class="scorer-card unavailable">
      <header>
        <span class="tag scorer-tag">Today</span>
        <span class="score">waiting</span>
      </header>
      <p class="why">${escapeHtml(message)}</p>
    </article>
  `;
}

function binaryEventReason(event) {
  const oddsText = event.decimalOdds ? ` @ ${Number(event.decimalOdds).toFixed(2)}` : "";
  const bookmaker = event.bookmaker ? ` via ${event.bookmaker}` : "";

  return `${event.reason || "model event estimate"}${bookmaker}${oddsText}`;
}

function applyLineupAdjustments(players, fixture) {
  const lineup = lineupForFixture(fixture);
  const lineupRequired = isLineupRequiredForFixture(fixture);

  if (!lineup) {
    return lineupRequired
      ? players.map((player) => ({
        ...player,
        lineupStatus: "lineup_unavailable",
        reason: `${player.reason} | team sheets not found yet`
      }))
      : players;
  }

  const adjusted = [];

  for (const player of players) {
    const team = teamLineupFromRecord(lineup, player.team);
    const teamUsable = isUsableTeamLineup(team);

    if (!teamUsable) {
      adjusted.push(lineupRequired
        ? {
          ...player,
          lineupStatus: "lineup_unavailable",
          reason: `${player.reason} | ${player.team || "team"} XI not found yet`
        }
        : player);
      continue;
    }

    const starterName = team.starters.find((starter) => playerNamesMatch(starter, player.playerName));
    const status = team.status === "confirmed" ? "confirmed_starter" : "predicted_starter";
    const statusText = team.status === "confirmed" ? "confirmed starter" : "predicted starter";

    if (!starterName) {
      if (!lineupRequired) {
        adjusted.push({
          ...player,
          lineupStatus: team.status === "confirmed" ? "not_starting" : "not_predicted_starter",
          probability: clamp(Number(player.probability || 0) * 0.08, 0.01, 0.08),
          confidence: clamp(Number(player.confidence || 0) * 0.55, 0, 1),
          sourceWeight: Number(player.sourceWeight || 0) * 0.35,
          reason: `${player.reason} | not in ${team.status === "confirmed" ? "confirmed" : "predicted"} XI`
        });
      }
      continue;
    }

    adjusted.push({
      ...player,
      playerName: betterDisplayPlayerName(starterName, player.playerName),
      lineupStatus: status,
      reason: `${player.reason} | ${statusText}`
    });
  }

  if (lineupRequired) {
    const starters = adjusted.filter((player) => ["confirmed_starter", "predicted_starter", "lineup_unavailable"].includes(player.lineupStatus));
    return starters.length ? starters : players.map((player) => ({
      ...player,
      lineupStatus: "lineup_inconclusive",
      reason: `${player.reason} | lineup check inconclusive`
    }));
  }

  const starterOnly = adjusted.filter((player) => !["not_starting", "not_predicted_starter"].includes(player.lineupStatus));
  return starterOnly.length ? starterOnly : adjusted;
}

function lineupForFixture(fixture) {
  const records = state.lineups?.lineups || [];

  return records.find((record) => record.fixtureId === fixture.id)
    || records.find((record) => sameTeam(record.homeTeam, fixture.homeTeam)
      && sameTeam(record.awayTeam, fixture.awayTeam)
      && String(record.fixtureDate || "").slice(0, 10) === (fixture.dateKey || dateKey(fixture.date)))
    || null;
}

function teamLineupFromRecord(lineup, teamName) {
  if (!lineup?.teams || !teamName) {
    return null;
  }

  return lineup.teams[teamName]
    || Object.entries(lineup.teams).find(([team]) => sameTeam(team, teamName))?.[1]
    || null;
}

function scorerLineupNotice(fixture, players) {
  if (!isLineupRequiredForFixture(fixture)) {
    return "";
  }

  const lineup = lineupForFixture(fixture);

  if (!lineup) {
    return players.length
      ? "Team sheets are not available yet; showing model scorer picks until the lineup check lands."
      : "Team sheets are not available yet and scorer data is still building.";
  }

  const missingTeams = [fixture.homeTeam, fixture.awayTeam]
    .filter((team) => !isConfirmedTeamLineup(teamLineupFromRecord(lineup, team)));
  const predictedTeams = missingTeams
    .filter((team) => isPredictedTeamLineup(teamLineupFromRecord(lineup, team)));

  if (!players.length && missingTeams.length) {
    return `Lineup check is still incomplete for ${missingTeams.join(" and ")}; showing no scorer candidate would be unsafe.`;
  }

  if (!players.length) {
    return "Confirmed lineups were found, but no scorer candidate matched the starting XIs.";
  }

  if (predictedTeams.length) {
    return `Confirmed XI not published yet for ${predictedTeams.join(" and ")}; showing predicted starters from the lineup check.`;
  }

  if (missingTeams.length) {
    return `Showing available scorer picks while waiting for confirmed ${missingTeams.join(" and ")} XI.`;
  }

  return "";
}

function assistLineupNotice(fixture, players) {
  if (!isLineupRequiredForFixture(fixture)) {
    return "";
  }

  const lineup = lineupForFixture(fixture);

  if (!lineup) {
    return players.length
      ? "Team sheets are not available yet; showing model assist picks until the lineup check lands."
      : "Team sheets are not available yet and assist data is still building.";
  }

  const missingTeams = [fixture.homeTeam, fixture.awayTeam]
    .filter((team) => !isConfirmedTeamLineup(teamLineupFromRecord(lineup, team)));
  const predictedTeams = missingTeams
    .filter((team) => isPredictedTeamLineup(teamLineupFromRecord(lineup, team)));

  if (!players.length && missingTeams.length) {
    return `Lineup check is still incomplete for ${missingTeams.join(" and ")}; showing no assist candidate would be unsafe.`;
  }

  if (!players.length) {
    return "Confirmed lineups were found, but no assist candidate matched the starting XIs.";
  }

  if (predictedTeams.length) {
    return `Confirmed XI not published yet for ${predictedTeams.join(" and ")}; showing predicted starters from the lineup check.`;
  }

  if (missingTeams.length) {
    return `Showing available assist picks while waiting for confirmed ${missingTeams.join(" and ")} XI.`;
  }

  return "";
}

function eventLineupNotice(fixture, players) {
  if (!isLineupRequiredForFixture(fixture)) {
    return "";
  }

  const lineup = lineupForFixture(fixture);

  if (!lineup) {
    return players.length
      ? "Team sheets are not available yet; showing model event picks until the lineup check lands."
      : "Team sheets are not available yet and event data is still building.";
  }

  const missingTeams = [fixture.homeTeam, fixture.awayTeam]
    .filter((team) => !isConfirmedTeamLineup(teamLineupFromRecord(lineup, team)));
  const predictedTeams = missingTeams
    .filter((team) => isPredictedTeamLineup(teamLineupFromRecord(lineup, team)));

  if (!players.length && missingTeams.length) {
    return `Lineup check is still incomplete for ${missingTeams.join(" and ")}; showing no player-event candidate would be unsafe.`;
  }

  if (!players.length) {
    return "Confirmed lineups were found, but no player-event candidate matched the starting XIs.";
  }

  if (predictedTeams.length) {
    return `Confirmed XI not published yet for ${predictedTeams.join(" and ")}; showing predicted starters from the lineup check.`;
  }

  if (missingTeams.length) {
    return `Showing available event picks while waiting for confirmed ${missingTeams.join(" and ")} XI.`;
  }

  return "";
}

function isConfirmedTeamLineup(team) {
  return team?.status === "confirmed" && hasPlausibleLineupStarters(team);
}

function isPredictedTeamLineup(team) {
  return team?.status === "predicted" && hasPlausibleLineupStarters(team);
}

function isUsableTeamLineup(team) {
  return ["confirmed", "predicted"].includes(team?.status) && hasPlausibleLineupStarters(team);
}

function hasPlausibleLineupStarters(team) {
  const starters = Array.isArray(team?.starters) ? team.starters.slice(0, 11) : [];

  if (starters.length < 7) {
    return false;
  }

  return starters.filter(isPlausibleLineupPlayerName).length >= Math.min(7, starters.length);
}

function isPlausibleLineupPlayerName(value) {
  const text = String(value || "").trim();
  const key = normalizeLookupKey(text);

  if (!key) {
    return false;
  }

  if (/\/|\b(?:report|soccer|football|featured|video|world cup|previous|next|home|scores?|teams?|transfer|rumours?|rumors?|news|article|images?|getty|copyright|coach|manager|preview|prediction|odds)\b/i.test(text)) {
    return false;
  }

  if (/^(?:and|or|the|a|an)\b/i.test(text) || /\b(?:and|or)\s+[A-Z]/.test(text)) {
    return false;
  }

  if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(text)) {
    return false;
  }

  const words = key.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 4 && words.every((word) => word.length >= 2);
}

function isLineupRequiredForFixture(fixture, now = new Date()) {
  const minutes = minutesUntilKickoff(fixture, now);
  return minutes >= scorerLineupGate.minMinutesBeforeKickoff
    && minutes <= scorerLineupGate.maxMinutesBeforeKickoff;
}

function minutesUntilKickoff(fixture, now = new Date()) {
  return (new Date(fixture.date).getTime() - now.getTime()) / 60000;
}

function playerNamesMatch(left, right) {
  const a = normalizeLookupKey(left);
  const b = normalizeLookupKey(right);

  if (!a || !b) {
    return false;
  }

  if (a === b || a.endsWith(` ${b}`) || b.endsWith(` ${a}`)) {
    return true;
  }

  const aSurname = a.split(/\s+/).filter(Boolean).at(-1);
  const bSurname = b.split(/\s+/).filter(Boolean).at(-1);

  return Boolean(aSurname && bSurname && aSurname.length > 3 && aSurname === bSurname);
}

function betterDisplayPlayerName(starterName, fallbackName) {
  return String(starterName || "").trim().length > String(fallbackName || "").trim().length
    ? starterName
    : fallbackName;
}

function sameTeam(left, right) {
  return normalizeLookupKey(left) === normalizeLookupKey(right);
}

function normalizeLookupKey(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function formatLegNote(leg, likely = false) {
  const rawAi = Number(leg.rawModelProbability || leg.modelProbability || leg.likelyProbability || 0);
  const market = Number(leg.marketImpliedProbability || leg.impliedProbability || 0);
  const independentEdge = Number(leg.independentEdge ?? (rawAi - market));
  const signals = Number(leg.components?.nonMarketSignalCount || 0);
  const bookmaker = leg.bookmaker ? ` via ${leg.bookmaker}` : "";
  const performance = performanceLegNote(leg);

  if (likely) {
    return `AI survival ${percent(leg.likelyProbability || leg.modelProbability)}${bookmaker} | raw AI ${percent(rawAi)} vs market ${percent(market)} | edge ${percent(independentEdge)} | ${signals} signals${performance}`;
  }

  const tag = String(leg.riskTag || "edge").replace(/_/g, " ");
  return `${tag}${bookmaker} | AI ${percent(rawAi)} vs market ${percent(market)} | edge ${percent(independentEdge)} | ${signals} signals | data ${percent(leg.confidence)}${performance}`;
}

function performanceLegNote(leg) {
  const components = leg.components || {};

  if (components.priceGone) {
    const reason = components.livePriceDiscipline?.reason || "price has moved below model value";
    return ` | price warning: ${reason}`;
  }

  if (components.bettingPerformanceMarketAction === "suppress_for_cash") {
    return ` | market health: poor ROI/CLV sample`;
  }

  if (components.bettingPerformanceMarketAction === "downgrade") {
    return ` | market health: downgraded`;
  }

  return "";
}

function confidenceLabel(bet, likely = false) {
  const rating = Number(bet.displayRating || bet.combinedProbability || bet.score / 100 || 0);
  return `AI Rating ${percent(clamp(rating, 0, likely ? 0.97 : 0.95))}`;
}

function marketLine(data) {
  const labels = {
    match_winner: "Match winner",
    draw_no_bet: "Draw no bet",
    anytime_scorer: "Anytime scorer",
    first_goalscorer: "First goalscorer",
    anytime_assist: "Anytime assist",
    player_shot: "Player shots",
    player_shot_on_target: "Player SOT",
    goalkeeper_saves: "Keeper saves",
    team_shots: "Team shots",
    team_shots_on_target: "Team SOT",
    total_corners: "Total corners",
    team_corners: "Team corners",
    total_cards: "Total cards",
    team_cards: "Team cards",
    clean_sheet: "Clean sheet",
    win_to_nil: "Win to nil",
    player_card: "Player carded",
    penalty_awarded: "Penalty",
    red_card: "Red card",
    both_teams_to_score: "BTTS",
    double_chance: "Double chance",
    over_1_5_goals: "Over 1.5",
    over_2_5_goals: "Over 2.5",
    under_2_5_goals: "Under 2.5",
    under_3_5_goals: "Under 3.5",
    under_4_5_goals: "Under 4.5",
    asian_handicap: "Asian handicap",
    asian_total_goals: "Asian totals",
    three_way_handicap: "3-way handicap",
    team_total_goals: "Team totals",
    team_to_score: "Team to score",
    to_qualify: "To qualify"
  };
  const configured = data?.markets?.configured || [];
  const collectOnly = data?.markets?.collectOnly || [];
  const observed = data?.markets?.observed || {};
  const active = configured.map((market) => labels[market] || market).join(", ");
  const scorerCount = Number(observed.anytime_scorer || 0) + Number(observed.first_goalscorer || 0);
  const assistCount = Number(observed.anytime_assist || 0);
  const playerShotCount = Number(observed.player_shot || 0);
  const shotCount = Number(observed.player_shot_on_target || 0);
  const keeperSaveCount = Number(observed.goalkeeper_saves || 0);
  const teamShotCount = Number(observed.team_shots || 0);
  const teamSotCount = Number(observed.team_shots_on_target || 0);
  const cornerCount = Number(observed.total_corners || 0) + Number(observed.team_corners || 0);
  const cardTotalCount = Number(observed.total_cards || 0) + Number(observed.team_cards || 0);
  const cleanSheetCount = Number(observed.clean_sheet || 0);
  const winToNilCount = Number(observed.win_to_nil || 0);
  const cardCount = Number(observed.player_card || 0);
  const penaltyCount = Number(observed.penalty_awarded || 0);
  const redCardCount = Number(observed.red_card || 0);
  const playerPropCount = scorerCount + assistCount + playerShotCount + shotCount + keeperSaveCount + cardCount;
  const eventCount = teamShotCount + teamSotCount + cornerCount + cardTotalCount + cleanSheetCount + winToNilCount + penaltyCount + redCardCount;
  const survivalCount = Number(data?.markets?.survivabilityCoverage?.summary?.freshRecordCount || 0);
  const collectOnlyText = collectOnly.length
    ? ` Survival data: ${collectOnly.map((market) => labels[market] || market).join(", ")}${survivalCount ? ` (${survivalCount}).` : "."}`
    : "";

  return `Markets: ${active}.${playerPropCount ? ` Player prop prices found: ${playerPropCount} (${scorerCount} scorers, ${assistCount} assists, ${playerShotCount} shots, ${shotCount} SOT, ${keeperSaveCount} saves, ${cardCount} carded).` : ""}${eventCount ? ` Event prices: ${eventCount} (${teamShotCount} team shots, ${teamSotCount} team SOT, ${cornerCount} corners, ${cardTotalCount} cards, ${cleanSheetCount} clean sheet, ${winToNilCount} win to nil, ${penaltyCount} penalty, ${redCardCount} red card).` : ""}${collectOnlyText}`;
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
    return endMinute < 1440
      ? currentMinute >= startMinute && currentMinute < endMinute
      : currentMinute >= startMinute || currentMinute < (endMinute - 1440);
  });

  return { active, message };
}

function recalculateReturn(bet, stake) {
  if (bet.type !== "trixie" || !Array.isArray(bet.legs) || bet.legs.length !== 3) {
    return round(stake * Number(bet.combinedDecimalOdds || 0), 2);
  }

  const odds = bet.legs.map((leg) => Number(leg.decimalOdds || 1));
  const unit = stake / 4;
  return round(unit * ((odds[0] * odds[1]) + (odds[0] * odds[2]) + (odds[1] * odds[2]) + (odds[0] * odds[1] * odds[2])), 2);
}

function nearest(values, value) {
  return values.reduce((winner, item) => Math.abs(item - value) < Math.abs(winner - value) ? item : winner, values[0]);
}

function product(values) {
  return values.reduce((total, value) => total * Number(value || 1), 1);
}

function mean(values) {
  const valid = values.map(Number).filter((value) => Number.isFinite(value));
  return valid.length ? valid.reduce((total, value) => total + value, 0) / valid.length : 0;
}

function parseDateKey(value) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T00:00:00`);
  return Number.isFinite(date.getTime()) ? date : null;
}

function dateKey(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function localDateKey(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function formatKickoff(value) {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return "Kickoff TBC";
  }

  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatLegNoteWithKickoff(leg, pick = false) {
  const note = formatLegNote(leg, pick);
  const kickoff = formatLegKickoff(leg);

  return kickoff ? `${kickoff} | ${note}` : note;
}

function formatLegKickoff(leg) {
  const date = new Date(leg.fixtureDate || "");

  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  const formatted = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);

  return `Kickoff ${formatted}`;
}

function money(value) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Number(value || 0));
}

function percent(value) {
  return `${Math.round(Number(value || 0) * 1000) / 10}%`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value || 0)));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
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
