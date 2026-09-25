import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@agent-tool-platform/agent-kit': resolvePath('../../packages/agent-kit/src/index.ts'),
      '@agent-tool-platform/capability-registry': resolvePath(
        '../../packages/capability-registry/src/index.ts',
      ),
      '@agent-tool-platform/runtime': resolvePath('../../packages/runtime/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
