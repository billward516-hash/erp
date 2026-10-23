import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Integration tests share one database; run files serially.
    fileParallelism: false,
    testTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://erp_app:erp_app_dev@localhost:54329/erp_test',
      DATABASE_ADMIN_URL: process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://erp_owner@localhost:54329/erp_test',
      STORAGE_DIR: './.storage/test',
    },
    hookTimeout: 60000,
  },
});
