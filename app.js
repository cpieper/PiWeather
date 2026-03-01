const canvas = document.getElementById("chart");
const ctx = canvas.getContext("2d");

const keys = ["pressure", "humidity", "temperature"];

const initialControls = {
  pressure: document.getElementById("initialPressureInput"),
  humidity: document.getElementById("initialHumidityInput"),
  temperature: document.getElementById("initialTemperatureInput")
};

const disturbanceControls = {
  pressure: document.getElementById("pressureInput"),
  humidity: document.getElementById("humidityInput"),
  temperature: document.getElementById("temperatureInput")
};

const outputs = {
  initialPressure: document.getElementById("initialPressureValue"),
  initialHumidity: document.getElementById("initialHumidityValue"),
  initialTemperature: document.getElementById("initialTemperatureValue"),
  pressure: document.getElementById("pressureValue"),
  humidity: document.getElementById("humidityValue"),
  temperature: document.getElementById("temperatureValue"),
  radius: document.getElementById("radiusValue"),
  es: document.getElementById("esValue"),
  qs: document.getElementById("qsValue"),
  rhBounds: document.getElementById("rhBoundsValue"),
  rhActive: document.getElementById("rhActiveValue")
};

const originInput = document.getElementById("originInput");
const radiusInput = document.getElementById("radiusInput");
const boundsToggle = document.getElementById("boundsToggle");
const couplingToggle = document.getElementById("couplingToggle");
const driftToggle = document.getElementById("driftToggle");
const constraintNote = document.getElementById("constraintNote");

const GRID_W = 34;
const GRID_H = 26;
const CELL_COUNT = GRID_W * GRID_H;
const DT = 0.1;
const HISTORY_LENGTH = 420;
const HUD_VALUE_Y = 34;
const DIAGNOSTIC_PANEL_H = 108;
const DIAGNOSTIC_PANEL_SIDE = 36;
const DIAGNOSTIC_PANEL_BOTTOM = 30;

const BASELINE_DRIFT_RATE = 0.006;
const EPSILON = 0.622; // Rd/Rv
const MIXING_RATIO_MIN = 0.00001; // kg/kg (0.01 g/kg)
const MIXING_RATIO_MAX = 0.028; // kg/kg (28 g/kg)

const CONDENSATION_FRACTION = 0.28;
const LATENT_HEATING_GAIN = 260; // degC per kg/kg condensed
const EVAPORATION_FRACTION = 0.035;
const EVAPORATIVE_COOLING_GAIN = 140; // degC per kg/kg evaporated
const DIAGNOSTIC_RANGES = {
  meanQ: { min: 0, max: 30 }, // g/kg
  meanRh: { min: 0, max: 100 }, // %
  supersatFraction: { min: 0, max: 100 } // %
};

const DEFAULT_INITIAL = {
  pressure: 1013.25,
  humidity: 60,
  temperature: 15
};

const RANGE_PRESETS = {
  physical: {
    pressure: { min: 870, max: 1085, step: 0.25 },
    humidity: { min: 0, max: 100, step: 1 },
    temperature: { min: -50, max: 50, step: 0.5 }
  },
  exploratory: {
    pressure: { min: 820, max: 1120, step: 0.25 },
    humidity: { min: 0, max: 100, step: 1 },
    temperature: { min: -70, max: 65, step: 0.5 }
  }
};

const fieldSpec = {
  pressure: {
    label: "Pressure",
    unit: "hPa",
    color: getCssVar("--pressure"),
    diffusion: 0.21,
    relax: 0.14,
    drag: 0.3,
    visualScale: 6,
    layerOffset: 0
  },
  humidity: {
    label: "Humidity",
    unit: "%RH",
    color: getCssVar("--humidity"),
    diffusion: 0.16,
    relax: 0.08,
    drag: 0.5,
    visualScale: 22,
    layerOffset: 14
  },
  temperature: {
    label: "Temperature",
    unit: "\u00b0C",
    color: getCssVar("--temperature"),
    diffusion: 0.18,
    relax: 0.11,
    drag: 0.32,
    visualScale: 6,
    layerOffset: 28
  }
};

// Signed couplings with physically motivated directions.
const coupling = {
  pressureFromTemperature: -0.025, // warmer parcel -> lower pressure tendency
  temperatureFromPressure: 0.015, // compression warming / expansion cooling
  temperatureFromMoisture: 38 // moist anomaly has weak warming tendency
};

const fields = {
  pressure: makeFieldState(),
  temperature: makeFieldState(),
  humidity: makeFieldState() // stored as specific humidity q (kg/kg)
};
const condensate = new Float32Array(CELL_COUNT); // cloud water proxy (kg/kg)

let humidityBaselineRh = DEFAULT_INITIAL.humidity;
const referenceMeans = {
  pressure: DEFAULT_INITIAL.pressure,
  humidityRh: DEFAULT_INITIAL.humidity,
  temperature: DEFAULT_INITIAL.temperature
};
const humidityRhCache = new Float32Array(CELL_COUNT);
let latestSupersaturatedCount = 0;
const diagnostics = {
  meanQ: [],
  meanRh: [],
  supersatFraction: []
};

const legend = document.getElementById("legend");
legend.innerHTML = keys
  .map(
    (key) =>
      `<span class="legend-item"><span class="swatch" style="background:${fieldSpec[key].color}"></span>${fieldSpec[key].label}</span>`
  )
  .join("");

setupListeners();
resetAll();
tick();

function makeFieldState() {
  return {
    value: new Float32Array(CELL_COUNT),
    velocity: new Float32Array(CELL_COUNT),
    nextVelocity: new Float32Array(CELL_COUNT),
    baseline: 0
  };
}

function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function setupListeners() {
  for (const key of keys) {
    initialControls[key].addEventListener("input", onInitialControlInput);
    disturbanceControls[key].addEventListener("input", updateReadouts);
  }

  radiusInput.addEventListener("input", updateReadouts);
  boundsToggle.addEventListener("change", () => {
    if (!boundsToggle.checked) {
      couplingToggle.checked = false;
    }
    applyConstraintRanges();
    applyInitialConditions();
  });

  couplingToggle.addEventListener("change", () => {
    if (couplingToggle.checked) {
      boundsToggle.checked = true;
    }
    applyConstraintRanges();
    applyInitialConditions();
  });

  driftToggle.addEventListener("change", () => {
    updateConstraintNote();
  });

  document.getElementById("applyInitialBtn").addEventListener("click", applyInitialConditions);
  document.getElementById("injectBtn").addEventListener("click", injectDisturbance);
  document.getElementById("resetBtn").addEventListener("click", resetAll);
}

function onInitialControlInput() {
  applyConstraintRanges();
}

function getRangePreset() {
  return boundsToggle.checked ? RANGE_PRESETS.physical : RANGE_PRESETS.exploratory;
}

function getInitialValues() {
  return {
    pressure: Number(initialControls.pressure.value),
    humidity: Number(initialControls.humidity.value),
    temperature: Number(initialControls.temperature.value)
  };
}

function applyConstraintRanges() {
  for (let pass = 0; pass < 2; pass += 1) {
    const values = getInitialValues();

    for (const key of keys) {
      const range = getAllowedRange(key, values);
      const input = initialControls[key];

      input.min = String(range.min);
      input.max = String(range.max);
      input.step = String(range.step);

      const clamped = roundToStep(clamp(Number(input.value), range.min, range.max), range.step);
      input.value = String(clamped);
    }
  }

  updateConstraintNote();
  updateReadouts();
}

function getAllowedRange(key, values) {
  const base = { ...getRangePreset()[key] };
  if (!couplingToggle.checked) {
    return base;
  }

  if (key === "humidity") {
    const saturationMixingRatio = getSaturationMixingRatio(values.pressure, values.temperature);
    const humidityMin = (MIXING_RATIO_MIN / saturationMixingRatio) * 100;
    const humidityMax = (MIXING_RATIO_MAX / saturationMixingRatio) * 100;

    base.min = clamp(humidityMin, base.min, 99);
    base.max = clamp(humidityMax, 1, base.max);
  }

  if (base.min > base.max) {
    const mid = (base.min + base.max) / 2;
    base.min = mid - base.step;
    base.max = mid + base.step;
  }

  return base;
}

function getSaturationVaporPressureHpa(temperatureC) {
  if (temperatureC >= 0) {
    return 6.112 * Math.exp((17.67 * temperatureC) / (temperatureC + 243.5));
  }

  return 6.112 * Math.exp((22.46 * temperatureC) / (temperatureC + 272.62));
}

function getSaturationMixingRatio(pressureHpa, temperatureC) {
  const es = getSaturationVaporPressureHpa(temperatureC);
  const safeEs = Math.min(es, pressureHpa * 0.99);
  const denominator = Math.max(pressureHpa - safeEs, 0.01);
  return (EPSILON * safeEs) / denominator;
}

function humidityFromMixingRatio(q, pressureHpa, temperatureC) {
  const qs = getSaturationMixingRatio(pressureHpa, temperatureC);
  if (qs <= 0) {
    return 0;
  }
  return clamp((q / qs) * 100, 0, 140);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function roundToStep(value, step) {
  return Math.round(value / step) * step;
}

function updateConstraintNote() {
  const values = getInitialValues();
  const p = getAllowedRange("pressure", values);
  const h = getAllowedRange("humidity", values);
  const t = getAllowedRange("temperature", values);

  const mode = boundsToggle.checked ? "Physical mode" : "Exploration mode";
  const linked = couplingToggle.checked ? "with saturation limits" : "without saturation limits";
  const driftState = driftToggle.checked ? "adaptive equilibrium" : "fixed equilibrium";

  constraintNote.textContent =
    `${mode} ${linked}: ` +
    `P ${formatInitial("pressure", p.min)}-${formatInitial("pressure", p.max)} hPa, ` +
    `RH ${formatInitial("humidity", h.min)}-${formatInitial("humidity", h.max)}%, ` +
    `T ${formatInitial("temperature", t.min)}-${formatInitial("temperature", t.max)} \u00b0C, ${driftState}`;

  updatePhysicsPanel(values, h);
}

function updatePhysicsPanel(values, humidityRange) {
  const es = getSaturationVaporPressureHpa(values.temperature);
  const qs = getSaturationMixingRatio(values.pressure, values.temperature);
  const rhLow = clamp((MIXING_RATIO_MIN / qs) * 100, 0, 100);
  const rhHigh = clamp((MIXING_RATIO_MAX / qs) * 100, 0, 100);

  outputs.es.textContent = `${es.toFixed(2)} hPa`;
  outputs.qs.textContent = `${(qs * 1000).toFixed(2)} g/kg`;
  outputs.rhBounds.textContent = `${Math.round(rhLow)}-${Math.round(rhHigh)} %`;
  outputs.rhActive.textContent = `${Math.round(humidityRange.min)}-${Math.round(humidityRange.max)} %`;
}

function updateReadouts() {
  outputs.initialPressure.textContent = formatInitial("pressure", Number(initialControls.pressure.value));
  outputs.initialHumidity.textContent = formatInitial("humidity", Number(initialControls.humidity.value));
  outputs.initialTemperature.textContent = formatInitial(
    "temperature",
    Number(initialControls.temperature.value)
  );

  outputs.pressure.textContent = disturbanceControls.pressure.value;
  outputs.humidity.textContent = disturbanceControls.humidity.value;
  outputs.temperature.textContent = disturbanceControls.temperature.value;
  outputs.radius.textContent = radiusInput.value;
}

function formatInitial(key, value) {
  if (key === "pressure") {
    return value.toFixed(2);
  }

  if (key === "temperature") {
    return value.toFixed(1);
  }

  return Math.round(value).toString();
}

function applyInitialConditions() {
  const initial = getInitialValues();

  fields.pressure.baseline = initial.pressure;
  fields.temperature.baseline = initial.temperature;
  fields.humidity.baseline = (initial.humidity / 100) * getSaturationMixingRatio(initial.pressure, initial.temperature);
  humidityBaselineRh = initial.humidity;
  referenceMeans.pressure = initial.pressure;
  referenceMeans.humidityRh = initial.humidity;
  referenceMeans.temperature = initial.temperature;

  for (let i = 0; i < CELL_COUNT; i += 1) {
    fields.pressure.value[i] = fields.pressure.baseline;
    fields.temperature.value[i] = fields.temperature.baseline;
    fields.humidity.value[i] = fields.humidity.baseline;
    condensate[i] = 0;

    for (const state of Object.values(fields)) {
      state.velocity[i] = 0;
      state.nextVelocity[i] = 0;
    }
  }

  refreshHumidityCache();
  resetDiagnostics();
}

function resetAll() {
  initialControls.pressure.value = String(DEFAULT_INITIAL.pressure);
  initialControls.humidity.value = String(DEFAULT_INITIAL.humidity);
  initialControls.temperature.value = String(DEFAULT_INITIAL.temperature);

  for (const input of Object.values(disturbanceControls)) {
    input.value = "0";
  }

  boundsToggle.checked = true;
  couplingToggle.checked = true;
  driftToggle.checked = true;
  radiusInput.value = "4";
  originInput.value = "northwest";

  applyConstraintRanges();
  updateReadouts();
  applyInitialConditions();
}

function injectDisturbance() {
  const origin = getOriginCoord(originInput.value);
  const radius = Number(radiusInput.value);

  const pAmount = Number(disturbanceControls.pressure.value);
  const rhAmount = Number(disturbanceControls.humidity.value);
  const tAmount = Number(disturbanceControls.temperature.value);

  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      const idx = y * GRID_W + x;
      const distance = torusDistance(x, y, origin.x, origin.y);
      const mask = Math.exp(-(distance * distance) / (2 * radius * radius));
      if (mask < 0.02) {
        continue;
      }

      if (pAmount !== 0) {
        fields.pressure.value[idx] += pAmount * mask;
        fields.pressure.velocity[idx] += pAmount * 0.11 * mask;
      }

      if (tAmount !== 0) {
        fields.temperature.value[idx] += tAmount * mask;
        fields.temperature.velocity[idx] += tAmount * 0.11 * mask;
      }

      if (rhAmount !== 0) {
        const p = fields.pressure.value[idx];
        const t = fields.temperature.value[idx];
        const qs = getSaturationMixingRatio(p, t);
        const deltaQ = (rhAmount / 100) * qs * mask;
        fields.humidity.value[idx] = Math.max(0, fields.humidity.value[idx] + deltaQ);
        fields.humidity.velocity[idx] += deltaQ * 2.2;
      }
    }
  }

  refreshHumidityCache();
}

function getOriginCoord(origin) {
  const centerX = Math.floor(GRID_W / 2);
  const centerY = Math.floor(GRID_H / 2);

  switch (origin) {
    case "north":
      return { x: centerX, y: 0 };
    case "south":
      return { x: centerX, y: GRID_H - 1 };
    case "west":
      return { x: 0, y: centerY };
    case "east":
      return { x: GRID_W - 1, y: centerY };
    case "northeast":
      return { x: GRID_W - 1, y: 0 };
    case "southwest":
      return { x: 0, y: GRID_H - 1 };
    case "southeast":
      return { x: GRID_W - 1, y: GRID_H - 1 };
    case "center":
      return { x: centerX, y: centerY };
    case "northwest":
    default:
      return { x: 0, y: 0 };
  }
}

function wrappedDelta(a, b, span) {
  const direct = Math.abs(a - b);
  return Math.min(direct, span - direct);
}

function torusDistance(x1, y1, x2, y2) {
  const dx = wrappedDelta(x1, x2, GRID_W);
  const dy = wrappedDelta(y1, y2, GRID_H);
  return Math.hypot(dx, dy);
}

function stepField(key) {
  const state = fields[key];
  const values = state.value;
  const velocity = state.velocity;
  const nextVelocity = state.nextVelocity;
  const baseline = state.baseline;

  for (let y = 0; y < GRID_H; y += 1) {
    const yUp = (y - 1 + GRID_H) % GRID_H;
    const yDown = (y + 1) % GRID_H;

    for (let x = 0; x < GRID_W; x += 1) {
      const xLeft = (x - 1 + GRID_W) % GRID_W;
      const xRight = (x + 1) % GRID_W;
      const idx = y * GRID_W + x;

      const center = values[idx];
      const laplacian =
        values[y * GRID_W + xLeft] +
        values[y * GRID_W + xRight] +
        values[yUp * GRID_W + x] +
        values[yDown * GRID_W + x] -
        center * 4;

      let tendency =
        fieldSpec[key].diffusion * laplacian -
        fieldSpec[key].relax * (center - baseline) -
        fieldSpec[key].drag * velocity[idx];

      if (key === "pressure") {
        const tempAnomaly = fields.temperature.value[idx] - fields.temperature.baseline;
        tendency += coupling.pressureFromTemperature * tempAnomaly;
      }

      if (key === "temperature") {
        const pressureAnomaly = fields.pressure.value[idx] - fields.pressure.baseline;
        const moistureAnomaly = fields.humidity.value[idx] - fields.humidity.baseline;
        tendency += coupling.temperatureFromPressure * pressureAnomaly;
        tendency += coupling.temperatureFromMoisture * moistureAnomaly;
      }

      if (key === "humidity") {
        // Keep moisture non-negative while allowing advection-like persistence.
        tendency = Math.max(tendency, -values[idx] * 1.6);
      }

      nextVelocity[idx] = velocity[idx] + tendency * DT;
    }
  }
}

function advanceSystem() {
  stepField("pressure");
  stepField("temperature");
  stepField("humidity");

  for (const key of ["pressure", "temperature", "humidity"]) {
    const state = fields[key];
    const values = state.value;
    const velocity = state.velocity;
    const nextVelocity = state.nextVelocity;

    for (let i = 0; i < CELL_COUNT; i += 1) {
      velocity[i] = nextVelocity[i];
      values[i] += velocity[i] * DT;
    }
  }

  applyPhaseChange();
  refreshHumidityCache();
  updateDiagnostics();

  if (driftToggle.checked) {
    fields.pressure.baseline += (meanValue(fields.pressure.value) - fields.pressure.baseline) * BASELINE_DRIFT_RATE;
    fields.temperature.baseline +=
      (meanValue(fields.temperature.value) - fields.temperature.baseline) * BASELINE_DRIFT_RATE;
    fields.humidity.baseline += (meanValue(fields.humidity.value) - fields.humidity.baseline) * BASELINE_DRIFT_RATE;
    humidityBaselineRh += (meanValue(humidityRhCache) - humidityBaselineRh) * BASELINE_DRIFT_RATE;
  }
}

function applyPhaseChange() {
  latestSupersaturatedCount = 0;

  for (let i = 0; i < CELL_COUNT; i += 1) {
    const p = fields.pressure.value[i];
    const t = fields.temperature.value[i];
    const qs = getSaturationMixingRatio(p, t);

    if (fields.humidity.value[i] > qs) {
      latestSupersaturatedCount += 1;
      const excess = fields.humidity.value[i] - qs;
      const condensed = excess * CONDENSATION_FRACTION;
      fields.humidity.value[i] -= condensed;
      condensate[i] += condensed;
      fields.temperature.value[i] += condensed * LATENT_HEATING_GAIN;
    } else if (fields.humidity.value[i] < qs) {
      const deficit = qs - fields.humidity.value[i];
      const evaporativeTarget = deficit * EVAPORATION_FRACTION;
      const evaporated = Math.min(condensate[i], evaporativeTarget);
      condensate[i] -= evaporated;
      fields.humidity.value[i] += evaporated;
      fields.temperature.value[i] -= evaporated * EVAPORATIVE_COOLING_GAIN;
    }

    if (fields.humidity.value[i] < 0) {
      fields.humidity.value[i] = 0;
    }
  }
}

function refreshHumidityCache() {
  for (let i = 0; i < CELL_COUNT; i += 1) {
    const p = fields.pressure.value[i];
    const t = fields.temperature.value[i];
    const q = fields.humidity.value[i];
    humidityRhCache[i] = humidityFromMixingRatio(q, p, t);
  }
}

function getCellAnomaly(key, idx) {
  if (key === "humidity") {
    return humidityRhCache[idx] - humidityBaselineRh;
  }

  return fields[key].value[idx] - fields[key].baseline;
}

function projectPoint(gx, gy, layerOffset, magnitude) {
  const projection = getProjectionConfig();
  const renderMagnitude = clamp(magnitude, -3.2, 3.2);

  const isoX = (gx - gy) * projection.tileX;
  const isoY = (gx + gy) * projection.tileY;

  return {
    x: projection.originX + isoX,
    y: projection.originY + isoY + layerOffset - renderMagnitude * projection.elev
  };
}

function getCanvasRegions() {
  const sideInset = Math.min(DIAGNOSTIC_PANEL_SIDE, Math.max(16, canvas.width * 0.04));
  const bottomInset = Math.min(DIAGNOSTIC_PANEL_BOTTOM, Math.max(14, canvas.height * 0.035));
  const matrixTop = Math.max(64, HUD_VALUE_Y + 34);
  const minMatrixHeight = 150;

  let diagnosticsHeight = Math.min(DIAGNOSTIC_PANEL_H, Math.max(74, canvas.height * 0.24));
  let diagnosticsY = canvas.height - diagnosticsHeight - bottomInset;
  let matrixBottom = diagnosticsY - 14;

  if (matrixBottom - matrixTop < minMatrixHeight) {
    diagnosticsHeight = Math.max(68, canvas.height - bottomInset - matrixTop - 14 - minMatrixHeight);
    diagnosticsY = canvas.height - diagnosticsHeight - bottomInset;
    matrixBottom = diagnosticsY - 14;
  }

  const diagnostics = {
    x: sideInset,
    y: diagnosticsY,
    w: canvas.width - sideInset * 2,
    h: diagnosticsHeight
  };

  return {
    diagnostics,
    matrix: {
      top: matrixTop,
      bottom: matrixBottom,
      sideMargin: 16
    },
    wrapHintY: diagnostics.y - 16
  };
}

function getProjectionConfig() {
  const regions = getCanvasRegions();
  const span = GRID_W + GRID_H - 2;
  const elev = 5.0;
  const renderMagnitudeLimit = 3.2;
  const minLayerOffset = 0;
  const maxLayerOffset = 36;
  const verticalPad = maxLayerOffset - minLayerOffset + renderMagnitudeLimit * elev * 2;

  const availableWidth = canvas.width - regions.matrix.sideMargin * 2;
  const availableHeight = Math.max(80, regions.matrix.bottom - regions.matrix.top);
  const maxTileXByWidth = availableWidth / span;
  const maxTileYByHeight = Math.max((availableHeight - verticalPad) / span, 0.4);
  const maxTileYByWidth = Math.max(maxTileXByWidth / 1.75, 0.4);
  const tileY = Math.min(maxTileYByHeight, maxTileYByWidth);
  const tileX = tileY * 1.75;

  const centeredX =
    (regions.matrix.sideMargin + canvas.width - regions.matrix.sideMargin) / 2 - ((GRID_W - GRID_H) * tileX) / 2;
  const occupiedHeight = span * tileY + verticalPad;
  const matrixSlack = Math.max(0, availableHeight - occupiedHeight);
  const centeredY = regions.matrix.top + matrixSlack / 2 - minLayerOffset + renderMagnitudeLimit * elev;

  return {
    originX: centeredX,
    originY: centeredY,
    tileX,
    tileY,
    elev
  };
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawSurfaceGuide();

  for (const key of keys) {
    drawFieldLayer(key);
  }

  drawWrapHint();
  drawAverages();
  drawDiagnosticsStrip();
}

function drawSurfaceGuide() {
  const nw = projectPoint(0, 0, 36, 0);
  const ne = projectPoint(GRID_W - 1, 0, 36, 0);
  const sw = projectPoint(0, GRID_H - 1, 36, 0);
  const se = projectPoint(GRID_W - 1, GRID_H - 1, 36, 0);

  const grad = ctx.createLinearGradient(nw.x, nw.y, se.x, se.y);
  grad.addColorStop(0, "rgba(255,255,255,0.58)");
  grad.addColorStop(1, "rgba(255,255,255,0.2)");

  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(nw.x, nw.y);
  ctx.lineTo(ne.x, ne.y);
  ctx.lineTo(se.x, se.y);
  ctx.lineTo(sw.x, sw.y);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(18, 38, 58, 0.2)";
  ctx.lineWidth = 1.1;
  ctx.stroke();

  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = "rgba(18, 38, 58, 0.16)";
  ctx.beginPath();
  ctx.moveTo(nw.x, nw.y);
  ctx.lineTo(sw.x, sw.y);
  ctx.moveTo(ne.x, ne.y);
  ctx.lineTo(se.x, se.y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawFieldLayer(key) {
  const spec = fieldSpec[key];

  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      const idx = y * GRID_W + x;
      const anomaly = getCellAnomaly(key, idx);
      const normalized = anomaly / spec.visualScale;
      const point = projectPoint(x, y, spec.layerOffset, normalized);

      const alpha = Math.min(0.95, 0.3 + Math.abs(normalized) * 0.36);
      const radius = Math.min(7.6, 2.8 + Math.abs(normalized) * 2.0);

      ctx.beginPath();
      ctx.fillStyle = toAlpha(spec.color, alpha);
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function toAlpha(hex, alpha) {
  const clean = hex.replace("#", "");
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

function drawWrapHint() {
  const regions = getCanvasRegions();
  ctx.fillStyle = "rgba(18, 38, 58, 0.66)";
  ctx.font = "600 16px DM Sans";
  ctx.fillText("Wrapped boundaries: flow exits one edge and re-enters opposite edge.", 48, regions.wrapHintY);
}

function formatSigned(value, digits) {
  const rounded = Number(value.toFixed(digits));
  const sign = rounded >= 0 ? "+" : "-";
  return `${sign}${Math.abs(rounded).toFixed(digits)}`;
}

function drawAverages() {
  let x = 52;
  const y = HUD_VALUE_Y;

  ctx.font = "700 17px DM Sans";

  const meanPressure = meanValue(fields.pressure.value);
  const meanHumidityRh = meanValue(humidityRhCache);
  const meanTemperature = meanValue(fields.temperature.value);
  const pressureDelta = meanPressure - referenceMeans.pressure;
  const humidityDelta = meanHumidityRh - referenceMeans.humidityRh;
  const temperatureDelta = meanTemperature - referenceMeans.temperature;

  const pressureText = `Pressure: ${meanPressure.toFixed(2)} hPa (\u0394 ${formatSigned(pressureDelta, 2)} hPa)`;
  const humidityText = `Humidity: ${meanHumidityRh.toFixed(2)} %RH (\u0394 ${formatSigned(humidityDelta, 2)} %RH)`;
  const temperatureText = `Temperature: ${meanTemperature.toFixed(2)} \u00b0C (\u0394 ${formatSigned(temperatureDelta, 2)} \u00b0C)`;

  const items = [
    { text: pressureText, color: fieldSpec.pressure.color },
    { text: humidityText, color: fieldSpec.humidity.color },
    { text: temperatureText, color: fieldSpec.temperature.color }
  ];

  for (const item of items) {
    ctx.fillStyle = item.color;
    ctx.fillText(item.text, x, y);
    x += ctx.measureText(item.text).width + 30;
  }
}

function resetDiagnostics() {
  diagnostics.meanQ = [];
  diagnostics.meanRh = [];
  diagnostics.supersatFraction = [];
  latestSupersaturatedCount = 0;
}

function pushHistory(arr, value) {
  arr.push(value);
  if (arr.length > HISTORY_LENGTH) {
    arr.shift();
  }
}

function updateDiagnostics() {
  pushHistory(diagnostics.meanQ, meanValue(fields.humidity.value) * 1000);
  pushHistory(diagnostics.meanRh, meanValue(humidityRhCache));
  pushHistory(diagnostics.supersatFraction, (latestSupersaturatedCount / CELL_COUNT) * 100);
}

function drawDiagnosticsStrip() {
  const { diagnostics: diagRegion } = getCanvasRegions();
  const panelX = diagRegion.x;
  const panelY = diagRegion.y;
  const panelW = diagRegion.w;
  const panelH = diagRegion.h;

  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.strokeStyle = "rgba(18,38,58,0.14)";
  ctx.lineWidth = 1;
  drawRoundedRect(panelX, panelY, panelW, panelH, 12);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "rgba(18,38,58,0.72)";
  ctx.font = "700 13px DM Sans";
  ctx.fillText("Diagnostics (rolling): mean q [g/kg], mean RH [%], supersaturated cells [%]", panelX + 12, panelY + 18);

  const chartX = panelX + 12;
  const chartY = panelY + 26;
  const chartW = panelW - 24;
  const chartH = panelH - 38;

  drawHistoryLine(
    diagnostics.meanQ,
    chartX,
    chartY,
    chartW,
    chartH,
    fieldSpec.humidity.color,
    DIAGNOSTIC_RANGES.meanQ.min,
    DIAGNOSTIC_RANGES.meanQ.max
  );
  drawHistoryLine(
    diagnostics.meanRh,
    chartX,
    chartY,
    chartW,
    chartH,
    fieldSpec.pressure.color,
    DIAGNOSTIC_RANGES.meanRh.min,
    DIAGNOSTIC_RANGES.meanRh.max
  );
  drawHistoryLine(
    diagnostics.supersatFraction,
    chartX,
    chartY,
    chartW,
    chartH,
    fieldSpec.temperature.color,
    DIAGNOSTIC_RANGES.supersatFraction.min,
    DIAGNOSTIC_RANGES.supersatFraction.max
  );
}

function drawRoundedRect(x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }

  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
}

function drawHistoryLine(series, x, y, w, h, color, minValue, maxValue) {
  if (series.length < 2) {
    return;
  }

  const range = Math.max(maxValue - minValue, 1e-6);

  ctx.beginPath();
  ctx.strokeStyle = toAlpha(color, 0.9);
  ctx.lineWidth = 1.8;

  for (let i = 0; i < series.length; i += 1) {
    const px = x + (i / (series.length - 1)) * w;
    const normalized = clamp((series[i] - minValue) / range, 0, 1);
    const py = y + h - normalized * h;
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }

  ctx.stroke();
}

function meanValue(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i += 1) {
    sum += arr[i];
  }
  return sum / arr.length;
}

function tick() {
  advanceSystem();
  draw();
  requestAnimationFrame(tick);
}
