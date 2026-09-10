import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // *.test.ts only, deliberately. `contract.spec.ts` drives a real browser
    // against a real account, and it must never be something `pnpm -r test` or
    // CI can start by accident.
    include: ['src/**/*.test.ts'],
  },
})
