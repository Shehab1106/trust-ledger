import { defineConfig } from "vitest/config"

// The Postgres schema suite: stands up a real database via testcontainers and
// runs db/schema.sql against it. Needs Docker. Run with `npm run test:db`.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.pg.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 200_000,
  },
})
