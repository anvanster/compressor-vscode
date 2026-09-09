import { langFromPath, cheapEstimator } from '@astudioplus/compressor';

export interface OutputHints {
  tokenBudget?: number;
  countTokens?: (text: string) => PromiseLike<number>;
  cancelled?: () => boolean;
}

export async function fitOutput(text: string, hints: OutputHints, recovery: string): Promise<string> {
  const budget = hints.tokenBudget;
  if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return text;
  const count = async (value: string): Promise<number> => {
    if (hints.cancelled?.()) throw new Error('Operation cancelled');
    try { return await (hints.countTokens?.(value) ?? cheapEstimator(value)); }
    catch (error) {
      if (hints.cancelled?.()) throw error;
      return cheapEstimator(value);
    }
  };
  if (await count(text) <= budget) return text;
  const marker = `\n[compressor: partial output; ${recovery}]`;
  if (await count(marker) > budget) return '';
  let lower = 0;
  let upper = text.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (await count(text.slice(0, middle) + marker) <= budget) lower = middle;
    else upper = middle - 1;
  }
  const prefix = text.slice(0, lower);
  const lastLine = prefix.lastIndexOf('\n');
  return (lastLine >= 0 ? prefix.slice(0, lastLine) : prefix) + marker;
}

export async function selectOutput(original: string, candidate: string, hints: OutputHints = {}): Promise<string> {
  if (hints.cancelled?.()) throw new Error('Operation cancelled');
  if (candidate.length >= original.length) return original;
  const count = hints.countTokens ?? cheapEstimator;
  try {
    const [before, after] = await Promise.all([count(original), count(candidate)]);
    if (hints.cancelled?.()) throw new Error('Operation cancelled');
    return Number.isFinite(before) && Number.isFinite(after) && after < before ? candidate : original;
  } catch (error) {
    if (hints.cancelled?.()) throw error;
    return cheapEstimator(candidate) < cheapEstimator(original) ? candidate : original;
  }
}

export function numberedText(lines: readonly string[], offset = 1): string {
  return lines.map((text, index) => `${String(offset + index).padStart(6)}→${text}`).join('\n');
}

export function readCandidate(lines: readonly string[], file: string, mode: string, targeted: boolean): string {
  const original = numberedText(lines);
  if (mode === 'full' || targeted || langFromPath(file) !== undefined || /\.(json|jsonc|md|mdx|xml|html)$/i.test(file)) return original;
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    let end = index + 1;
    while (end < lines.length && lines[end] === lines[index]) end++;
    if (end - index >= 3) {
      const retained = numberedText([lines[index] ?? ''], index + 1);
      const marker = `[compressor: lines ${index + 2}-${end} repeat line ${index + 1}; offset=${index + 2} limit=${end - index - 1} to retrieve]`;
      const expanded = numberedText(lines.slice(index, end), index + 1);
      output.push(retained.length + marker.length + 1 < expanded.length ? `${retained}\n${marker}` : expanded);
    } else output.push(numberedText(lines.slice(index, end), index + 1));
    index = end;
  }
  return output.join('\n');
}