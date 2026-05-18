import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['filesystem/**/*.test.js'],
  },
});
