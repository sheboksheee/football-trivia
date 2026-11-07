/** Minimal Prometheus-format metrics (no external dependency). */
export class Metrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, () => number>();
  inc(name: string, labels: Record<string, string> = {}, by = 1) {
    const key = `${name}${fmt(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }
  gauge(name: string, fn: () => number) {
    this.gauges.set(name, fn);
  }
  render(): string {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
    for (const [k, fn] of this.gauges) lines.push(`${k} ${fn()}`);
    return lines.join('\n') + '\n';
  }
}
function fmt(labels: Record<string, string>) {
  const e = Object.entries(labels);
  return e.length ? `{${e.map(([k, v]) => `${k}="${v.replace(/"/g, '')}"`).join(',')}}` : '';
}
