import { migrate } from '../src/platform/db/migrate.js';

export default async function setup() {
  const url = process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://erp_owner@localhost:54329/erp_test';
  await migrate(url, { reset: true });
}
