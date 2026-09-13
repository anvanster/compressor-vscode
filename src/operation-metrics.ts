export type Operation = 'read' | 'outline' | 'search' | 'execute' | 'log';
export interface OperationMetric { calls: number; outputChars: number; durationMs: number; errors: number; targetedReads: number }
const metrics = new Map<Operation, OperationMetric>();

export async function measureOperation<T>(operation: Operation, targeted: boolean, run: () => Promise<T>, describe: (result: T) => { text: string; isError?: boolean }): Promise<T> {
  const started = Date.now();
  const row = metrics.get(operation) ?? { calls: 0, outputChars: 0, durationMs: 0, errors: 0, targetedReads: 0 };
  metrics.set(operation, row);
  row.calls++;
  if (targeted) row.targetedReads++;
  try {
    const result = await run();
    const outcome = describe(result);
    row.outputChars += outcome.text.length;
    if (outcome.isError) row.errors++;
    return result;
  } catch (error) {
    row.errors++;
    throw error;
  } finally { row.durationMs += Date.now() - started; }
}

export function resetOperationMetrics(): void { metrics.clear(); }

const fmt = (n: number): string => n.toLocaleString('en-US');

// The report's own stylesheet has no table rules, so without these the header
// cells run together into one line. Inline because the surrounding HTML comes
// from the library's renderer and this section is spliced into it.
const CELL = 'padding:0.25rem 0.9rem 0.25rem 0;text-align:left';

/** Empty until a tool runs in this window; an all-zero table says nothing. */
export function operationMetricsHtml(): string {
  if (metrics.size === 0) {
    return '';
  }
  const head = ['Tool', 'Calls', 'Output chars', 'Targeted reads', 'Errors', 'Total ms']
    .map((label) => `<th style="${CELL}">${label}</th>`).join('');
  const rows = [...metrics].map(([name, row]) =>
    `<tr>${[name, fmt(row.calls), fmt(row.outputChars), fmt(row.targetedReads), fmt(row.errors), fmt(row.durationMs)]
      .map((cell) => `<td style="${CELL}">${cell}</td>`).join('')}</tr>`).join('');
  return '<h2>This extension window</h2><p>Resets on reload. Output characters include ' +
    'retrieval traffic; targeted reads are not necessarily recovery reads. These are ' +
    'operation metrics, not net session or billed savings.</p>' +
    `<table style="border-collapse:collapse"><tr>${head}</tr>${rows}</table>`;
}