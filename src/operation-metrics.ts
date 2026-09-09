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

export function operationMetricsHtml(): string {
  const rows = [...metrics].map(([name, row]) => `<tr><td>${name}</td><td>${row.calls}</td><td>${row.outputChars}</td><td>${row.targetedReads}</td><td>${row.errors}</td><td>${row.durationMs}</td></tr>`).join('');
  return `<h2>This extension window</h2><p>Resets on reload. Output characters include retrieval traffic; targeted reads are not necessarily recovery reads. These are operation metrics, not net session or billed savings.</p><table><tr><th>Tool</th><th>Calls</th><th>Output chars</th><th>Targeted reads</th><th>Errors</th><th>Total ms</th></tr>${rows}</table>`;
}