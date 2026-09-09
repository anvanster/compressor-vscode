import { Worker } from 'node:worker_threads';

export interface RegexScanResult {
  indices: number[];
  skipped: number;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const expression = new RegExp(workerData.query, workerData.ignoreCase ? 'i' : '');
parentPort.on('message', ({ content, skip, limit }) => {
  const lines = content.split('\\n');
  const indices = [];
  let skipped = 0;
  for (let index = 0; index < lines.length; index++) {
    if (!expression.test(lines[index])) continue;
    if (skipped < skip) { skipped++; continue; }
    indices.push(index);
    if (indices.length >= limit) break;
  }
  parentPort.postMessage({ indices, skipped });
});
`;

export class RegexScanner {
  private worker: Worker | undefined;

  constructor(
    private readonly query: string,
    private readonly ignoreCase: boolean,
    private readonly cancelled: () => boolean = () => false,
    private readonly timeoutMs = 1000,
  ) {}

  async scan(content: string, skip: number, limit: number): Promise<RegexScanResult> {
    if (this.cancelled()) throw new Error('Search cancelled');
    const worker = this.worker ??= new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { query: this.query, ignoreCase: this.ignoreCase },
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error, result?: RegexScanResult): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        clearInterval(cancellation);
        worker.removeListener('message', message);
        worker.removeListener('error', failure);
        worker.removeListener('exit', exit);
        if (error) {
          void this.dispose();
          reject(error);
        } else resolve(result!);
      };
      const message = (result: RegexScanResult): void => finish(undefined, result);
      const failure = (error: Error): void => finish(error);
      const exit = (code: number): void => finish(new Error(`Regex worker stopped (${code}); search incomplete`));
      const timeout = setTimeout(() => finish(new Error('Regex search timed out; simplify the pattern or use a literal search')), this.timeoutMs);
      const cancellation = setInterval(() => {
        if (this.cancelled()) finish(new Error('Search cancelled'));
      }, 25);
      worker.once('message', message);
      worker.once('error', failure);
      worker.once('exit', exit);
      worker.postMessage({ content, skip, limit });
    });
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }
}