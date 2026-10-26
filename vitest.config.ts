import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

const PERMITTED_TEST_DATABASE = "cashpilot_disposable_test";

const rawTestDbUrl =
  process.env.TEST_DATABASE_URL ||
  "postgresql://cashpilot:cashpilot_dev_password@127.0.0.1:5433/cashpilot_disposable_test?schema=public";

let parsed: URL;
try {
  parsed = new URL(rawTestDbUrl);
} catch {
  throw new Error("SAFETY VIOLATION: Malformed TEST_DATABASE_URL configured for Vitest test runs.");
}

if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
  throw new Error("SAFETY VIOLATION: TEST_DATABASE_URL must use 'postgresql:' or 'postgres:' scheme.");
}

const configuredDbName = parsed.pathname.replace(/^\//, "").split("?")[0];

if (!configuredDbName) {
  throw new Error("SAFETY VIOLATION: TEST_DATABASE_URL does not specify a database name.");
}

if (configuredDbName !== PERMITTED_TEST_DATABASE) {
  throw new Error(
    `SAFETY VIOLATION: Vitest test suite must target "${PERMITTED_TEST_DATABASE}", but configured database is "${configuredDbName}".`
  );
}

const testDbUrl = rawTestDbUrl;

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules", "e2e"],
    env: {
      DATABASE_URL: testDbUrl,
      TEST_DATABASE_URL: testDbUrl,
    },
    coverage: {
      reporter: ["text", "lcov"],
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/db/seed.ts"],
    },
  },
});
