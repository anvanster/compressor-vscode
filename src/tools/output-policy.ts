import { langFromPath, cheapEstimator } from '@astudioplus/compressor';
import type { Mode } from '@astudioplus/compressor';

/**
 * The cap to apply when the host supplies no budget of its own. optimized
 * keeps the magnitude of the engine's former truncateBudget so output size is
 * materially unchanged, and slim halves it, mirroring the library's own
 * optimized:slim ratio.
 */
export const DEFAULT_TOKEN_BUDGET: Record<Exclude<Mode, 'full'>, number> = { optimized: 5_000, slim: 2_500 };

/**
 * The budget a call must actually fit in. `tokenizationOptions` is optional in
 * the language-model tool API, so a host is free to send no budget at all, and
 * treating that as "no cap" returns whole files: an outline of a package.json
 * fell back to the source, came back uncapped, and the host spilled it to a
 * chat-session resource file that the model then read — which spilled in turn.
 * An absent budget means we choose one, not that there isn't one. Full mode is
 * the deliberate exception: it is the setting that asks for untrimmed output.
 */
export function effectiveBudget(mode: Mode, tokenBudget: number | undefined): number | undefined {
  if (mode === 'full') return undefined;
  return tokenBudget !== undefined && Number.isFinite(tokenBudget) && tokenBudget > 0
    ? tokenBudget
    : DEFAULT_TOKEN_BUDGET[mode];
}

export interface OutputHints {
  tokenBudget?: number;
  countTokens?: (text: string) => PromiseLike<number>;
  cancelled?: () => boolean;
}

/**
 * Host token counting with cancellation, falling back to the cheap estimator
 * when the host supplies no counter or its counter throws.
 */
export function tokenCounter(hints: OutputHints): (value: string) => Promise<number> {
  return async (value) => {
    if (hints.cancelled?.()) throw new Error('Operation cancelled');
    try { return await (hints.countTokens?.(value) ?? cheapEstimator(value)); }
    catch (error) {
      if (hints.cancelled?.()) throw error;
      return cheapEstimator(value);
    }
  };
}

export async function fitOutput(text: string, hints: OutputHints, recovery: string): Promise<string> {
  const budget = hints.tokenBudget;
  if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return text;
  const count = tokenCounter(hints);
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

// JSON was briefly dedented here: a JSON string cannot contain a literal
// newline, so dropping leading whitespace kept every value byte-exact and saved
// a measured 31% on package.json. It was removed anyway, because byte-exact is
// not the same as unchanged. A model that copies an `old_string` out of a
// dedented read and issues an edit gets no match against the indented file on
// disk, and the tool's own contract ("source code and comments are preserved",
// and coverage markers the model is told to read literally) promises the bytes
// it returns are the bytes in the file. Reads stay verbatim.

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