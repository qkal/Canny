import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
    coverage: {
      include: ["src/**"],
      // `cli.ts` only ever runs as a child process of test/cli.test.ts, where v8 coverage cannot follow.
      exclude: ["src/cli.ts"],
      // A fixed width: sized from a narrow terminal, the table drops its file names.
      reporter: [["text", { maxCols: 100 }]],
      // A little under what the suite reaches today, so new code that arrives without tests fails the gate.
      thresholds: { lines: 97, statements: 97, functions: 96, branches: 90 },
    },
  },
});
