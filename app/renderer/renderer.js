const elements = {
  stake: document.getElementById("stakeInput"),
  betCount: document.getElementById("betCountInput"),
  daysAhead: document.getElementById("daysAheadInput"),
  daysValue: document.getElementById("daysValue"),
  risk: document.getElementById("riskInput"),
  riskLabel: document.getElementById("riskLabel"),
  riskDescription: document.getElementById("riskDescription"),
  scanButton: document.getElementById("scanButton"),
  openDataButton: document.getElementById("openDataButton"),
  todayDate: document.getElementById("todayDate"),
  todayGames: document.getElementById("todayGames"),
  latestScan: document.getElementById("latestScan"),
  oddsCount: document.getElementById("oddsCount"),
  newsCount: document.getElementById("newsCount"),
  teamCount: document.getElementById("teamCount"),
  edgeCount: document.getElementById("edgeCount"),
  bestOffer: document.getElementById("bestOffer"),
  potentialReturn: document.getElementById("potentialReturn"),
  betslipList: document.getElementById("betslipList"),
  toast: document.getElementById("toast")
};

const riskProfiles = [
  {
    max: 21,
    label: "Careful",
    description: "Prioritises higher confidence, fresher data, and fewer legs."
  },
  {
    max: 47,
    label: "Balanced",
    description: "Looks for value while still keeping the betslip fairly grounded."
  },
  {
    max: 74,
    label: "Calculated Risk",
    description: "Adds price value and tactical mismatches without going full chaos mode."
  },
  {
    max: 100,
    label: "Bold",
    description: "Allows longer odds and bigger combined prices when the evidence supports it."
  }
];

let currentState;
let toastTimeout;

if (!window.worldCupMagic) {
  window.worldCupMagic = {
    getDashboard: async () => previewDashboard(),
    saveSettings: async (settings) => settings,
    scan: async (settings) => ({ ...previewDashboard().latestScan, settings }),
    openDataFolder: async () => null,
    onScanCompleted: () => {},
    onScanError: () => {}
  };
}

boot();

async function boot() {
  currentState = await window.worldCupMagic.getDashboard();
  hydrate(currentState);
  attachEvents();

  window.worldCupMagic.onScanCompleted(async () => {
    currentState = await window.worldCupMagic.getDashboard();
    hydrate(currentState);
    showToast("Background scan finished. The slip has fresh evidence.");
  });

  window.worldCupMagic.onScanError((message) => {
    showToast(`Background scan hit a snag: ${message}`);
  });
}

function attachEvents() {
  elements.daysAhead.addEventListener("input", () => {
    elements.daysValue.textContent = elements.daysAhead.value;
    saveSettingsSoon();
  });

  elements.risk.addEventListener("input", () => {
    updateRiskCopy(Number(elements.risk.value));
    saveSettingsSoon();
  });

  elements.stake.addEventListener("change", saveSettingsSoon);
  elements.betCount.addEventListener("change", saveSettingsSoon);

  elements.scanButton.addEventListener("click", async () => {
    const settings = readSettings();
    elements.scanButton.disabled = true;
    elements.scanButton.querySelector("span").textContent = "Scanning";
    elements.scanButton.querySelector("small").textContent = "please wait";

    try {
      const scan = await window.worldCupMagic.scan(settings);
      currentState = await window.worldCupMagic.getDashboard();
      hydrate({ ...currentState, latestScan: scan });
      showToast(`Scan complete: ${scan.betslip.length} betslip ideas built.`);
    } catch (error) {
      showToast(`Scan failed: ${error?.message || error}`);
    } finally {
      elements.scanButton.disabled = false;
      elements.scanButton.querySelector("span").textContent = "Scan";
      elements.scanButton.querySelector("small").textContent = "news + odds";
    }
  });

  elements.openDataButton.addEventListener("click", async () => {
    await window.worldCupMagic.openDataFolder();
  });
}

let settingsSaveTimer;
function saveSettingsSoon() {
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    window.worldCupMagic.saveSettings(readSettings()).catch(() => {});
  }, 250);
}

function hydrate(state) {
  const settings = state.settings || {};
  elements.stake.value = settings.stake ?? 10;
  elements.betCount.value = settings.betCount ?? 5;
  elements.daysAhead.value = settings.daysAhead ?? 2;
  elements.daysValue.textContent = elements.daysAhead.value;
  elements.risk.value = settings.risk ?? 48;
  updateRiskCopy(Number(elements.risk.value));

  const now = new Date(state.now || Date.now());
  elements.todayDate.textContent = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
  elements.todayGames.textContent = `${state.fixtures?.length || 0} games watched`;
  elements.latestScan.textContent = state.stats?.latestScanAt ? `Last scan ${relativeTime(state.stats.latestScanAt)}` : "No scan yet";
  elements.oddsCount.textContent = state.stats?.oddsSnapshotCount || 0;
  elements.newsCount.textContent = state.stats?.newsArticleCount || 0;
  elements.teamCount.textContent = state.stats?.teamIntelligenceCount || state.stats?.teamStatsCount || 0;
  const edgeCount = state.latestScan?.eligibleLegCount || state.recommendations?.eligibleLegCount || 0;
  const learnedCount = state.latestScan?.intelligence?.outcomeLearningCount || 0;
  elements.edgeCount.textContent = learnedCount ? `${edgeCount} / ${learnedCount}` : edgeCount;
  elements.bestOffer.textContent = state.offers?.[0]?.bookmaker || state.latestScan?.offerRanking?.[0]?.bookmaker || "Checking";

  renderBetslip(state.latestScan?.betslip || []);
}

function readSettings() {
  return {
    stake: Number(elements.stake.value || 10),
    betCount: Number(elements.betCount.value || 5),
    risk: Number(elements.risk.value || 48),
    daysAhead: Number(elements.daysAhead.value || 2)
  };
}

function updateRiskCopy(value) {
  const profile = riskProfiles.find((item) => value <= item.max) || riskProfiles[riskProfiles.length - 1];
  elements.riskLabel.textContent = profile.label;
  elements.riskDescription.textContent = profile.description;
}

function renderBetslip(betslip) {
  elements.betslipList.innerHTML = "";

  if (!betslip.length) {
    elements.potentialReturn.textContent = formatMoney(0);
    elements.betslipList.innerHTML = '<div class="empty-state">Press Scan to build a betslip for the selected window.</div>';
    return;
  }

  const totalReturn = betslip.reduce((total, bet) => total + Number(bet.potentialReturn || 0), 0);
  elements.potentialReturn.textContent = formatMoney(totalReturn);

  for (const bet of betslip) {
    const card = document.createElement("article");
    card.className = "bet-card";
    card.innerHTML = `
      <div class="bet-topline">
        <span class="bet-type">${escapeHtml(bet.type)}</span>
        <span class="bet-score">${Number(bet.score || 0).toFixed(1)} score</span>
      </div>
      <ul class="leg-list">
        ${bet.legs.slice(0, 4).map((leg) => `<li>${escapeHtml(leg.selectionLabel)} <strong>@ ${Number(leg.decimalOdds).toFixed(2)}</strong></li>`).join("")}
      </ul>
      <div class="bet-bottom">
        <div><span>Odds</span><strong>${Number(bet.combinedDecimalOdds || 0).toFixed(2)}</strong></div>
        <div><span>Stake</span><strong>${formatMoney(bet.stake)}</strong></div>
        <div><span>Return</span><strong>${formatMoney(bet.potentialReturn)}</strong></div>
      </div>
    `;
    elements.betslipList.append(card);
  }
}

function showToast(message) {
  clearTimeout(toastTimeout);
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  toastTimeout = setTimeout(() => elements.toast.classList.remove("visible"), 3400);
}

function relativeTime(value) {
  const diffMs = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.round(diffMs / 60000));

  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  return `${Math.round(minutes / 60)}h ago`;
}

function formatMoney(value) {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function previewDashboard() {
  const betslip = [
    {
      id: "preview_1",
      rank: 1,
      type: "trixie",
      score: 92.4,
      legCount: 3,
      combinedDecimalOdds: 8.91,
      stake: 5,
      potentialReturn: 44.55,
      legs: [
        { selectionLabel: "France vs Canada: Both teams to score: Yes", decimalOdds: 2.08 },
        { selectionLabel: "Argentina vs Japan: Both teams to score: Yes", decimalOdds: 2.02 },
        { selectionLabel: "Morocco vs Mexico: Both teams to score: Yes", decimalOdds: 2.12 }
      ]
    },
    {
      id: "preview_2",
      rank: 2,
      type: "double",
      score: 88.8,
      legCount: 2,
      combinedDecimalOdds: 4.2,
      stake: 5,
      potentialReturn: 21,
      legs: [
        { selectionLabel: "England vs Brazil: Over 2.5 goals", decimalOdds: 1.97 },
        { selectionLabel: "Morocco vs Mexico: Morocco to win", decimalOdds: 2.52 }
      ]
    }
  ];

  return {
    now: new Date().toISOString(),
    settings: {
      stake: 10,
      betCount: 5,
      risk: 58,
      daysAhead: 2
    },
    fixtures: [{}, {}, {}],
    stats: {
      oddsSnapshotCount: 108,
      newsArticleCount: 24,
      teamStatsCount: 8,
      teamIntelligenceCount: 8,
      latestScanAt: new Date(Date.now() - 1000 * 60 * 12).toISOString()
    },
    latestScan: {
      eligibleLegCount: 10,
      intelligence: {
        outcomeLearningCount: 0
      },
      betslip,
      offerRanking: [{ bookmaker: "DemoBook Balanced" }]
    },
    offers: [{ bookmaker: "DemoBook Balanced" }]
  };
}
