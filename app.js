const paths = {
  caseData: "data/precomputed_variants.json",
  metrics: "data/teacher_student_metrics.json"
};

const controls = {
  variantSelect: document.querySelector("#variantSelect"),
  curveToggles: [...document.querySelectorAll("[data-curve]")],
  resetViewButton: document.querySelector("#resetViewButton"),
  zoomOutButton: document.querySelector("#zoomOutButton")
};

const state = {
  caseData: null,
  metrics: null,
  selectedVariant: null,
  charts: {}
};

const palette = {
  measured_p: "#16211f",
  selected_student: "#c66a24",
  m3_teacher: "#2f6fb3",
  physics_prior: "#6c5aa8",
  residual: "#b54747",
  grid: "#e3e7e1",
  muted: "#6f7976",
  studentCases: ["#c66a24", "#2f7d69", "#2f6fb3", "#b54747", "#6c5aa8", "#8b6f37"]
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatNumber(value, digits = 2) {
  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  });
}

function metricCard(label, value, sublabel) {
  return `<div class="metric"><span>${label}</span><strong>${value}</strong><span>${sublabel}</span></div>`;
}

function activeToggles() {
  return Object.fromEntries(controls.curveToggles.map((input) => [input.dataset.curve, input.checked]));
}

function selectedVariant() {
  return state.caseData.variants.find((variant) => variant.id === controls.variantSelect.value) || state.caseData.variants[0];
}

function curveValues(key) {
  return state.caseData.curves.map((row) => row[key]);
}

function timeValues() {
  return state.caseData.curves.map((row) => row.time);
}

function updateSummaryMetrics() {
  document.querySelector("#summaryMetrics").innerHTML = [
    metricCard("Teacher RMSE", formatNumber(state.metrics.teacher_vs_true.RMSE), "M3 vs. measured P"),
    metricCard("LSTM-4 RMSE", formatNumber(state.metrics.student_vs_true.RMSE), "Direct-output student"),
    metricCard("Distillation RMSE", formatNumber(state.metrics.student_vs_teacher.RMSE), "LSTM-4 vs. M3"),
    metricCard("Physics-prior RMSE", formatNumber(state.metrics.physics_prior_reference.RMSE), "Reference only")
  ].join("");
}

function updateCaseDetails(variant) {
  const h = variant.hyperparameters;
  document.querySelector("#caseDetails").innerHTML = [
    ["Hidden", h.hidden_units],
    ["Dense", h.dense_units],
    ["Epochs", h.epochs],
    ["Window", h.window],
    ["Params", variant.parameters]
  ].map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("");

  document.querySelector("#liveMetrics").innerHTML = [
    metricCard("RMSE", formatNumber(variant.metrics.RMSE), "Selected vs. measured P"),
    metricCard("Teacher RMSE", formatNumber(variant.metrics.teacher_RMSE), "Selected vs. M3"),
    metricCard("Params", variant.parameters, "Trainable weights"),
    metricCard("Load ratio", `${formatNumber(variant.rho_percent, 1)}%`, "Inference budget proxy")
  ].join("");
}

function canvasContext(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

class ZoomableLineChart {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = options;
    this.series = [];
    this.view = null;
    this.drag = null;
    this.margin = { top: 24, right: 24, bottom: 42, left: 62 };
    this.bindEvents();
  }

  bindEvents() {
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      if (!this.view) return;
      const rect = this.canvas.getBoundingClientRect();
      const plot = this.plotRect(rect.width, rect.height);
      const mx = clamp(event.clientX - rect.left, plot.left, plot.right);
      const my = clamp(event.clientY - rect.top, plot.top, plot.bottom);
      const xAnchor = this.pixelToX(mx, plot);
      const yAnchor = this.pixelToY(my, plot);
      const zoom = event.deltaY < 0 ? 0.82 : 1.22;
      const nextXSpan = (this.view.xMax - this.view.xMin) * zoom;
      const nextYSpan = (this.view.yMax - this.view.yMin) * zoom;
      const xFrac = (xAnchor - this.view.xMin) / (this.view.xMax - this.view.xMin || 1);
      const yFrac = (yAnchor - this.view.yMin) / (this.view.yMax - this.view.yMin || 1);
      this.view.xMin = xAnchor - nextXSpan * xFrac;
      this.view.xMax = this.view.xMin + nextXSpan;
      this.view.yMin = yAnchor - nextYSpan * yFrac;
      this.view.yMax = this.view.yMin + nextYSpan;
      this.limitView();
      this.draw();
    }, { passive: false });

    this.canvas.addEventListener("pointerdown", (event) => {
      if (!this.view) return;
      this.canvas.setPointerCapture(event.pointerId);
      this.drag = { x: event.clientX, y: event.clientY, view: { ...this.view } };
      this.canvas.style.cursor = "grabbing";
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.drag) return;
      const rect = this.canvas.getBoundingClientRect();
      const plot = this.plotRect(rect.width, rect.height);
      const dx = event.clientX - this.drag.x;
      const dy = event.clientY - this.drag.y;
      const xSpan = this.drag.view.xMax - this.drag.view.xMin;
      const ySpan = this.drag.view.yMax - this.drag.view.yMin;
      this.view.xMin = this.drag.view.xMin - (dx / plot.width) * xSpan;
      this.view.xMax = this.drag.view.xMax - (dx / plot.width) * xSpan;
      this.view.yMin = this.drag.view.yMin + (dy / plot.height) * ySpan;
      this.view.yMax = this.drag.view.yMax + (dy / plot.height) * ySpan;
      this.limitView();
      this.draw();
    });

    this.canvas.addEventListener("pointerup", (event) => {
      this.canvas.releasePointerCapture(event.pointerId);
      this.drag = null;
      this.canvas.style.cursor = "grab";
    });

    this.canvas.addEventListener("pointerleave", () => {
      this.drag = null;
      this.canvas.style.cursor = "grab";
    });

    this.canvas.style.cursor = "grab";
  }

  plotRect(width, height) {
    return {
      left: this.margin.left,
      top: this.margin.top,
      right: width - this.margin.right,
      bottom: height - this.margin.bottom,
      width: width - this.margin.left - this.margin.right,
      height: height - this.margin.top - this.margin.bottom
    };
  }

  setSeries(series, keepView = true) {
    this.series = series.filter((item) => item.values.length);
    if (!keepView || !this.view) this.resetView();
    this.draw();
  }

  dataBounds() {
    const allX = this.series.flatMap((item) => item.x);
    const allY = this.series.flatMap((item) => item.values);
    const xMin = Math.min(...allX);
    const xMax = Math.max(...allX);
    const yMinRaw = Math.min(...allY);
    const yMaxRaw = Math.max(...allY);
    const yPad = (yMaxRaw - yMinRaw) * 0.08 || 1;
    return { xMin, xMax, yMin: yMinRaw - yPad, yMax: yMaxRaw + yPad };
  }

  resetView() {
    if (!this.series.length) return;
    this.view = this.dataBounds();
  }

  zoomOut() {
    if (!this.view) return;
    const cx = (this.view.xMin + this.view.xMax) / 2;
    const cy = (this.view.yMin + this.view.yMax) / 2;
    const xSpan = (this.view.xMax - this.view.xMin) * 1.6;
    const ySpan = (this.view.yMax - this.view.yMin) * 1.6;
    this.view = { xMin: cx - xSpan / 2, xMax: cx + xSpan / 2, yMin: cy - ySpan / 2, yMax: cy + ySpan / 2 };
    this.limitView();
    this.draw();
  }

  limitView() {
    const bounds = this.dataBounds();
    const minXSpan = (bounds.xMax - bounds.xMin) * 0.015;
    const minYSpan = (bounds.yMax - bounds.yMin) * 0.02;
    if (this.view.xMax - this.view.xMin < minXSpan) {
      const cx = (this.view.xMin + this.view.xMax) / 2;
      this.view.xMin = cx - minXSpan / 2;
      this.view.xMax = cx + minXSpan / 2;
    }
    if (this.view.yMax - this.view.yMin < minYSpan) {
      const cy = (this.view.yMin + this.view.yMax) / 2;
      this.view.yMin = cy - minYSpan / 2;
      this.view.yMax = cy + minYSpan / 2;
    }
  }

  xToPixel(value, plot) {
    return plot.left + ((value - this.view.xMin) / (this.view.xMax - this.view.xMin || 1)) * plot.width;
  }

  yToPixel(value, plot) {
    return plot.top + (1 - (value - this.view.yMin) / (this.view.yMax - this.view.yMin || 1)) * plot.height;
  }

  pixelToX(value, plot) {
    return this.view.xMin + ((value - plot.left) / plot.width) * (this.view.xMax - this.view.xMin);
  }

  pixelToY(value, plot) {
    return this.view.yMin + (1 - (value - plot.top) / plot.height) * (this.view.yMax - this.view.yMin);
  }

  draw() {
    const { ctx, width, height } = canvasContext(this.canvas);
    const plot = this.plotRect(width, height);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#fbfcfa";
    ctx.fillRect(0, 0, width, height);
    if (!this.series.length || !this.view) return;

    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = palette.muted;
    ctx.font = "12px system-ui, sans-serif";

    for (let i = 0; i <= 4; i += 1) {
      const y = plot.top + (plot.height / 4) * i;
      const x = plot.left + (plot.width / 4) * i;
      ctx.beginPath();
      ctx.moveTo(plot.left, y);
      ctx.lineTo(plot.right, y);
      ctx.moveTo(x, plot.top);
      ctx.lineTo(x, plot.bottom);
      ctx.stroke();
      ctx.fillText(formatNumber(this.view.yMax - ((this.view.yMax - this.view.yMin) / 4) * i, 0), 10, y + 4);
      ctx.fillText(formatNumber(this.view.xMin + ((this.view.xMax - this.view.xMin) / 4) * i, 3), x - 18, height - 16);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.left, plot.top, plot.width, plot.height);
    ctx.clip();
    this.series.forEach((item) => {
      ctx.beginPath();
      ctx.strokeStyle = item.color;
      ctx.lineWidth = item.width || 2;
      ctx.globalAlpha = item.alpha || 1;
      item.values.forEach((value, index) => {
        const xValue = item.x[index];
        if (xValue < this.view.xMin || xValue > this.view.xMax) return;
        const x = this.xToPixel(xValue, plot);
        const y = this.yToPixel(value, plot);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
    ctx.restore();
    ctx.globalAlpha = 1;

    let legendX = plot.left;
    let legendY = 13;
    this.series.forEach((item) => {
      const widthNeeded = ctx.measureText(item.name).width + 54;
      if (legendX + widthNeeded > plot.right) {
        legendX = plot.left;
        legendY += 18;
      }
      ctx.fillStyle = item.color;
      ctx.fillRect(legendX, legendY - 4, 18, 3);
      ctx.fillStyle = palette.muted;
      ctx.fillText(item.name, legendX + 24, legendY);
      legendX += widthNeeded;
    });

    if (this.options.yLabel) {
      ctx.save();
      ctx.translate(15, plot.top + plot.height / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = palette.muted;
      ctx.fillText(this.options.yLabel, 0, 0);
      ctx.restore();
    }
  }
}

function predictionSeries(variant) {
  const toggles = activeToggles();
  const x = timeValues();
  const series = [];
  if (toggles.measured_p) series.push({ name: "Measured P", x, values: curveValues("measured_p"), color: palette.measured_p, width: 2.5 });
  if (toggles.selected_student) series.push({ name: variant.label, x, values: variant.prediction, color: palette.selected_student, width: 2.3 });
  if (toggles.all_students) {
    state.caseData.variants.forEach((item, index) => {
      if (item.id === variant.id && toggles.selected_student) return;
      series.push({
        name: item.label,
        x,
        values: item.prediction,
        color: palette.studentCases[index % palette.studentCases.length],
        width: 1.45,
        alpha: 0.55
      });
    });
  }
  if (toggles.m3_teacher) series.push({ name: "M3 teacher model", x, values: curveValues("m3_teacher"), color: palette.m3_teacher, width: 2.1, alpha: 0.9 });
  if (toggles.physics_prior) series.push({ name: "Physics-prior reference", x, values: curveValues("physics_prior"), color: palette.physics_prior, width: 1.8, alpha: 0.8 });
  return series;
}

function historySeries(variant) {
  const x = variant.history.map((row) => row.epoch);
  return [
    { name: "loss", x, values: variant.history.map((row) => row.loss), color: palette.physics_prior, width: 2.2 },
    { name: "val_loss", x, values: variant.history.map((row) => row.val_loss), color: palette.m3_teacher, width: 2.2 }
  ];
}

function residualSeries(variant) {
  const x = timeValues();
  const teacher = curveValues("m3_teacher");
  return [
    {
      name: "Selected student - M3",
      x,
      values: variant.prediction.map((value, index) => value - teacher[index]),
      color: palette.residual,
      width: 2.2
    }
  ];
}

function render(keepView = true) {
  const variant = selectedVariant();
  state.selectedVariant = variant;
  updateCaseDetails(variant);
  state.charts.prediction.setSeries(predictionSeries(variant), keepView);
  state.charts.history.setSeries(historySeries(variant), false);
  state.charts.residual.setSeries(residualSeries(variant), keepView);
}

function populateVariants() {
  controls.variantSelect.innerHTML = state.caseData.variants.map((variant) => (
    `<option value="${variant.id}">${variant.label}</option>`
  )).join("");
  const baseline = state.caseData.variants.find((variant) => variant.id === "lstm4_dense4");
  if (baseline) controls.variantSelect.value = baseline.id;
}

async function loadDemo() {
  try {
    const [caseData, metrics] = await Promise.all([
      fetch(paths.caseData).then((response) => response.json()),
      fetch(paths.metrics).then((response) => response.json())
    ]);
    state.caseData = caseData;
    state.metrics = metrics;
    document.querySelector("#sourceNote").textContent = caseData.source_note;
    populateVariants();
    updateSummaryMetrics();
    state.charts.prediction = new ZoomableLineChart(document.querySelector("#predictionChart"), { yLabel: "Active power P" });
    state.charts.history = new ZoomableLineChart(document.querySelector("#historyChart"), { yLabel: "Loss" });
    state.charts.residual = new ZoomableLineChart(document.querySelector("#residualChart"), { yLabel: "Residual" });
    render(false);
  } catch (error) {
    document.body.innerHTML = `<main class="load-error"><h1>Could not load demo data</h1><p>${error.message}</p><p>Run a local static server from the demo folder, then open <code>index.html</code>.</p></main>`;
  }
}

controls.variantSelect.addEventListener("change", () => render(false));
controls.curveToggles.forEach((control) => control.addEventListener("change", () => render(true)));
controls.resetViewButton.addEventListener("click", () => {
  Object.values(state.charts).forEach((chart) => chart.resetView());
  render(false);
});
controls.zoomOutButton.addEventListener("click", () => {
  Object.values(state.charts).forEach((chart) => chart.zoomOut());
});
window.addEventListener("resize", () => {
  if (!state.caseData) return;
  render(true);
});

loadDemo();
