// ECharts, trimmed to the pieces the dashboard uses, themed from the page's
// CSS tokens (light and dark), with every chart resized with its card.
import { BarChart, HeatmapChart, LineChart, PieChart } from 'echarts/charts';
import {
  AriaComponent,
  CalendarComponent,
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  HeatmapChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  CalendarComponent,
  VisualMapComponent,
  DataZoomComponent,
  AriaComponent,
  CanvasRenderer,
]);

export { echarts };
export type EChartsOption = echarts.EChartsCoreOption;

/** The page's design tokens, read live so dark mode follows the system. */
export function tokens() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    surface: v('--card'),
    fg: v('--fg'),
    muted: v('--muted-fg'),
    border: v('--border'),
    grid: v('--grid'),
    baseline: v('--baseline'),
    series: [v('--series-1'), v('--series-2'), v('--series-3'), v('--series-4')],
    seq: [v('--seq-0'), v('--seq-1'), v('--seq-2'), v('--seq-3'), v('--seq-4'), v('--seq-5')],
    critical: v('--critical'),
    tooltipBg: v('--tooltip-bg'),
    tooltipFg: v('--tooltip-fg'),
    font: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
  };
}
export type Tokens = ReturnType<typeof tokens>;

/** Shared tooltip look: dark pill, values first. */
export function tooltipBase(t: Tokens) {
  return {
    backgroundColor: t.tooltipBg,
    borderWidth: 0,
    padding: [8, 10],
    textStyle: { color: t.tooltipFg, fontFamily: t.font, fontSize: 12 },
    extraCssText: 'border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.25);',
    confine: true,
  };
}

const charts = new Map<HTMLElement, echarts.ECharts>();
const observer = new ResizeObserver((entries) => {
  for (const e of entries) charts.get(e.target as HTMLElement)?.resize();
});

/** Draw (or redraw) a chart in `host`. */
export function chart(host: HTMLElement, option: EChartsOption) {
  let c = charts.get(host);
  if (!c) {
    c = echarts.init(host, undefined, { renderer: 'canvas' });
    charts.set(host, c);
    observer.observe(host);
  }
  // Kept on the element so tests (and curious devtools users) can read what was drawn.
  (host as HTMLElement & { btOption?: EChartsOption }).btOption = option;
  c.setOption({ animationDuration: 350, aria: { enabled: true }, textStyle: { fontFamily: tokens().font }, ...option }, { notMerge: true });
  return c;
}

/** Throw every chart away (theme changes need fresh instances). */
export function disposeAll() {
  for (const [host, c] of charts) {
    observer.unobserve(host);
    c.dispose();
  }
  charts.clear();
}

/** Escape text going into an ECharts HTML tooltip. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
