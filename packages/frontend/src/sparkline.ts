/* ============================================================
   sparkline.ts — inline SVG sparklines.

   Drawn by hand rather than with a charting library: these are
   100×20 viewBox polylines stretched to the bar width, and a
   dependency would cost more than the 80 lines it replaces.

   Scaling is to the *observed range*, not to zero. The bar right
   above the sparkline already shows the absolute value; the
   sparkline's job is to show movement. Zero-based scaling turns
   a steady 82% RAM series into a filled rectangle that says
   nothing.
   ============================================================ */

const VIEW_W = 100;
const VIEW_H = 20;
/** Vertical breathing room so peaks aren't clipped by the viewBox. */
const PAD = 2;

export interface SparkOptions {
  color?: string;
  /**
   * Smallest span the y-axis may cover, in the series' own units.
   * Stops sensor noise of ±0.2 °C from being magnified into a
   * dramatic mountain range.
   */
  minSpan?: number;
}

/**
 * Render values into an existing <svg>, oldest point on the left.
 *
 * A series shorter than two points draws nothing: a single dot would
 * imply a trend that isn't there yet.
 */
export function drawSparkline(
  svg: SVGElement,
  values: number[],
  options: SparkOptions = {},
): void {
  const points = values.filter((v) => Number.isFinite(v));
  if (points.length < 2) {
    svg.replaceChildren();
    return;
  }

  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const minSpan = options.minSpan ?? 5;

  // Centre the band on the data when the series is flatter than minSpan,
  // so an unchanging value draws a straight line through the middle.
  const span = Math.max(hi - lo, minSpan);
  const mid = (hi + lo) / 2;
  const top = mid + span / 2;

  const usable = VIEW_H - PAD * 2;
  const stepX = VIEW_W / (points.length - 1);

  const coords = points.map((v, i) => {
    const x = i * stepX;
    // SVG y grows downward, so invert to put larger values higher.
    const y = PAD + ((top - v) / span) * usable;
    return `${round(x)},${round(clamp(y, 0, VIEW_H))}`;
  });

  const color = options.color ?? "var(--accent-nav)";
  const ns = "http://www.w3.org/2000/svg";

  const area = document.createElementNS(ns, "polygon");
  area.setAttribute("class", "spark-area");
  area.setAttribute("points", `0,${VIEW_H} ${coords.join(" ")} ${VIEW_W},${VIEW_H}`);
  area.setAttribute("fill", color);

  const line = document.createElementNS(ns, "polyline");
  line.setAttribute("class", "spark-line");
  line.setAttribute("points", coords.join(" "));
  line.setAttribute("stroke", color);

  svg.replaceChildren(area, line);
}

export function clearSparkline(svg: SVGElement): void {
  svg.replaceChildren();
}

/** Exposed for tests: the y coordinate each value maps to. */
export function sparkPoints(values: number[], minSpan = 5): Array<[number, number]> {
  const points = values.filter((v) => Number.isFinite(v));
  if (points.length < 2) return [];

  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const span = Math.max(hi - lo, minSpan);
  const top = (hi + lo) / 2 + span / 2;
  const usable = VIEW_H - PAD * 2;
  const stepX = VIEW_W / (points.length - 1);

  return points.map((v, i) => [
    round(i * stepX),
    round(clamp(PAD + ((top - v) / span) * usable, 0, VIEW_H)),
  ]);
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
