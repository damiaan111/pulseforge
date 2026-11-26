import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Setup tests spin up local HTTP servers and hash files; give slow disks room.
    testTimeout: 30_000,
  },
});
