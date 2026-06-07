const state = {
  data: null,
  profile: null
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

const el = {
  reload: document.getElementById("reloadButton"),
  scanStamp: document.getElementById("scanStamp"),
  stake: document.getElementById("stakeInput"),
  risk: document.getElementById("riskInput"),
  riskValue: document.getElementById("riskValue"),
  days: document.getElementById("daysInput"),
  daysValue: document.getElementById("daysValue"),
  engineNotes: document.getElementById("engineNotes"),
  fixtureCount: document.getElementById("fixtureCount"),
  edgeCount: document.getElementById("edgeCount"),
  memoryCount: document.getElementById("memoryCount"),
  returnTotal: document.getElementById("returnTotal"),
  betslip: document.getElementById("betslipList")
};

el.reload.addEventListener("click", loadData);
for (const input of [el.stake, el.risk, el.days]) {
  input.addEventListener("input", render);
}

loadData();
registerServiceWorker();

async function loadData() {
  el.scanStamp.textContent = "Loading latest GitHub scan...";

  try {
    const response = await fetch(`./data/latest.json?v=${Date.now()}`);
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    state.data = await response.json();
    render();
  } catch (error) {
    el.scanStamp.textContent = `No generated scan yet: ${error.message}`;
    el.betslip.innerHTML = `<article class="bet-card">Run <strong>npm run web:build-data</strong> locally or let GitHub Actions publish the latest scan.</article>`;
  }
}

function render() {
  if (!state.data) {
    return;
  }

  const risk = Number(el.risk.value);
  const daysAhead = Number(el.days.value);
  const stake = Number(el.stake.value || 10);
  const riskBucket = nearest(state.data.riskBuckets, risk);
  const dayBucket = nearest(state.data.dayBuckets, daysAhead);
  const profile = state.data.profiles[`d${dayBucket}_r${riskBucket}`] || Object.values(state.data.profiles)[0];
  const slipCount = Math.max(1, (profile?.betslip || []).length || 8);
  const slip = (profile?.betslip || []).map((bet) => ({
    ...bet,
    stake: round(stake / slipCount, 2),
    potentialReturn: recalculateReturn(bet, round(stake / slipCount, 2))
  }));

  el.riskValue.textContent = risk;
  el.daysValue.textContent = daysAhead;
  el.scanStamp.textContent = `Latest database: ${new Date(state.data.generatedAt).toLocaleString()} | build time ${state.data.collection?.totalBuildDurationSeconds || state.data.collection?.durationSeconds || "?"}s`;
  el.engineNotes.textContent = buildEngineNote(profile, state.data);
  el.fixtureCount.textContent = `${profile?.fixtureCount || 0} games`;
  el.edgeCount.textContent = `${profile?.eligibleLegCount || 0}`;
  el.memoryCount.textContent = `${state.data.intelligence?.teamCount || 0}`;
  el.returnTotal.textContent = money(slip.reduce((total, bet) => total + Number(bet.potentialReturn || 0), 0));
  renderSlip(slip, profile);
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
        <span class="score">${Number(bet.score || 0).toFixed(1)} score</span>
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

function unavailableCard(label, profile) {
  const message = profile?.dataQuality?.message || state.data?.collection?.dataQuality?.message || "The database is still collecting public-web source data.";

  return `
    <article class="bet-card unavailable">
      <header>
        <span class="tag">${escapeHtml(label)}</span>
        <span class="score">waiting</span>
      </header>
      <p class="why">No real-data pick passed this risk/day profile yet. ${escapeHtml(message)}</p>
    </article>
  `;
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

function nearest(values, value) {
  return values.reduce((winner, item) => Math.abs(item - value) < Math.abs(winner - value) ? item : winner, values[0]);
}

function money(value) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Number(value || 0));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function buildEngineNote(profile, data) {
  const markers = profile?.policyMarkers || {};
  const edge = percent(markers.minLegEdge);
  const confidence = percent(markers.minLegConfidence);
  const intelligence = percent(markers.minIntelligenceConfidence);
  const learningCount = Number(data.intelligence?.outcomeLearningCount || 0);
  const quality = data.collection?.dataQuality;
  const sourceText = quality ? `${quality.sourceOk} sources ok, ${quality.sourceEmpty} empty, ${quality.sourceErrors} errors` : "source health pending";

  return `Risk ${profile?.riskProfile?.label || "profile"}: minimum edge ${edge}, leg confidence ${confidence}, intelligence confidence ${intelligence}, ${learningCount} settled outcome learning records, ${sourceText}.`;
}

function formatLegNote(leg) {
  const edge = percent(leg.edge);
  const confidence = percent(leg.confidence);
  const tag = String(leg.riskTag || "edge").replace(/_/g, " ");
  const bookmaker = leg.bookmaker ? ` via ${leg.bookmaker}` : "";

  return `${tag}${bookmaker} | edge ${edge} | confidence ${confidence}`;
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
