import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { AGENT_CONTENT } from '../src/steering';

it('declares all five tools and exposes new inputs to the model', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const tools = manifest.contributes.languageModelTools;
  expect(tools).toHaveLength(5);
  for (const tool of tools) {
    expect(AGENT_CONTENT).toContain(tool.toolReferenceName);
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.modelDescription).not.toContain('lossless');
  }
  expect(tools.find((tool: { name: string }) => tool.name === 'compressor_read').inputSchema.properties.symbol).toBeDefined();
  expect(tools.find((tool: { name: string }) => tool.name === 'compressor_log').inputSchema.properties.characterOffset).toBeDefined();
  expect(tools.find((tool: { name: string }) => tool.name === 'compressor_search').inputSchema.properties.contextLines).toMatchObject({ type: 'integer', minimum: 0, maximum: 5 });
});