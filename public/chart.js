import { formatMoney } from "./format-values.js";

const timeOnly = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const dateOnly = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" });
const longDate = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});
const chinaTimeOnly = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const chinaLongDate = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const compactMoney = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 });

function axisScale(points) {
  if (!points.length) return { min: 0, max: 4, step: 1 };
  let low = Infinity;
  let high = -Infinity;
  for (const [, val] of points) {
    low = Math.min(low, val);
    high = Math.max(high, val);
  }
  const diff = high - low || Math.max(Math.abs(high) * 0.018, 0.04);
  const rawStep = Math.max(0.01, diff / 3.1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const step = ([1, 2, 2.5, 5, 10].find(value => value * magnitude >= rawStep) ?? 10) * magnitude;
  let min = Math.floor((low - diff * .09) / step) * step;
  const max = Math.ceil((high + diff * .07) / step) * step;
  if (low >= 0 && min < 0) min = 0;
  if (max <= min) return { min, max: min + step, step };
  return { min, max, step };
}

function axisMoney(value, step) {
  if (Math.abs(value) >= 1000) return compactMoney.format(value);
  const digits = Math.max(0, Math.min(2, Math.ceil(-Math.log10(step)) + 1));
  return new Intl.NumberFormat("en", { maximumFractionDigits: digits }).format(value);
}

export function createChart(canvas, empty, tooltip, timeLabel, valueLabel) {
  const ctx = canvas.getContext("2d");
  const wrapper = canvas.parentElement;
  let settings = { points: [], series: "equity", period: "day", masked: false, emptyText: "" };
  let hovered = -1;
  let geometry = null;

  function draw() {
    const { points, series, period, masked, emptyText, gap = Infinity } = settings;
    const width = wrapper.clientWidth;
    const height = wrapper.clientHeight;
    if (!width || !height || !ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const scale = axisScale(points);
    const tickCount = Math.round((scale.max - scale.min) / scale.step);
    const ticks = Array.from({ length: tickCount + 1 }, (_, i) => scale.min + scale.step * i);
    const labelWidth = Math.max(30, ...ticks.map(val => ctx.measureText(masked ? "•••" : axisMoney(val, scale.step)).width));
    const plot = { left: 4, right: width - labelWidth - 13, top: 11, bottom: height - 30 };
    const first = points[0]?.[0] ?? 0;
    const duration = (points.at(-1)?.[0] ?? 0) - first;
    const x = value => duration ? plot.left + (value - first) * (plot.right - plot.left) / duration : plot.right;
    const y = value => plot.bottom - (value - scale.min) * (plot.bottom - plot.top) / (scale.max - scale.min);
    geometry = { plot, first, duration };

    ctx.strokeStyle = "#282e3b";
    ctx.fillStyle = "#8a96ac";
    ctx.lineWidth = 1;
    ctx.textAlign = "left";
    for (const value of ticks) {
      const py = Math.round(y(value)) + 0.5;
      ctx.beginPath();
      ctx.setLineDash([3, 4]);
      ctx.moveTo(plot.left, py);
      ctx.lineTo(plot.right, py);
      ctx.stroke();
      if (points.length) ctx.fillText(masked ? "•••" : axisMoney(value, scale.step), plot.right + 8, py);
    }
    ctx.setLineDash([]);
    empty.hidden = points.length > 0;
    empty.textContent = points.length ? "" : emptyText;
    if (!points.length) {
      tooltip.hidden = true;
      return;
    }

    if (duration > 0) {
      const divisions = width < 475 ? 3 : 5;
      for (let i = 0; i <= divisions; i++) {
        const time = first + duration * i / divisions;
        const fmt = period === "today" ? chinaTimeOnly : period === "day" ? timeOnly : dateOnly;
        ctx.textAlign = i === 0 ? "left" : i === divisions ? "right" : "center";
        ctx.fillText(fmt.format(time), x(time), height - 13);
      }
    }

    const color = series === "equity" ? "#83f7c6" : "#b39bf7";
    const gradient = ctx.createLinearGradient(0, plot.top, 0, plot.bottom);
    gradient.addColorStop(0, color + "45");
    gradient.addColorStop(1, color + "03");
    const segments = [];
    let segment = [];
    for (const point of points) {
      if (segment.length && point[0] - segment.at(-1)[0] > gap) {
        segments.push(segment);
        segment = [];
      }
      segment.push(point);
    }
    segments.push(segment);
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (const group of segments) {
      const path = new Path2D();
      group.forEach(([time, value], i) => {
        if (i === 0) path.moveTo(x(time), y(value));
        else path.lineTo(x(time), y(value));
      });
      const area = new Path2D(path);
      area.lineTo(x(group.at(-1)[0]), plot.bottom);
      area.lineTo(x(group[0][0]), plot.bottom);
      area.closePath();
      ctx.fillStyle = gradient;
      ctx.fill(area);
      ctx.strokeStyle = color;
      ctx.stroke(path);
      if (group.length === 1) {
        ctx.beginPath();
        ctx.fillStyle = color;
        ctx.arc(x(group[0][0]), y(group[0][1]), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const point = points[hovered] ?? points.at(-1);
    const px = x(point[0]);
    const py = y(point[1]);
    if (hovered >= 0) {
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#717d93";
      ctx.moveTo(px, plot.top);
      ctx.lineTo(px, plot.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    for (const [radius, fill] of [[7, color + "33"], [3.5, color]]) {
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
    }

    tooltip.hidden = hovered < 0;
    if (hovered >= 0) {
      timeLabel.textContent = (period === "today" ? chinaLongDate : longDate).format(point[0]);
      valueLabel.textContent = masked ? "••••••" : formatMoney(point[1]);
      const left = Math.max(2, Math.min(width - tooltip.offsetWidth - 2, px + (px > width / 2 ? -tooltip.offsetWidth - 10 : 10)));
      tooltip.style.left = left + "px";
      tooltip.style.top = Math.max(0, py - tooltip.offsetHeight - 8) + "px";
    }
  }

  function inspect(event) {
    const { points } = settings;
    if (!geometry || !points.length) return;
    const px = event.clientX - canvas.getBoundingClientRect().left;
    const ratio = (px - geometry.plot.left) / (geometry.plot.right - geometry.plot.left);
    const moment = geometry.first + ratio * geometry.duration;
    hovered = points.reduce((nearest, [time], index) =>
      Math.abs(time - moment) < Math.abs(points[nearest][0] - moment) ? index : nearest, 0);
    draw();
  }

  canvas.addEventListener("pointermove", inspect);
  canvas.addEventListener("pointerdown", inspect);
  canvas.addEventListener("pointerleave", () => { hovered = -1; draw(); });
  canvas.addEventListener("pointercancel", () => { hovered = -1; draw(); });
  new ResizeObserver(draw).observe(wrapper);

  return next => {
    const changed = settings.series !== next.series || settings.period !== next.period;
    settings = next;
    if (changed || hovered >= next.points.length) hovered = -1;
    const name = next.series === "equity" ? "账户权益" : "区间盈亏";
    const last = next.points.at(-1);
    const value = last && !next.masked ? `，最新样本 ${formatMoney(last[1])}` : "";
    canvas.setAttribute("aria-label", `${name}历史图，${next.points.length} 个样本${value}`);
    draw();
  };
}
