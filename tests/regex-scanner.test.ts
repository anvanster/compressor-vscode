import { expect, it } from 'vitest';
import { RegexScanner } from '../src/tools/regex-scanner';

it('matches case-insensitive regexes with bounded continuation in a reusable worker', async () => {
  const scanner = new RegexScanner('hit\\d+', true);
  try {
    expect(await scanner.scan('HIT1\nno\nhit2\nhit3', 1, 1)).toEqual({ indices: [2], skipped: 1 });
    expect(await scanner.scan('hit4', 0, 5)).toEqual({ indices: [0], skipped: 0 });
  } finally { await scanner.dispose(); }
});

it('terminates catastrophic backtracking without blocking the host event loop', async () => {
  const scanner = new RegexScanner('(a+)+$', false, () => false, 150);
  let responsive = false;
  const timer = setTimeout(() => { responsive = true; }, 20);
  try {
    await expect(scanner.scan('a'.repeat(100_000) + '!', 0, 1)).rejects.toThrow('timed out');
    expect(responsive).toBe(true);
  } finally { clearTimeout(timer); await scanner.dispose(); }
});

it('cancels a running pathological regex', async () => {
  let cancelled = false;
  const scanner = new RegexScanner('(a+)+$', false, () => cancelled);
  const timer = setTimeout(() => { cancelled = true; }, 75);
  try {
    await expect(scanner.scan('a'.repeat(100_000) + '!', 0, 1)).rejects.toThrow('cancelled');
  } finally { clearTimeout(timer); await scanner.dispose(); }
});