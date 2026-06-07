const state = {
  data: null,
  profile: null
};

const el = {
  reload: document.getElementById("reloadButton"),
  scanStamp: document.getElementById("scanStamp"),
  stake: document.getElementById("stakeInput"),
  betCount: document.getElementById("betCountInput"),
  risk: document.getElementById("riskInput"),
  riskValue: document.getElementById("riskValue"),
  days: document.getElementById("daysInput"),
  daysValue: document.getElementById("daysValue"),
  riskLabel: document.getElementById("riskLabel"),
  riskDescription: document.getElementById("riskDescription"),
  engineNotes: document.getElementById("engineNotes"),
  fixtureCount: document.getElementById("fixtureCount"),
  edgeCount: document.getElementById("edgeCount"),
  memoryCount: document.getElementById("memoryCount"),
  returnTotal: document.getElementById("returnTotal"),
  betslip: document.getElementById("betslipList")
};

el.reload.addEventListener("click", loadData);
for (const input of [el.stake, el.betCount, el.risk, el.days]) {
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
  const betCount = Math.max(1, Math.min(12, Number(el.betCount.value || 5)));
  const riskBucket = nearest(state.data.riskBuckets, risk);
  const dayBucket = nearest(state.data.dayBuckets, daysAhead);
  const profile = state.data.profiles[`d${dayBucket}_r${riskBucket}`] || Object.values(state.data.profiles)[0];
  const slip = (profile?.betslip || []).slice(0, betCount).map((bet) => ({
    ...bet,
    stake: round(stake / betCount, 2),
    potentialReturn: round((stake / betCount) * Number(bet.combinedDecimalOdds || 0), 2)
  }));

  el.riskValue.textContent = risk;
  el.daysValue.textContent = daysAhead;
  el.scanStamp.textContent = `Latest scan: ${new Date(state.data.generatedAt).toLocaleString()}`;
  el.riskLabel.textContent = profile?.riskProfile?.label || "Shared Engine";
  el.riskDescription.textContent = profile?.riskProfile?.description || "Using the shared scanner profile.";
  el.engineNotes.textContent = buildEngineNote(profile, state.data);
  el.fixtureCount.textContent = `${profile?.fixtureCount || 0} games`;
  el.edgeCount.textContent = `${profile?.eligibleLegCount || 0}`;
  el.memoryCount.textContent = `${state.data.intelligence?.teamCount || 0}`;
  el.returnTotal.textContent = money(slip.reduce((total, bet) => total + Number(bet.potentialReturn || 0), 0));
  renderSlip(slip);
}

function renderSlip(slip) {
  if (!slip.length) {
    el.betslip.innerHTML = `<article class="bet-card">No betslip passed this risk/day window. Nudge the slider or wait for the next scan.</article>`;
    return;
  }

  el.betslip.innerHTML = slip.map((bet) => `
    <article class="bet-card">
      <header>
        <span class="tag">${escapeHtml(bet.type)}</span>
        <span class="score">${Number(bet.score || 0).toFixed(1)} score</span>
      </header>
      <ul class="legs">
        ${bet.legs.slice(0, 5).map((leg) => `
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
  `).join("");
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
  const shared = data.engine?.sharedCore ? "same Windows scoring core" : "published scoring core";

  return `Using the ${shared}: minimum edge ${edge}, leg confidence ${confidence}, intelligence confidence ${intelligence}, and ${learningCount} settled outcome learning records.`;
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
