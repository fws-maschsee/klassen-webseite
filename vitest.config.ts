import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		// Braucht Docker/ZITADEL, läuft separat über npm run test:integration.
		exclude: ['tests/integration/**'],
		environment: 'node',
		setupFiles: ['./tests/setup.ts'],
	},
})
