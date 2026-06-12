import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // the real 'vscode' module only exists inside the extension host
      vscode: path.resolve(__dirname, 'tests/mocks/vscode.ts'),
    },
  },
});
