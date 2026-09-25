import type { DriftReport, DriftSeries } from '../analysis/drift.ts';

/**
 * Phase 31 O4: a deterministic, self-contained static chart of architecture drift.
 *
 * The renderer is pure: it reads a `DriftReport` (the same series `GET /analysis/drift`
 * serves) and a revision + build timestamp, and writes one HTML document with an inline SVG.
 * Series keep the report's fixed measure order, and every coordinate is formatted at fixed
 * precision, so two runs over the same report produce byte-identical output except the
 * build date. A measure with no recorded value is never plotted as zero: the line breaks at
 * the gap and the measure is named as not recorded.
 */

export interface DriftArtifactMeta {
  /** The source revision the artifact was built from, or `null`. */
  revision: string | null;
  /** ISO build timestamp; the one input that changes between runs on the same revision. */
  generatedAt: string;
  /** Repository name for the heading; falls back to the report's own name. */
  repository?: string;
  /** Why the drift is unavailable, when no report was collected. */
  reason?: string;
}

export interface DriftChartPoint {
  x: number;
  y: number;
}

export interface DriftChartSeries {
  key: string;
  label: string;
  colour: string;
  min: number;
  max: number;
  /** Oldest-first ends of the plotted window. */
  first: number | null;
  last: number | null;
  /** One or more polylines; a `null` value ends a segment rather than interpolating. */
  segments: DriftChartPoint[][];
}

export interface DriftChartModel {
  width: number;
  height: number;
  padding: number;
  count: number;
  series: DriftChartSeries[];
}

export interface DriftChartOptions {
  width?: number;
  height?: number;
  padding?: number;
}

const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 320;
const DEFAULT_PADDING = 40;

/** The bounded categorical set (R8): three hues, then the neutral for later series. */
const SERIES_COLOURS: readonly string[] = ['#3987e5', '#d95926', '#199e70'];
const SERIES_OTHER = '#8da0b5';

export function driftSeriesColour(index: number): string {
  return SERIES_COLOURS[index] ?? SERIES_OTHER;
}

/** The series with at least one recorded value, in the report's fixed measure order. */
export function recordedDriftSeries(report: DriftReport): DriftSeries[] {
  return report.series.filter((series) => series.points.some((point) => point.value !== null));
}

/**
 * The pure chart geometry. Each measure is scaled to its own min/max so its shape is
 * visible; the legend carries the real numbers, so an independently scaled line is never
 * mistaken for an absolute one. Points are flipped to oldest-first for a time axis.
 */
export function buildDriftChart(
  report: DriftReport,
  options: DriftChartOptions = {},
): DriftChartModel {
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const padding = options.padding ?? DEFAULT_PADDING;
  const count = report.points.length;

  const xFor = (index: number): number =>
    count <= 1 ? width / 2 : padding + (index * (width - padding * 2)) / (count - 1);
  const yFor = (value: number, min: number, span: number): number =>
    span === 0 ? height / 2 : height - padding - ((value - min) / span) * (height - padding * 2);

  const series = recordedDriftSeries(report).map((entry, seriesIndex) => {
    const values = entry.points.map((point) => point.value).reverse();
    const defined = values.filter((value): value is number => value !== null);
    const min = defined.length > 0 ? Math.min(...defined) : 0;
    const max = defined.length > 0 ? Math.max(...defined) : 0;
    const span = max - min;

    const segments: DriftChartPoint[][] = [];
    let current: DriftChartPoint[] = [];
    values.forEach((value, index) => {
      if (value === null) {
        if (current.length > 0) segments.push(current);
        current = [];
        return;
      }
      current.push({ x: xFor(index), y: yFor(value, min, span) });
    });
    if (current.length > 0) segments.push(current);

    return {
      key: entry.key,
      label: entry.label,
      colour: driftSeriesColour(seriesIndex),
      min,
      max,
      first: values[0] ?? null,
      last: values[values.length - 1] ?? null,
      segments,
    };
  });

  return { width, height, padding, count, series };
}

/**
 * Render the self-contained artifact. An unavailable report still renders a stamped page
 * that names the reason, so a gap is visible rather than an empty chart.
 */
export function renderDriftArtifact(
  report: DriftReport | null,
  meta: DriftArtifactMeta,
): string {
  const repository = meta.repository ?? report?.repository ?? 'repository';
  const revision = meta.revision ?? report?.points[0]?.revision ?? null;
  if (!report || !report.available) {
    const reason = report?.reason ?? meta.reason ?? 'not recorded';
    return renderShell(
      repository,
      revision,
      meta.generatedAt,
      `<p class="unavailable" data-role="drift-unavailable">Architecture drift unavailable: ${escapeHtml(reason)}.</p>`,
    );
  }

  const chart = buildDriftChart(report);
  const body = [
    renderChartSvg(chart, report),
    renderLegend(chart),
    renderNotes(report, chart),
  ].join('\n');
  return renderShell(repository, revision, meta.generatedAt, body);
}

function renderShell(
  repository: string,
  revision: string | null,
  generatedAt: string,
  body: string,
): string {
  const stampRevision = revision ?? 'unavailable';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(repository)} — architecture drift</title>
<style>body{margin:0;padding:32px;background:#10141a;color:#eef3fa;font-family:ui-sans-serif,system-ui,sans-serif}h1{font-size:20px;margin:0 0 4px}.stamp{color:#8da0b5;font-size:13px;margin:0 0 20px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#eef3fa}.drift-chart{display:block;width:100%;height:auto;background:#10141a;border:1px solid #55697f;border-radius:8px}.drift-legend{display:flex;flex-wrap:wrap;gap:8px 20px;margin:16px 0;padding:0;list-style:none}.drift-legend-item{display:flex;gap:8px;align-items:baseline;font-size:13px;color:#c8d2e0}.drift-legend-swatch{display:inline-block;width:10px;height:10px;border-radius:2px}.drift-legend-scale{color:#8da0b5}.notes{color:#8da0b5;font-size:13px;line-height:1.5}.unavailable{color:#fab219;font-size:14px}</style>
</head>
<body data-revision="${escapeHtml(stampRevision)}" data-generated-at="${escapeHtml(generatedAt)}">
<h1>${escapeHtml(repository)} — architecture drift</h1>
<p class="stamp">revision <code>${escapeHtml(stampRevision)}</code> · built <time datetime="${escapeHtml(generatedAt)}">${escapeHtml(generatedAt)}</time></p>
${body}
</body>
</html>
`;
}

function renderChartSvg(chart: DriftChartModel, report: DriftReport): string {
  const { width, height, padding } = chart;
  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Architecture drift over ${chart.count} revisions" class="drift-chart" data-role="drift-chart">`,
  );
  lines.push(`<line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#55697f" stroke-width="1"/>`);
  for (const series of chart.series) {
    lines.push(`<g data-series="${escapeHtml(series.key)}">`);
    for (const segment of series.segments) {
      if (segment.length === 1) {
        const point = segment[0] as DriftChartPoint;
        lines.push(`<circle cx="${fixed(point.x)}" cy="${fixed(point.y)}" r="2.5" fill="${series.colour}"/>`);
        continue;
      }
      const points = segment.map((point) => `${fixed(point.x)},${fixed(point.y)}`).join(' ');
      lines.push(`<polyline points="${points}" fill="none" stroke="${series.colour}" stroke-width="2" vector-effect="non-scaling-stroke"/>`);
    }
    lines.push('</g>');
  }
  const chronological = [...report.points].reverse();
  const oldest = chronological[0];
  const newest = chronological[chronological.length - 1];
  if (oldest) {
    lines.push(`<text x="${padding}" y="${height - padding + 16}" fill="#8da0b5" font-size="11">${escapeHtml(oldest.short)} · ${escapeHtml(oldest.date ?? 'no date')}</text>`);
  }
  if (newest && newest !== oldest) {
    lines.push(`<text x="${width - padding}" y="${height - padding + 16}" text-anchor="end" fill="#8da0b5" font-size="11">${escapeHtml(newest.short)} · ${escapeHtml(newest.date ?? 'no date')}</text>`);
  }
  lines.push('</svg>');
  return lines.join('\n');
}

function renderLegend(chart: DriftChartModel): string {
  const items = chart.series
    .map((series) => {
      const ends =
        series.first === null || series.last === null
          ? 'no recorded values'
          : `${series.first} → ${series.last}`;
      return `<li class="drift-legend-item"><span class="drift-legend-swatch" style="background:${series.colour}" aria-hidden="true"></span><span>${escapeHtml(series.label)}: ${escapeHtml(ends)}</span> <span class="drift-legend-scale">(scale ${series.min}–${series.max})</span></li>`;
    })
    .join('\n');
  return `<ul class="drift-legend" data-role="drift-legend">\n${items}\n</ul>`;
}

function renderNotes(report: DriftReport, chart: DriftChartModel): string {
  const missing = report.series
    .filter((series) => series.points.every((point) => point.value === null))
    .map((series) => series.label);
  const lines: string[] = [];
  lines.push(
    `<p class="notes">${chart.count} revision${chart.count === 1 ? '' : 's'} measured, newest first in the report; the chart draws oldest first. ${chart.series.length} of ${report.series.length} measures recorded. Each line is scaled to its own range, and the legend carries the real values.</p>`,
  );
  if (missing.length > 0) {
    lines.push(`<p class="notes" data-role="drift-missing">Not recorded for these revisions: ${escapeHtml(missing.join(', '))}.</p>`);
  }
  return lines.join('\n');
}

function fixed(value: number): string {
  return value.toFixed(2);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
