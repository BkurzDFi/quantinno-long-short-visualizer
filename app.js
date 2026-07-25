const defaults = {
  otherAssets: 2000000,
  targetConcentration: 0,
  taxRate: 25,
  exchangeExposure: "140/40",
  overlayAllocation: 2000000,
  overlayExposure: "130/30",
  benchmark: "sp500",
  mgmtFee: 0.5,
  financingSpread: 0.75,
};

// Calibrated against observed Quantinno DEALS Exchange 140/40 transition
// analyses: solving each real analysis's own years-to-target for the implied
// annual loss rate consistently lands within ~0.15pt of 12.4% regardless of
// ticker, cost basis, or account size, so "base" is set there. Conservative
// and strong keep the original 0.6x/1.5x spread around base.
const lossRatePresets = {
  conservative: 0.075,
  base: 0.125,
  strong: 0.1875,
};

const illustrativeReturnPath = [0.7, 1.25, 0.55, 1.1, 0.8, 1.35, 0.65, 1.05, 0.9, 1.2, 0.75, 1];

// Strategy lineup from Quantinno's DEALS Managed Account Platform overview
// (Onboarding Package, appendix p.10).
const strategyTypes = {
  exchange: {
    label: "DEALS Exchange",
    tagline: "Concentrated stock diversification",
    funding: "Concentrated stock, cash, or in-kind securities",
    useCase: "Systematically divest concentrated positions tax-neutrally; proceeds reinvest into the chosen benchmark",
  },
  overlay: {
    label: "DEALS Overlay",
    tagline: "Existing holdings utilization",
    funding: "Existing portfolio holdings as collateral - no additional funding required",
    useCase: "Put idle holdings to work generating tax benefits while existing exposures are maintained",
  },
  core: {
    label: "DEALS Core",
    tagline: "Core equity + tax alpha",
    funding: "Cash, or recharge an existing tax-loss harvesting strategy",
    useCase: "Enhanced core equity exposure with risk reduction and consistent tax benefits",
  },
};

// Gross exposure menu from the onboarding package (p.11): 130/30 default for
// Overlay/Core; 140/40 is the default for Exchange, matching the exposure
// used in Quantinno's actual DEALS Exchange transition analyses. Reg-T margin
// allows up to 145/45; higher gross requires Portfolio Margin.
const exposureOptions = {
  "100/0": { long: 100, short: 0, note: "No extension (reference case)", margin: "None" },
  "115/45": { long: 115, short: 45, note: "0.7 beta option", margin: "Reg-T" },
  "130/30": { long: 130, short: 30, note: "Overlay/Core default", margin: "Reg-T" },
  "140/40": { long: 140, short: 40, note: "Exchange default", margin: "Reg-T" },
  "145/45": { long: 145, short: 45, note: "Reg-T maximum", margin: "Reg-T" },
  "175/75": { long: 175, short: 75, note: "Higher extension", margin: "Portfolio Margin" },
  "150/100": { long: 150, short: 100, note: "0.5 beta option", margin: "Portfolio Margin" },
  "225/125": { long: 225, short: 125, note: "Maximum extension", margin: "Portfolio Margin" },
};

const PORTFOLIO_MARGIN_MINIMUM = 3000000;

// Benchmark menu mirroring the DEALS Portal firm elections / setup template.
// Ex-US-only benchmarks are not available for DEALS Exchange per Quantinno.
const benchmarks = {
  sp500: { label: "S&P 500 (US 500 Large Cap)" },
  r1000: { label: "Russell 1000 (US Large & Mid)" },
  r1000v: { label: "Russell 1000 Value" },
  r1000g: { label: "Russell 1000 Growth" },
  r3000: { label: "Russell 3000 (US All Cap)" },
  world: { label: "MSCI World (Global Developed)" },
  acwi: { label: "MSCI ACWI (Global Dev & Emerging)" },
  acwiExUs: { label: "MSCI ACWI ex-US", notForExchange: true },
  blend8020: { label: "80% S&P 500 / 20% MSCI ACWI ex-US" },
  blend7030: { label: "70% S&P 500 / 30% MSCI ACWI ex-US" },
};

// Illustrative scaling: more short exposure creates more tax-lot surface area,
// but with diminishing efficiency. 130/30 is the 1.0x anchor.
function lossMultiplierFor(shortPct) {
  if (shortPct <= 0) return 0;
  return 0.5 + 0.5 * (shortPct / 30);
}

// A DEALS sleeve (Exchange or Overlay). Both can run concurrently: Exchange is
// funded by the concentrated stock and diversifies it; Overlay puts existing
// assets to work as collateral. Each generates harvestable losses.
function buildSleeve(kind, allocation, exposureKey) {
  const type = strategyTypes[kind];
  const exposure = exposureOptions[exposureKey] || exposureOptions["130/30"];
  return {
    kind,
    label: type.label,
    fundingShort: kind === "exchange" ? "Concentrated tickers" : "Other assets",
    allocation,
    exposure,
    longDollars: (allocation * exposure.long) / 100,
    shortDollars: (allocation * exposure.short) / 100,
    lossMultiplier: lossMultiplierFor(exposure.short),
    returnRate: (6.8 + 0.02 * exposure.short) / 100,
    marginRequired: exposure.margin === "Portfolio Margin",
    active: allocation > 0,
  };
}

let positions = [
  { id: crypto.randomUUID(), ticker: "PLTR", shares: 20000, price: 100, basis: 400000 },
  { id: crypto.randomUUID(), ticker: "GOOGL", shares: 5000, price: 200, basis: 600000 },
];

const ids = Object.keys(defaults);
const inputs = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
const positionsBody = document.getElementById("positionsBody");
const priceStatus = document.getElementById("priceStatus");
const finnhubApiKeyInput = document.getElementById("finnhubApiKey");
const saveFinnhubKeyButton = document.getElementById("saveFinnhubKeyButton");
const clearFinnhubKeyButton = document.getElementById("clearFinnhubKeyButton");
const FINNHUB_KEY_STORAGE_KEY = "aqrFinnhubApiKey";
let autoRefreshTimer = null;
let lastUpdatedTickers = new Set();
let lastPriceUpdateAt = "";

// Sliders paired with a directly-editable number input, since a bare range
// slider can't represent an exact client dollar amount or blended rate
// (Other/Overlay allocation snap to $250K steps otherwise).
const pairedSliderIds = ["otherAssets", "targetConcentration", "taxRate", "overlayAllocation", "mgmtFee", "financingSpread"];

const bulkImportToggle = document.getElementById("bulkImportToggle");
const bulkImportPanel = document.getElementById("bulkImportPanel");
const bulkImportInput = document.getElementById("bulkImportInput");
const bulkImportApplyButton = document.getElementById("bulkImportApply");
const bulkImportCancelButton = document.getElementById("bulkImportCancel");
const bulkImportStatus = document.getElementById("bulkImportStatus");

const scenarioSelect = document.getElementById("scenarioSelect");
const saveScenarioButton = document.getElementById("saveScenarioButton");
const deleteScenarioButton = document.getElementById("deleteScenarioButton");
const scenarioStatus = document.getElementById("scenarioStatus");
const SCENARIOS_STORAGE_KEY = "aqrSavedScenarios";

function money(value) {
  const abs = Math.abs(value);
  if (abs >= 1000000) return `$${(value / 1000000).toFixed(abs >= 10000000 ? 0 : 1)}M`;
  if (abs >= 1000) return `$${Math.round(value / 1000)}K`;
  return `$${Math.round(value).toLocaleString()}`;
}

function fullMoney(value) {
  return `$${Math.round(value).toLocaleString()}`;
}

function fullMoneyCents(value) {
  return `$${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function fetchFinnhubQuotesDirectly(symbols, apiKey) {
  const quotes = await Promise.all(
    symbols.map(async (symbol) => {
      const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(apiKey)}`;
      const response = await fetch(quoteUrl);
      if (!response.ok) throw new Error(`Finnhub returned ${response.status} for ${symbol}`);
      const data = await response.json();
      return {
        symbol,
        price: Number(data.c || 0),
      };
    }),
  );
  return { quotes };
}

function pct(value, digits = 0) {
  return `${value.toFixed(digits)}%`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sliderElementFor(id) {
  return document.getElementById(`${id}Slider`);
}

// Keeps the coarse-step range slider visually in sync with the precise
// number input. The number input stays the source of truth read by
// getAssumptions(), so typed values beyond the slider's range/step aren't lost.
function syncPairedSlider(id) {
  const slider = sliderElementFor(id);
  const number = inputs[id];
  if (!slider || !number) return;
  slider.value = clamp(Number(number.value) || 0, Number(slider.min), Number(slider.max));
}

function wirePairedSlider(id) {
  const slider = sliderElementFor(id);
  const number = inputs[id];
  if (!slider || !number) return;
  slider.addEventListener("input", () => {
    number.value = slider.value;
    markScenarioDirty();
    updateOutputs();
  });
  number.addEventListener("input", () => {
    syncPairedSlider(id);
  });
}

function numberValue(value) {
  return Number(String(value).replace(/[^0-9.-]/g, "")) || 0;
}

function storedFinnhubKey() {
  return localStorage.getItem(FINNHUB_KEY_STORAGE_KEY) || "";
}

function refreshPriceStatus() {
  if (storedFinnhubKey()) {
    priceStatus.textContent = "Finnhub key saved. Prices will auto-refresh when tickers change.";
    return;
  }
  priceStatus.textContent = "Prices can be entered manually or refreshed from Finnhub when the local API key is configured.";
}

function positionValue(position) {
  return position.shares * position.price;
}

function positionGain(position) {
  return Math.max(positionValue(position) - position.basis, 0);
}

function gainRatio(position) {
  const value = positionValue(position);
  return value > 0 ? positionGain(position) / value : 0;
}

function getAssumptions() {
  const totalConcentratedValue = positions.reduce((sum, position) => sum + positionValue(position), 0);
  const otherAssets = Number(inputs.otherAssets.value);
  const portfolioValue = otherAssets + totalConcentratedValue;
  const totalBasis = positions.reduce((sum, position) => sum + Math.min(position.basis, positionValue(position)), 0);
  const unrealizedGain = positions.reduce((sum, position) => sum + positionGain(position), 0);
  const targetConcentration = Number(inputs.targetConcentration.value) / 100;
  const targetStockValue = portfolioValue * targetConcentration;
  const plannedSale = Math.max(totalConcentratedValue - targetStockValue, 0);
  const salePlan = buildTaxSmartSalePlan(plannedSale);
  const gainToOffset = salePlan.reduce((sum, sale) => sum + sale.gainRealized, 0);
  const taxRate = Number(inputs.taxRate.value) / 100;
  const taxIfSoldToday = gainToOffset * taxRate;
  const tickers = positions.map((position) => position.ticker).filter(Boolean);
  const benchmark = benchmarks[inputs.benchmark.value] || benchmarks.sp500;

  // Two concurrent sleeves. Exchange is sized to the concentrated stock it
  // manages; Overlay draws a chosen slice of the other portfolio assets.
  const overlayAllocation = Math.min(Number(inputs.overlayAllocation.value), otherAssets);
  const exchange = buildSleeve("exchange", totalConcentratedValue, inputs.exchangeExposure.value);
  const overlay = buildSleeve("overlay", overlayAllocation, inputs.overlayExposure.value);
  const sleeves = { exchange, overlay };
  const activeSleeves = [exchange, overlay].filter((sleeve) => sleeve.active);

  const managedAssets = exchange.allocation + overlay.allocation;
  const sleeveLongDollars = exchange.longDollars + overlay.longDollars;
  const sleeveShortDollars = exchange.shortDollars + overlay.shortDollars;
  const blendedReturnRate =
    managedAssets > 0
      ? (exchange.allocation * exchange.returnRate + overlay.allocation * overlay.returnRate) / managedAssets
      : 0;

  const mgmtFeeRate = Number(inputs.mgmtFee.value) / 100;
  const financingRate = Number(inputs.financingSpread.value) / 100;
  const annualMgmtFee = managedAssets * mgmtFeeRate;
  const annualFinancing = sleeveShortDollars * financingRate;

  const strategyProfile = {
    label: overlay.active ? "DEALS Exchange + Overlay" : `DEALS Exchange ${exchange.exposure.long}/${exchange.exposure.short}`,
    totalReturn: blendedReturnRate * 100,
    funding: "Concentrated stock (Exchange) + existing assets as collateral (Overlay)",
  };

  return {
    portfolioValue,
    otherAssets,
    positions,
    tickers,
    totalConcentratedValue,
    totalBasis,
    currentConcentration: totalConcentratedValue / portfolioValue,
    targetConcentration,
    targetStockValue,
    plannedSale,
    unrealizedGain,
    salePlan,
    gainToOffset,
    effectiveGainRatio: plannedSale > 0 ? gainToOffset / plannedSale : 0,
    taxRate,
    taxIfSoldToday,
    sleeves,
    activeSleeves,
    managedAssets,
    sleeveLongDollars,
    sleeveShortDollars,
    benchmark,
    strategyProfile,
    mgmtFeeRate,
    financingRate,
    annualMgmtFee,
    annualFinancing,
    annualCosts: annualMgmtFee + annualFinancing,
    lossRates: lossRatePresets,
  };
}

function buildTaxSmartSalePlan(plannedSale) {
  let remainingSale = plannedSale;
  const orderedPositions = [...positions].sort((left, right) => gainRatio(left) - gainRatio(right));
  const sales = [];

  orderedPositions.forEach((position) => {
    if (remainingSale <= 0) return;
    const value = positionValue(position);
    const saleAmount = Math.min(value, remainingSale);
    const ratio = gainRatio(position);
    sales.push({
      ticker: position.ticker,
      saleAmount,
      gainRealized: saleAmount * ratio,
      gainRatio: ratio,
    });
    remainingSale -= saleAmount;
  });

  return sales;
}

function scenarioFor(assumptions, key) {
  const rate = assumptions.lossRates[key];
  const exchangeLosses = assumptions.sleeves.exchange.allocation * rate * assumptions.sleeves.exchange.lossMultiplier;
  const overlayLosses = assumptions.sleeves.overlay.allocation * rate * assumptions.sleeves.overlay.lossMultiplier;
  const annualLosses = exchangeLosses + overlayLosses;
  const saleCapacity = assumptions.effectiveGainRatio > 0 ? annualLosses / assumptions.effectiveGainRatio : 0;
  const yearsRaw = annualLosses > 0 ? assumptions.gainToOffset / annualLosses : Infinity;
  const years = assumptions.gainToOffset <= 0 ? 0 : yearsRaw;
  const path = buildPath(assumptions, annualLosses);

  return {
    key,
    annualLosses,
    exchangeLosses,
    overlayLosses,
    saleCapacity,
    years,
    path,
  };
}

function buildPath(assumptions, annualLosses) {
  const rows = [];
  let cumulativeLosses = 0;
  let cumulativeSale = 0;
  const yearsToGoal = annualLosses > 0 ? Math.ceil(assumptions.gainToOffset / annualLosses) : 12;
  const maxYears = Math.min(30, Math.max(12, yearsToGoal));

  for (let year = 0; year <= maxYears; year += 1) {
    if (year > 0) {
      cumulativeLosses = Math.min(cumulativeLosses + annualLosses, assumptions.gainToOffset);
      cumulativeSale =
        assumptions.effectiveGainRatio > 0
          ? Math.min(cumulativeLosses / assumptions.effectiveGainRatio, assumptions.plannedSale)
          : assumptions.plannedSale;
    }

    const remainingStock = assumptions.totalConcentratedValue - cumulativeSale;
    rows.push({
      year,
      cumulativeLosses,
      cumulativeSale,
      remainingStock,
      concentration: remainingStock / assumptions.portfolioValue,
    });
  }

  return rows;
}

function updateOutputs() {
  syncBenchmarkAvailability();
  const assumptions = getAssumptions();
  const scenarios = {
    conservative: scenarioFor(assumptions, "conservative"),
    base: scenarioFor(assumptions, "base"),
    strong: scenarioFor(assumptions, "strong"),
  };

  syncLabels(assumptions);
  renderMetrics(assumptions, scenarios);
  renderNarrative(assumptions, scenarios);
  drawTransitionBlocks(document.getElementById("transitionBlockChart"), assumptions, scenarios.base);
  drawCapacity(document.getElementById("capacityChart"), scenarios);
  renderFeePanel(assumptions, scenarios);
  renderPlanTable(assumptions, scenarios.base);
  renderMultiYearExample(assumptions, scenarios.base, scenarios);
  renderTheoryBreakdown(assumptions, scenarios.base);
}

function syncBenchmarkAvailability() {
  // The Exchange sleeve is always active here, and ex-US-only benchmarks are
  // not available for DEALS Exchange, so keep those options disabled.
  [...inputs.benchmark.options].forEach((option) => {
    const benchmark = benchmarks[option.value];
    const blocked = Boolean(benchmark && benchmark.notForExchange);
    option.disabled = blocked;
    if (blocked && inputs.benchmark.value === option.value) inputs.benchmark.value = "sp500";
  });
}

function syncLabels(assumptions) {
  const tickerText = assumptions.tickers.length === 1 ? assumptions.tickers[0] : `${assumptions.tickers.length} concentrated positions`;
  document.getElementById("headline").textContent =
    `How long until ${tickerText} can be diversified tax-neutrally?`;

  ids.forEach((id) => {
    const output = document.getElementById(`${id}Value`);
    if (!output) return;
    const value = Number(inputs[id].value);

    if (["otherAssets", "overlayAllocation"].includes(id)) {
      output.textContent = money(value);
    } else if (["mgmtFee", "financingSpread"].includes(id)) {
      output.textContent = `${value.toFixed(2)}%`;
    } else {
      output.textContent = pct(value, 0);
    }
  });

  renderPortfolioComposition(assumptions);
  renderSleeveSplit(assumptions);
}

function renderPortfolioComposition(assumptions) {
  document.getElementById("portfolioComposition").innerHTML = `
    <div><span>Concentrated tickers</span><strong>${money(assumptions.totalConcentratedValue)}</strong></div>
    <div><span>Other assets</span><strong>${money(assumptions.otherAssets)}</strong></div>
    <div class="wide-fact total-fact"><span>Total portfolio</span><strong>${money(assumptions.portfolioValue)} · ${pct(assumptions.currentConcentration * 100, 0)} concentrated today</strong></div>
  `;
}

function sleeveCard(sleeve) {
  const baseLosses = sleeve.allocation * lossRatePresets.base * sleeve.lossMultiplier;
  const kindClass = sleeve.kind === "exchange" ? "sleeve-exchange" : "sleeve-overlay";
  const inactive = sleeve.active ? "" : " sleeve-inactive";
  return `
    <div class="sleeve-card ${kindClass}${inactive}">
      <div class="sleeve-card-top">
        <span class="sleeve-badge">${sleeve.kind === "exchange" ? "Exchange" : "Overlay"}</span>
        <strong>${sleeve.label}</strong>
      </div>
      <dl class="sleeve-card-facts">
        <div class="fact-wide"><dt>Funded by</dt><dd>${sleeve.fundingShort}</dd></div>
        <div><dt>Allocation</dt><dd>${money(sleeve.allocation)}</dd></div>
        <div><dt>Exposure</dt><dd>${sleeve.exposure.long}/${sleeve.exposure.short}</dd></div>
        <div><dt>Losses / yr</dt><dd>${sleeve.active ? money(baseLosses) : "—"}</dd></div>
      </dl>
    </div>
  `;
}

function renderSleeveSplit(assumptions) {
  const { exchange, overlay } = assumptions.sleeves;
  const allocNote = document.getElementById("exchangeAllocNote");
  if (allocNote) {
    allocNote.textContent = `Sized automatically to your concentrated stock: ${money(exchange.allocation)}.`;
  }
  const marginWarnings = [exchange, overlay]
    .filter((sleeve) => sleeve.active && sleeve.marginRequired && sleeve.allocation < PORTFOLIO_MARGIN_MINIMUM)
    .map(
      (sleeve) =>
        `<div class="wide-fact margin-warning"><span>${sleeve.label} eligibility</span><strong>Portfolio Margin needs a $3M account minimum, Options Level 3, and firm-level Schwab approval. This sleeve: ${money(sleeve.allocation)}.</strong></div>`,
    )
    .join("");

  document.getElementById("strategyProfileFacts").innerHTML = `
    <div class="sleeve-split">
      ${sleeveCard(exchange)}
      ${sleeveCard(overlay)}
    </div>
    ${marginWarnings ? `<div class="profile-facts sleeve-warnings">${marginWarnings}</div>` : ""}
  `;
}

function formatYears(value) {
  if (value === 0) return "Already there";
  if (!Number.isFinite(value)) return "N/A";
  if (value < 1) return "<1 year";
  return `${value.toFixed(value >= 10 ? 0 : 1)} years`;
}

function renderMetrics(assumptions, scenarios) {
  const base = scenarios.base;
  const metrics = [
    {
      label: "Tax if sold today",
      value: fullMoney(assumptions.taxIfSoldToday),
      note: `On ${fullMoney(assumptions.gainToOffset)} of gain from planned sales`,
    },
    {
      label: "Losses needed",
      value: fullMoney(assumptions.gainToOffset),
      note: `To sell ${fullMoney(assumptions.plannedSale)} tax-neutrally`,
    },
    {
      label: "Base timeline",
      value: formatYears(base.years),
      note: `${formatYears(scenarios.strong.years)} to ${formatYears(scenarios.conservative.years)} sensitivity range`,
    },
    {
      label: "Sale room / year",
      value: fullMoney(base.saleCapacity),
      note: `Estimated tax-neutral sale capacity`,
    },
    {
      label: "Est. annual cost",
      value: fullMoney(assumptions.annualCosts),
      note: `${assumptions.mgmtFeeRate * 100 > 0 ? `${(assumptions.mgmtFeeRate * 100).toFixed(2)}% fee` : "No fee"} on ${money(assumptions.managedAssets)} + financing on ${money(assumptions.sleeveShortDollars)} short book`,
    },
  ];

  document.getElementById("metricGrid").innerHTML = metrics
    .map(
      (metric) => `
        <article class="metric-card">
          <span>${metric.label}</span>
          <strong>${metric.value}</strong>
          <small>${metric.note}</small>
        </article>
      `,
    )
    .join("");
}

function renderNarrative(assumptions, scenarios) {
  const base = scenarios.base;
  const currentPct = pct(assumptions.currentConcentration * 100, 0);
  const targetPct = pct(assumptions.targetConcentration * 100, 0);
  const names = assumptions.tickers.join(", ") || "the concentrated stock";

  const sleeveSentence = assumptions.sleeves.overlay.active
    ? `Two sleeves run at once: DEALS Exchange on the ${fullMoney(assumptions.sleeves.exchange.allocation)} of concentrated stock (${fullMoney(base.exchangeLosses)} of losses/yr) plus DEALS Overlay on ${fullMoney(assumptions.sleeves.overlay.allocation)} of other assets (${fullMoney(base.overlayLosses)} of losses/yr), for ${fullMoney(base.annualLosses)} combined. `
    : `A DEALS Exchange sleeve on the ${fullMoney(assumptions.sleeves.exchange.allocation)} of concentrated stock generates about ${fullMoney(base.annualLosses)} of losses/yr. `;

  document.getElementById("plainEnglish").textContent =
    `${names} currently total ${fullMoney(assumptions.totalConcentratedValue)}, or ${currentPct} of the portfolio. ` +
    `To get to ${targetPct}, the client would sell about ${fullMoney(assumptions.plannedSale)} using a tax-smart order that sells lower-gain positions first. ` +
    `Those sales realize about ${fullMoney(assumptions.gainToOffset)} of gains that need losses to be tax-neutral. ` +
    sleeveSentence +
    `Reinvesting proceeds toward the ${assumptions.benchmark.label} benchmark, the base estimate is about ${formatYears(base.years)}.`;

  const cumulativeCosts = assumptions.annualCosts * (Number.isFinite(base.years) ? base.years : 0);
  document.getElementById("tradeoffCopy").textContent =
    `Selling faster may mean paying up to ${fullMoney(assumptions.taxIfSoldToday)} of estimated tax on the planned sale. ` +
    `Waiting for losses may reduce that tax cost, but the client keeps more single-stock risk while they wait, and the strategy itself costs about ${fullMoney(assumptions.annualCosts)} a year (roughly ${fullMoney(cumulativeCosts)} over the base timeline) in fees and financing. ` +
    `The planning range is ${formatYears(scenarios.strong.years)} to ${formatYears(scenarios.conservative.years)}, depending on how much tax-loss capacity the managed account strategy actually creates.`;
}

function renderFeePanel(assumptions, scenarios) {
  const base = scenarios.base;
  const years = Number.isFinite(base.years) ? base.years : 0;
  const cumulativeCosts = assumptions.annualCosts * years;
  const taxOffsetValue = assumptions.taxIfSoldToday;
  const netBenefit = taxOffsetValue - cumulativeCosts;
  const maxBar = Math.max(taxOffsetValue, cumulativeCosts, Math.abs(netBenefit), 1);
  const shortBook = assumptions.sleeveShortDollars;

  const compareRow = (label, value, className) => `
    <div class="fee-compare-row">
      <span>${label}</span>
      <i><b class="${className}" style="width:${clamp((Math.abs(value) / maxBar) * 100, value !== 0 ? 3 : 0, 100)}%"></b></i>
      <strong>${value < 0 ? "-" : ""}${fullMoney(Math.abs(value))}</strong>
    </div>
  `;

  document.getElementById("feePanel").innerHTML = `
    <div class="fee-lines">
      <div class="fee-line">
        <span>Management fee</span>
        <small>${(assumptions.mgmtFeeRate * 100).toFixed(2)}% on ${money(assumptions.managedAssets)} managed (Exchange + Overlay)</small>
        <strong>${fullMoney(assumptions.annualMgmtFee)}/yr</strong>
      </div>
      <div class="fee-line">
        <span>Net financing on shorts</span>
        <small>${(assumptions.financingRate * 100).toFixed(2)}% on ${money(shortBook)} combined short book</small>
        <strong>${fullMoney(assumptions.annualFinancing)}/yr</strong>
      </div>
      <div class="fee-line fee-line-total">
        <span>Total estimated cost</span>
        <small>${formatYears(base.years)} base timeline ≈ ${fullMoney(cumulativeCosts)}</small>
        <strong>${fullMoney(assumptions.annualCosts)}/yr</strong>
      </div>
    </div>
    <div class="fee-compare">
      ${compareRow("Tax offset value", taxOffsetValue, "benefit-fill")}
      ${compareRow("Est. costs to goal", cumulativeCosts, "cost-fill")}
      ${compareRow("Net benefit", netBenefit, netBenefit >= 0 ? "net-fill" : "cost-fill")}
    </div>
    <p class="fee-note">
      Financing rates at Schwab follow the firm's negotiated rate, partially offset by
      Schwab's Short-Interest Rebate Program (SIRP). Both rates here are editable
      assumptions, not Quantinno's fee schedule.
    </p>
  `;
}

function drawCapacity(container, scenarios) {
  const rows = [
    { label: "Slower", scenario: scenarios.conservative, color: "#b55645" },
    { label: "Base", scenario: scenarios.base, color: "#16b8d8" },
    { label: "Faster", scenario: scenarios.strong, color: "#7460e8" },
  ];
  const maxCapacity = Math.max(...rows.map((row) => row.scenario.saleCapacity), 1);

  container.innerHTML = rows
    .map(
      (row) => `
        <div class="capacity-row">
          <div>
            <span>${row.label}</span>
            <strong>${fullMoney(row.scenario.saleCapacity)}</strong>
            <small>${fullMoney(row.scenario.annualLosses)} losses / year · ${formatYears(row.scenario.years)}</small>
          </div>
          <div class="capacity-track" aria-hidden="true">
            <div class="capacity-fill" style="width:${row.scenario.saleCapacity > 0 ? clamp((row.scenario.saleCapacity / maxCapacity) * 100, 3, 100) : 0}%; background:${row.color}"></div>
          </div>
        </div>
      `,
    )
    .join("");
}

function drawTransitionBlocks(container, assumptions, scenario) {
  const currentCore = Math.max(assumptions.portfolioValue - assumptions.totalConcentratedValue, 0);
  const sleeveNet = assumptions.managedAssets;
  const sleeveLong = assumptions.sleeveLongDollars;
  const sleeveShort = assumptions.sleeveShortDollars;
  const maxYear = Math.min(12, Math.max(1, Math.ceil(scenario.years || 1)));
  const points = selectedEquationPoints(scenario.path, maxYear);
  const maxLongSide = Math.max(
    ...points.map((point) => currentCore + point.cumulativeSale + point.remainingStock + sleeveLong),
    1,
  );
  const maxShortSide = Math.max(sleeveShort, 1);

  container.innerHTML = `
    <div class="transition-axis-key" aria-hidden="true">
      <span>Long exposure</span>
      <i></i>
      <span>Short exposure</span>
    </div>
    <div class="equation-stages">
      ${points
        .map((point, index) =>
          transitionEquationStage(point, index, points.length - 1, {
            currentCore,
            maxLongSide,
            maxShortSide,
            sleeveLong,
            sleeveNet,
            sleeveShort,
          }),
        )
        .join("")}
    </div>
    <p class="transition-note">
      Base case shown at selected checkpoints. The concentrated stock transitions into diversified core while the managed sleeves stay visually separated: ${fullMoney(sleeveLong)} long / ${fullMoney(sleeveShort)} short on ${fullMoney(sleeveNet)} of ${assumptions.strategyProfile.label}${assumptions.sleeves.overlay.active ? ` (Exchange ${fullMoney(assumptions.sleeves.exchange.allocation)} + Overlay ${fullMoney(assumptions.sleeves.overlay.allocation)})` : ""}.
    </p>
  `;
}

function selectedEquationPoints(path, maxYear) {
  const yearSet = new Set([0, Math.max(1, Math.ceil(maxYear / 2)), maxYear]);
  return [...yearSet]
    .filter((year) => year >= 0 && year <= maxYear)
    .sort((left, right) => left - right)
    .map((year) => path.find((point) => point.year === year) || path[path.length - 1]);
}

function transitionEquationStage(point, index, lastIndex, context) {
  const coreValue = context.currentCore + point.cumulativeSale;
  const stageLabel = point.year === 0 ? "Today" : index === lastIndex ? `Target year ${point.year}` : `Year ${point.year}`;

  return `
    <article class="equation-stage">
      <div class="equation-stage-heading">
        <span>${stageLabel}</span>
        <strong>${pct(point.concentration * 100, 0)} concentrated</strong>
      </div>
      <div class="equation-row">
        ${exposureColumn("Taxable portfolio", [
          { value: coreValue, max: context.maxLongSide, className: "core-fill", label: "Core", side: "long" },
          { value: point.remainingStock, max: context.maxLongSide, className: "concentrated-fill", label: "Concentrated", side: "long" },
        ])}
        <span class="equation-symbol">+</span>
        ${exposureColumn("Extension sleeve", [
          { value: context.sleeveLong, max: context.maxLongSide, className: "long-fill", label: "Long extension", side: "long" },
          { value: context.sleeveShort, max: context.maxShortSide, className: "short-fill", label: "Short extension", side: "short" },
        ])}
        <span class="equation-symbol">=</span>
        ${exposureColumn("Combined view", [
          { value: coreValue, max: context.maxLongSide, className: "core-fill", label: "Core", side: "long" },
          { value: point.remainingStock, max: context.maxLongSide, className: "concentrated-fill", label: "Concentrated", side: "long" },
          { value: context.sleeveLong, max: context.maxLongSide, className: "long-fill", label: "Long extension", side: "long" },
          { value: context.sleeveShort, max: context.maxShortSide, className: "short-fill", label: "Short extension", side: "short" },
        ])}
      </div>
      <dl class="equation-summary">
        <div><dt>Sold</dt><dd>${money(point.cumulativeSale)}</dd></div>
        <div><dt>Losses used</dt><dd>${money(point.cumulativeLosses)}</dd></div>
        <div><dt>Core</dt><dd>${money(coreValue)}</dd></div>
      </dl>
    </article>
  `;
}

function exposureColumn(title, segments) {
  const longSegments = segments.filter((segment) => segment.side === "long");
  const shortSegments = segments.filter((segment) => segment.side === "short");

  return `
    <div class="equation-column">
      <span class="equation-column-title">${title}</span>
      <div class="long-zone">
        <div class="vertical-stack">
          ${longSegments.map(verticalSegment).join("")}
        </div>
      </div>
      <div class="zero-line"></div>
      <div class="short-zone">
        <div class="vertical-stack">
          ${shortSegments.map(verticalSegment).join("")}
        </div>
      </div>
    </div>
  `;
}

function verticalSegment(segment) {
  const height = clamp((segment.value / segment.max) * 100, segment.value > 0 ? 5 : 0, 100);
  const label = height >= 13 ? `<span>${segment.label}</span>` : "";
  return `
    <span
      class="vertical-segment ${segment.className}"
      style="height:${height}%"
      aria-label="${segment.label}: ${fullMoney(segment.value)}"
      title="${segment.label}: ${fullMoney(segment.value)}"
    >${label}</span>
  `;
}

function renderPlanTable(assumptions, scenario) {
  // Cap the table at the year the transition actually finishes instead of
  // always padding to 10 rows - otherwise it repeats the same completed
  // row (same cumulative losses/sale, 0 remaining) for every year after.
  const displayYears = Number.isFinite(scenario.years) ? clamp(Math.ceil(scenario.years), 1, 10) : 10;
  const rows = scenario.path.filter((row) => row.year > 0 && row.year <= displayYears);
  document.getElementById("planTable").innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${row.year}</td>
          <td>${fullMoney(row.cumulativeLosses)}</td>
          <td>${fullMoney(row.cumulativeSale)}</td>
          <td>${fullMoney(row.remainingStock)} <span>${pct(row.concentration * 100, 0)}</span></td>
        </tr>
      `,
    )
    .join("");
}

function renderMultiYearExample(assumptions, baseScenario, scenarios) {
  const names = assumptions.tickers.join(", ") || "the concentrated position";
  const returnRate = assumptions.strategyProfile.totalReturn / 100;
  const rows = buildMultiYearRows(assumptions, baseScenario, returnRate);
  const targetYear = formatYears(baseScenario.years);
  const range = `${formatYears(scenarios.strong.years)} to ${formatYears(scenarios.conservative.years)}`;

  const sleeveDetail = assumptions.sleeves.overlay.active
    ? `${fullMoney(assumptions.managedAssets)} across two sleeves (Exchange ${fullMoney(assumptions.sleeves.exchange.allocation)} + Overlay ${fullMoney(assumptions.sleeves.overlay.allocation)})`
    : `${fullMoney(assumptions.managedAssets)} in a DEALS Exchange sleeve`;
  document.getElementById("scenarioIntro").textContent =
    `This example uses the same ${names} position and ${sleeveDetail} from the planning summary. Returns are illustrative pre-tax strategy returns; harvested losses are modeled separately as tax assets used to fund concentrated stock sales.`;

  const cumulativeCosts = assumptions.annualCosts * (Number.isFinite(baseScenario.years) ? baseScenario.years : 0);
  document.getElementById("scenarioSummary").innerHTML = `
    <div><span>Base timeline</span><strong>${targetYear}</strong></div>
    <div><span>Planning range</span><strong>${range}</strong></div>
    <div><span>Illustrative return</span><strong>${pct(assumptions.strategyProfile.totalReturn, 1)}</strong></div>
    <div><span>Annual losses modeled</span><strong>${fullMoney(baseScenario.annualLosses)}</strong></div>
    <div><span>Est. annual costs</span><strong>${fullMoney(assumptions.annualCosts)}</strong></div>
    <div><span>Costs through target</span><strong>${fullMoney(cumulativeCosts)}</strong></div>
  `;

  document.getElementById("scenarioCards").innerHTML = [
    {
      label: "Starting concentration",
      value: pct(assumptions.currentConcentration * 100, 0),
      note: `${fullMoney(assumptions.totalConcentratedValue)} currently in ${names}`,
    },
    {
      label: "Target concentration",
      value: pct(assumptions.targetConcentration * 100, 0),
      note: `${fullMoney(assumptions.plannedSale)} planned to sell down`,
    },
    {
      label: "Modeled account return",
      value: fullMoney(assumptions.managedAssets * returnRate),
      note: `Illustrative annual pre-tax return at ${pct(assumptions.strategyProfile.totalReturn, 1)} on ${money(assumptions.managedAssets)}`,
    },
    {
      label: "Tax losses used",
      value: fullMoney(assumptions.gainToOffset),
      note: `Losses needed to offset planned realized gains`,
    },
  ]
    .map(
      (card) => `
        <article class="metric-card scenario-card">
          <span>${card.label}</span>
          <strong>${card.value}</strong>
          <small>${card.note}</small>
        </article>
      `,
    )
    .join("");

  drawMultiYearTimeline(rows);
  document.getElementById("multiYearTable").innerHTML = rows.map(multiYearRow).join("");
}

function buildMultiYearRows(assumptions, scenario, returnRate) {
  const displayYears = Math.min(Math.max(Math.ceil(scenario.years || 1), 5), 12);
  const rows = [];

  for (let year = 1; year <= displayYears; year += 1) {
    const current = scenario.path.find((point) => point.year === year) || scenario.path[scenario.path.length - 1];
    const previous = scenario.path.find((point) => point.year === year - 1) || scenario.path[0];
    const annualLosses = Math.max(current.cumulativeLosses - previous.cumulativeLosses, 0);
    const annualSale = Math.max(current.cumulativeSale - previous.cumulativeSale, 0);
    const annualReturnRate = returnRate * illustrativeReturnPath[(year - 1) % illustrativeReturnPath.length];
    const modeledReturn = assumptions.managedAssets * annualReturnRate;

    rows.push({
      year,
      returnRate: annualReturnRate,
      modeledReturn,
      annualLosses,
      annualSale,
      annualCosts: assumptions.annualCosts,
      remainingStock: current.remainingStock,
      concentration: current.concentration,
    });
  }

  return rows;
}

function drawMultiYearTimeline(rows) {
  const maxValue = Math.max(...rows.map((row) => Math.max(row.annualLosses, row.annualSale, Math.abs(row.modeledReturn))), 1);
  document.getElementById("multiYearTimeline").innerHTML = rows
    .map(
      (row) => `
        <div class="timeline-year">
          <div class="timeline-year-top">
            <span>Year ${row.year}</span>
            <strong>${pct(row.concentration * 100, 0)} concentrated</strong>
          </div>
          <div class="timeline-bars" aria-hidden="true">
            ${timelineBar("Return", row.modeledReturn, maxValue, "return-fill")}
            ${timelineBar("Losses", row.annualLosses, maxValue, "loss-fill")}
            ${timelineBar("Sold", row.annualSale, maxValue, "sale-fill")}
            ${timelineBar("Costs", row.annualCosts, maxValue, "cost-fill")}
          </div>
        </div>
      `,
    )
    .join("");
}

function timelineBar(label, value, maxValue, className) {
  return `
    <div class="timeline-bar-row">
      <span>${label}</span>
      <i><b class="${className}" style="width:${value > 0 ? clamp((value / maxValue) * 100, 3, 100) : 0}%"></b></i>
      <strong>${money(value)}</strong>
    </div>
  `;
}

function multiYearRow(row) {
  return `
    <tr>
      <td>${row.year}</td>
      <td>${pct(row.returnRate * 100, 1)}</td>
      <td>${fullMoney(row.modeledReturn)}</td>
      <td>${fullMoney(row.annualLosses)}</td>
      <td>${fullMoney(row.annualSale)}</td>
      <td>${fullMoney(row.annualCosts)}</td>
      <td>${fullMoney(row.remainingStock)} <span>${pct(row.concentration * 100, 0)}</span></td>
    </tr>
  `;
}

function renderTheoryBreakdown(assumptions, baseScenario) {
  const name = assumptions.tickers.join(", ") || "Concentrated stock";
  const coreLabel = name;
  const sleeveLong = assumptions.sleeveLongDollars;
  const sleeveShort = assumptions.sleeveShortDollars;
  const cycleLosses = baseScenario.annualLosses;
  const cycleSale = Math.min(baseScenario.saleCapacity, assumptions.plannedSale);
  const remainingAfterCycle = Math.max(assumptions.totalConcentratedValue - cycleSale, 0);
  const refilledLong = Math.max(sleeveLong + cycleSale, 0);
  const info = sleeveInfoText(assumptions, coreLabel);

  const extensionLabel = assumptions.sleeves.overlay.active
    ? `Exchange ${assumptions.sleeves.exchange.exposure.long}/${assumptions.sleeves.exchange.exposure.short} · Overlay ${assumptions.sleeves.overlay.exposure.long}/${assumptions.sleeves.overlay.exposure.short}`
    : `${assumptions.sleeves.exchange.exposure.long} / ${assumptions.sleeves.exchange.exposure.short}`;

  document.getElementById("theoryIntro").textContent =
    `This is a simplified operating example for ${assumptions.strategyProfile.label}. The same long/short mechanics power both sleeves: DEALS Exchange wraps the concentrated stock, while DEALS Overlay wraps existing assets used as collateral. The example below avoids sample stock names and instead shows the combined sleeve as diversified baskets and tax lots.`;

  document.getElementById("theorySummary").innerHTML = `
    <div><span>Sleeves funded with</span><strong>${assumptions.sleeves.overlay.active ? `${name} + other assets` : name}</strong></div>
    <div><span>Modeled extension</span><strong>${extensionLabel}</strong></div>
    <div><span>Losses in example year</span><strong>${fullMoney(cycleLosses)}</strong></div>
    <div><span>Stock sold in example year</span><strong>${fullMoney(cycleSale)}</strong></div>
  `;

  document.getElementById("theoryFlow").innerHTML = `
    ${theoryStep(
      "01",
      "Fund account",
      "Client funds the SMA and establishes benchmark, customization, and leverage settings.",
      `
        <div class="theory-account-block concentrated">
          <strong>${name}</strong>
          <span>Value ${fullMoney(assumptions.totalConcentratedValue)}</span>
          <span>Cost basis ${fullMoney(assumptions.totalBasis)}</span>
        </div>
        <div class="theory-chip-grid">
          <span>Benchmark selection</span>
          <span>Client restrictions</span>
          <span>Tax lot data</span>
          <span>Leverage setting</span>
        </div>
        <p class="theory-caption">The client keeps account ownership and transparency while the managed account is configured.</p>
      `,
    )}
    ${theoryStep(
      "02",
      "Build long/short sleeve",
      "The managed account adds benchmark-aware long and short baskets around the concentrated stock.",
      `
        <div class="theory-stack-wrap">
          <div class="theory-margin-arrow top sleeve-info-target" tabindex="0" data-sleeve-info="${escapeAttr(info.marginLong)}" title="${escapeAttr(info.marginLong)}"><span>+${money(sleeveShort)}</span></div>
          <div class="theory-position-stack">
            ${theoryPosition("Benchmark completion basket", sleeveLong * 0.42, "long", info.benchmarkCompletion)}
            ${theoryPosition("Alpha model long basket", sleeveLong * 0.34, "long mid", info.alphaLong)}
            ${theoryPosition("Constraint-aware replacements", sleeveLong * 0.24, "long dark", info.replacements)}
            ${corePosition(coreLabel, assumptions.totalConcentratedValue, info.concentrated)}
            ${theoryPosition("Diversified short basket", -sleeveShort * 0.45, "short", info.diversifiedShort)}
            ${theoryPosition("Risk offset sleeve", -sleeveShort * 0.32, "short mid", info.riskOffset)}
            ${theoryPosition("Tax-lot opportunity sleeve", -sleeveShort * 0.23, "short light", info.taxLot)}
          </div>
          <div class="theory-margin-arrow bottom sleeve-info-target" tabindex="0" data-sleeve-info="${escapeAttr(info.marginShort)}" title="${escapeAttr(info.marginShort)}"><span>-${money(sleeveShort)}</span></div>
        </div>
        <p class="theory-caption">The sleeve is shown as baskets because Quantinno describes customized benchmarks, alpha models, ESG criteria, and leverage options rather than fixed example holdings.</p>
      `,
    )}
    ${theoryStep(
      "03",
      "Harvest losses to sell stock",
      "In this one-year illustration, realized losses offset gains from selling part of the concentrated stock.",
      `
        <div class="harvest-grid">
          ${harvestRow("Long basket lot", "-" + fullMoney(cycleLosses * 0.35), "SELL")}
          ${harvestRow("Replacement lot", "+" + fullMoney(cycleLosses * 0.2), "HOLD")}
          ${harvestRow("Short basket lot", "-" + fullMoney(cycleLosses * 0.25), "CLOSE")}
          ${harvestRow("Diversified lot", "-" + fullMoney(cycleLosses * 0.4), "SELL")}
        </div>
        <div class="realized-loss-callout">
          <span>Realized loss</span>
          <strong>-${fullMoney(cycleLosses)}</strong>
        </div>
        <div class="sell-stock-callout">
          <span>Sell from ${coreLabel}</span>
          <strong>${fullMoney(cycleSale)}</strong>
        </div>
      `,
    )}
    ${theoryStep(
      "04",
      "Redeploy and rebalance",
      "Sale proceeds are redeployed into diversified exposure while the concentrated stock position steps down.",
      `
        <div class="theory-position-stack refill">
          ${theoryPosition("Diversified core equities", refilledLong * 0.42, "long", info.diversifiedCore)}
          ${theoryPosition("Benchmark-aligned replacements", refilledLong * 0.34, "long mid", info.benchmarkAligned)}
          ${theoryPosition("Alpha model selections", refilledLong * 0.24, "long dark", info.alphaSelections)}
          ${corePosition(coreLabel, remainingAfterCycle, info.remaining)}
          ${theoryPosition("Refreshed short basket", -sleeveShort * 0.45, "short", info.refreshedShort)}
          ${theoryPosition("Risk offset sleeve", -sleeveShort * 0.32, "short mid", info.riskOffset)}
          ${theoryPosition("New tax-lot candidates", -sleeveShort * 0.23, "short light", info.newLots)}
        </div>
        <p class="theory-caption">For readability, this tab uses a modeled one-year transition cycle rather than a small monthly harvest cycle.</p>
      `,
    )}
  `;
}

function sleeveInfoText(assumptions, coreLabel) {
  const profile = assumptions.strategyProfile.label;
  const plural = assumptions.tickers.length !== 1;
  return {
    marginLong: "Additional long exposure funded by the short extension. It represents more gross market exposure than the starting account value.",
    marginShort: "Short exposure used to fund the long extension and create additional tax lots that may generate harvestable losses.",
    benchmarkCompletion: "Diversified holdings intended to fill out the chosen benchmark around the concentrated stock exposure.",
    alphaLong: "Long positions selected by the manager's model after applying client restrictions and portfolio risk controls.",
    replacements: "Substitute exposures used when a security is restricted, too concentrated, or recently sold for tax-loss harvesting.",
    concentrated: `${coreLabel} ${plural ? "remain" : "remains"} the concentrated legacy position. The strategy is designed to gradually sell ${plural ? "them" : "it"} as losses become available.`,
    diversifiedShort: `A diversified short basket for the ${profile} sleeve. It helps finance the long extension and may create losses in different markets.`,
    riskOffset: "Short positions intended to reduce unwanted market, sector, or factor exposures from the concentrated stock and long basket.",
    taxLot: "Positions monitored for tax-loss harvesting opportunities. Losing lots can be sold or closed to offset gains from stock sales.",
    diversifiedCore: "Replacement equity exposure that moves the client toward the target diversified portfolio over time.",
    benchmarkAligned: "New or refreshed holdings used to keep the post-sale portfolio close to the selected benchmark.",
    alphaSelections: "Long holdings refreshed by the manager's model as the account is rebalanced after harvesting.",
    remaining: `The remaining ${coreLabel} ${plural ? "positions" : "position"} after the modeled sale cycle. ${plural ? "These should" : "This should"} decline as tax-neutral sales occur.`,
    refreshedShort: "Short exposure rebuilt after harvested positions are closed, keeping the sleeve active for future tax-loss opportunities.",
    newLots: "Fresh long or short tax lots that restart the opportunity set for the next harvesting and transition cycle.",
  };
}

function theoryStep(number, title, copy, body) {
  return `
    <article class="theory-step">
      <div class="theory-step-heading">
        <span>${number}</span>
        <div>
          <h3>${title}</h3>
          <p>${copy}</p>
        </div>
      </div>
      <div class="theory-step-body">${body}</div>
    </article>
  `;
}

function theoryPosition(name, value, className, info = "") {
  const label = `${name}: ${info}`;
  return `
    <div class="theory-position ${className} sleeve-info-target" tabindex="0" data-sleeve-info="${escapeAttr(info)}" aria-label="${escapeAttr(label)}" title="${escapeAttr(info)}">
      <span>${name}</span>
      <strong>${value < 0 ? "-" : ""}${money(Math.abs(value))}</strong>
    </div>
  `;
}

function corePosition(name, value, info = "") {
  const label = `${name}: ${info}`;
  return `
    <div class="theory-core-position sleeve-info-target" tabindex="0" data-sleeve-info="${escapeAttr(info)}" aria-label="${escapeAttr(label)}" title="${escapeAttr(info)}">
      ${name}<span>${money(value)}</span>
    </div>
  `;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function harvestRow(label, amount, action) {
  return `
    <div class="harvest-row">
      <em>${label}</em>
      <span>${amount}</span>
      <i></i>
      <strong class="${action === "HOLD" ? "hold" : ""}">${action}</strong>
    </div>
  `;
}

function renderPositions() {
  positionsBody.innerHTML = positions
    .map((position) => {
      const value = positionValue(position);
      const gain = positionGain(position);
      const isLiveUpdated = lastUpdatedTickers.has(position.ticker);
      return `
        <tr data-id="${position.id}">
          <td><input class="table-input ticker-input" data-field="ticker" value="${position.ticker}" maxlength="8" /></td>
          <td><input class="table-input numeric-input" data-field="shares" type="number" min="0" step="1" value="${position.shares}" /></td>
          <td>
            <input class="table-input numeric-input ${isLiveUpdated ? "price-live-updated" : ""}" data-field="price" type="number" min="0" step="0.01" value="${position.price}" />
            ${isLiveUpdated ? '<small class="live-price-note">Live updated</small>' : ""}
          </td>
          <td><input class="table-input numeric-input" data-field="basis" type="number" min="0" step="1000" value="${position.basis}" /></td>
          <td>${fullMoney(value)}</td>
          <td>${fullMoney(gain)} <span>${pct(gainRatio(position) * 100, 0)}</span></td>
          <td><button class="row-button" type="button" data-action="remove" aria-label="Remove ${position.ticker}">×</button></td>
        </tr>
      `;
    })
    .join("");

  const totalValue = positions.reduce((sum, position) => sum + positionValue(position), 0);
  const totalGain = positions.reduce((sum, position) => sum + positionGain(position), 0);
  const totalBasis = positions.reduce((sum, position) => sum + position.basis, 0);
  document.getElementById("positionsTotals").innerHTML = `
    <tr>
      <td>Total concentrated</td>
      <td></td>
      <td></td>
      <td>${fullMoney(totalBasis)}</td>
      <td>${fullMoney(totalValue)}</td>
      <td>${fullMoney(totalGain)} <span>${pct(totalValue > 0 ? (totalGain / totalValue) * 100 : 0, 0)}</span></td>
      <td></td>
    </tr>
  `;
}

function updatePosition(id, field, value) {
  positions = positions.map((position) => {
    if (position.id !== id) return position;
    if (field === "ticker") return { ...position, ticker: value.trim().toUpperCase() };
    return { ...position, [field]: numberValue(value) };
  });
  markScenarioDirty();
  renderPositions();
  updateOutputs();
}

function addPosition() {
  positions.push({ id: crypto.randomUUID(), ticker: "MSFT", shares: 1000, price: 400, basis: 200000 });
  markScenarioDirty();
  renderPositions();
  updateOutputs();
  scheduleAutoRefresh();
}

function removePosition(id) {
  if (positions.length === 1) return;
  positions = positions.filter((position) => position.id !== id);
  markScenarioDirty();
  renderPositions();
  updateOutputs();
}

async function refreshPrices() {
  const apiKey = storedFinnhubKey();
  const symbols = positions.map((position) => position.ticker).filter(Boolean);
  if (!symbols.length) return;

  priceStatus.textContent = "Refreshing prices from Finnhub...";
  try {
    const params = new URLSearchParams({ symbols: symbols.join(",") });
    if (apiKey) params.set("token", apiKey);
    const response = await fetch(`/api/quotes?${params.toString()}`);
    let payload = await response.json();
    if (!response.ok) {
      const errorMessage = payload.error || "Unable to refresh prices.";
      const serverNeedsEnvKey = /missing\s+finnhub_api_key/i.test(errorMessage);
      if (serverNeedsEnvKey && apiKey) {
        payload = await fetchFinnhubQuotesDirectly(symbols, apiKey);
      } else {
        throw new Error(errorMessage);
      }
    }
    const quotes = new Map(payload.quotes.map((quote) => [quote.symbol, quote]));
    positions = positions.map((position) => {
      const quote = quotes.get(position.ticker);
      return quote && quote.price > 0 ? { ...position, price: Number(quote.price.toFixed(2)) } : position;
    });
    const updatedRows = positions
      .filter((position) => quotes.has(position.ticker) && quotes.get(position.ticker).price > 0)
      .map((position) => `${position.ticker}: ${fullMoneyCents(position.price)}`);
    const matchedCount = updatedRows.length;
    if (!matchedCount) {
      lastUpdatedTickers = new Set();
      priceStatus.textContent = "Finnhub responded, but no valid prices were returned for the current tickers.";
    } else {
      lastUpdatedTickers = new Set(
        positions.filter((position) => quotes.has(position.ticker) && quotes.get(position.ticker).price > 0).map((position) => position.ticker),
      );
      lastPriceUpdateAt = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
      priceStatus.textContent =
        `Updated ${matchedCount} ticker price${matchedCount === 1 ? "" : "s"} at ${lastPriceUpdateAt}: ${updatedRows.join(" | ")}`;
    }
    renderPositions();
    updateOutputs();
  } catch (error) {
    priceStatus.textContent = error.message;
  }
}

function resetAssumptions() {
  Object.entries(defaults).forEach(([id, value]) => {
    inputs[id].value = value;
    syncPairedSlider(id);
  });
  positions = [
    { id: crypto.randomUUID(), ticker: "PLTR", shares: 20000, price: 100, basis: 400000 },
    { id: crypto.randomUUID(), ticker: "GOOGL", shares: 5000, price: 200, basis: 600000 },
  ];
  lastUpdatedTickers = new Set();
  refreshPriceStatus();
  if (scenarioSelect) scenarioSelect.value = "";
  renderPositions();
  updateOutputs();
}

// --- Bulk import: paste raw lot rows from a DEALS Portfolio Holdings
// Template export and aggregate them into one row per ticker. ---

const TICKER_TOKEN_BLOCKLIST = new Set([
  "TICKER", "QUANTITY", "PRICE", "TOTAL", "DEALS", "CORE", "EXCHANGE", "OVERLAY",
  "CASH", "USD", "PORTFOLIO", "HOLDINGS", "TEMPLATE", "VALUE", "BASIS", "MARKET",
  "COST", "SHARES", "MSCI", "WORLD", "ACWI", "RUSSELL", "SP", "NUMBERS", "SHEET",
  "WORKSPACE", "TABLE", "EXPORT", "SUMMARY",
]);

function looksLikeTicker(token) {
  const cleaned = token.replace(/[^A-Za-z.]/g, "");
  if (!cleaned || cleaned.length > 8 || /^\d/.test(token)) return false;
  if (TICKER_TOKEN_BLOCKLIST.has(cleaned.toUpperCase())) return false;
  return /^[A-Za-z][A-Za-z.]*$/.test(cleaned);
}

function parseBulkImportLots(text) {
  const lines = text.split(/\r?\n/);
  const totals = new Map();
  let matchedRows = 0;
  let skippedRows = 0;

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const rawFields = (trimmed.includes("\t") ? trimmed.split("\t") : trimmed.split(","))
      .map((field) => field.trim())
      .filter(Boolean);
    if (!rawFields.length) return;

    const tickerField = rawFields.find((field) => looksLikeTicker(field));
    if (!tickerField) {
      skippedRows += 1;
      return;
    }
    const ticker = tickerField.replace(/[^A-Za-z.]/g, "").toUpperCase();

    const numericFields = rawFields.filter((field) => field !== tickerField && /\d/.test(field)).map(numberValue);
    if (numericFields.length < 3) {
      skippedRows += 1;
      return;
    }

    const [shares, marketValue, costBasis] = numericFields;
    if (!(shares > 0)) {
      skippedRows += 1;
      return;
    }

    const existing = totals.get(ticker) || { shares: 0, marketValue: 0, costBasis: 0 };
    existing.shares += shares;
    existing.marketValue += marketValue;
    existing.costBasis += costBasis;
    totals.set(ticker, existing);
    matchedRows += 1;
  });

  const importedPositions = [...totals.entries()].map(([ticker, lotTotals]) => ({
    id: crypto.randomUUID(),
    ticker,
    shares: Math.round(lotTotals.shares * 100) / 100,
    price: lotTotals.shares > 0 ? Math.round((lotTotals.marketValue / lotTotals.shares) * 100) / 100 : 0,
    basis: Math.round(lotTotals.costBasis * 100) / 100,
  }));

  return { importedPositions, matchedRows, skippedRows };
}

function toggleBulkImportPanel(show) {
  bulkImportPanel.hidden = !show;
  if (show) {
    bulkImportStatus.textContent = "";
    bulkImportInput.focus();
  }
}

function applyBulkImport() {
  const { importedPositions, matchedRows, skippedRows } = parseBulkImportLots(bulkImportInput.value);
  if (!importedPositions.length) {
    bulkImportStatus.textContent = "No valid rows found. Expected Ticker, Quantity, Market Value, Cost Basis per row.";
    return;
  }
  positions = importedPositions;
  markScenarioDirty();
  renderPositions();
  updateOutputs();
  const tickerCount = importedPositions.length;
  bulkImportStatus.textContent =
    `Imported ${tickerCount} ticker${tickerCount === 1 ? "" : "s"} from ${matchedRows} lot row${matchedRows === 1 ? "" : "s"}` +
    (skippedRows ? ` (${skippedRows} row${skippedRows === 1 ? "" : "s"} skipped).` : ".");
  bulkImportInput.value = "";
}

// --- Named client scenarios: save/load the full set of assumptions and
// positions to localStorage so an advisor can switch between clients. ---

function loadSavedScenarios() {
  try {
    return JSON.parse(localStorage.getItem(SCENARIOS_STORAGE_KEY) || "{}");
  } catch (error) {
    return {};
  }
}

function persistSavedScenarios(scenarios) {
  localStorage.setItem(SCENARIOS_STORAGE_KEY, JSON.stringify(scenarios));
}

// Deselects the saved-scenario dropdown as soon as the user changes anything,
// so it never shows a client name next to data that no longer matches it.
function markScenarioDirty() {
  if (scenarioSelect.value) scenarioSelect.value = "";
}

function refreshScenarioOptions(selectedName = "") {
  const scenarios = loadSavedScenarios();
  const names = Object.keys(scenarios).sort((left, right) => left.localeCompare(right));
  scenarioSelect.innerHTML =
    `<option value="">— Current (unsaved) —</option>` +
    names.map((name) => `<option value="${escapeAttr(name)}">${escapeAttr(name)}</option>`).join("");
  scenarioSelect.value = names.includes(selectedName) ? selectedName : "";
}

function captureCurrentScenario() {
  const snapshot = {};
  ids.forEach((id) => {
    snapshot[id] = inputs[id].value;
  });
  snapshot.positions = positions.map(({ ticker, shares, price, basis }) => ({ ticker, shares, price, basis }));
  return snapshot;
}

function applyScenario(snapshot) {
  ids.forEach((id) => {
    if (snapshot[id] === undefined) return;
    inputs[id].value = snapshot[id];
    syncPairedSlider(id);
  });
  positions = (snapshot.positions || []).map((position) => ({ id: crypto.randomUUID(), ...position }));
  if (!positions.length) {
    positions = [{ id: crypto.randomUUID(), ticker: "MSFT", shares: 1000, price: 400, basis: 200000 }];
  }
  lastUpdatedTickers = new Set();
  renderPositions();
  updateOutputs();
}

function saveScenario() {
  const name = window.prompt("Save this scenario as:", scenarioSelect.value || "");
  if (!name) return;
  const scenarios = loadSavedScenarios();
  scenarios[name] = captureCurrentScenario();
  persistSavedScenarios(scenarios);
  refreshScenarioOptions(name);
  scenarioStatus.textContent = `Saved "${name}". Switch clients anytime from the dropdown above.`;
}

function loadScenario(name) {
  if (!name) return;
  const scenarios = loadSavedScenarios();
  const snapshot = scenarios[name];
  if (!snapshot) return;
  applyScenario(snapshot);
  scenarioStatus.textContent = `Loaded "${name}".`;
}

function deleteScenario() {
  const name = scenarioSelect.value;
  if (!name) return;
  const scenarios = loadSavedScenarios();
  delete scenarios[name];
  persistSavedScenarios(scenarios);
  refreshScenarioOptions();
  scenarioStatus.textContent = `Deleted "${name}".`;
}

function scheduleAutoRefresh(delay = 500) {
  clearTimeout(autoRefreshTimer);
  autoRefreshTimer = setTimeout(() => {
    refreshPrices();
  }, delay);
}

function saveFinnhubKey() {
  const key = finnhubApiKeyInput.value.trim();
  if (!key) {
    localStorage.removeItem(FINNHUB_KEY_STORAGE_KEY);
    refreshPriceStatus();
    return;
  }
  localStorage.setItem(FINNHUB_KEY_STORAGE_KEY, key);
  refreshPriceStatus();
  scheduleAutoRefresh(0);
}

function clearFinnhubKey() {
  finnhubApiKeyInput.value = "";
  localStorage.removeItem(FINNHUB_KEY_STORAGE_KEY);
  refreshPriceStatus();
}

function setActiveTab(tabName) {
  document.querySelectorAll(".tab-button").forEach((button) => {
    const isActive = button.dataset.tab === tabName;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${tabName}View`);
  });
}

ids.forEach((id) =>
  inputs[id].addEventListener("input", () => {
    markScenarioDirty();
    updateOutputs();
  }),
);
pairedSliderIds.forEach(wirePairedSlider);
document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => setActiveTab(button.dataset.tab));
});
document.getElementById("resetButton").addEventListener("click", resetAssumptions);
document.getElementById("printButton").addEventListener("click", () => window.print());
document.getElementById("addPositionButton").addEventListener("click", addPosition);
document.getElementById("refreshPricesButton").addEventListener("click", refreshPrices);
saveFinnhubKeyButton.addEventListener("click", saveFinnhubKey);
clearFinnhubKeyButton.addEventListener("click", clearFinnhubKey);
finnhubApiKeyInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveFinnhubKey();
});

bulkImportToggle.addEventListener("click", () => toggleBulkImportPanel(bulkImportPanel.hidden));
bulkImportCancelButton.addEventListener("click", () => toggleBulkImportPanel(false));
bulkImportApplyButton.addEventListener("click", applyBulkImport);

scenarioSelect.addEventListener("change", () => loadScenario(scenarioSelect.value));
saveScenarioButton.addEventListener("click", saveScenario);
deleteScenarioButton.addEventListener("click", deleteScenario);

positionsBody.addEventListener("change", (event) => {
  const row = event.target.closest("tr");
  const field = event.target.dataset.field;
  if (!row || !field) return;
  updatePosition(row.dataset.id, field, event.target.value);
  if (field === "ticker") scheduleAutoRefresh();
});

positionsBody.addEventListener("click", (event) => {
  if (event.target.dataset.action !== "remove") return;
  const row = event.target.closest("tr");
  if (row) removePosition(row.dataset.id);
});

const initialStoredKey = storedFinnhubKey();
if (initialStoredKey) finnhubApiKeyInput.value = initialStoredKey;
resetAssumptions();
refreshScenarioOptions();
if (positions.length) scheduleAutoRefresh(0);
