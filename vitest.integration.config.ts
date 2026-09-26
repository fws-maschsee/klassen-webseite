import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['tests/integration/**/*.test.ts'],
		environment: 'node',
		setupFiles: ['./tests/setup.ts'],
		globalSetup: ['./tests/integration/global-setup.ts'],
		fileParallelism: false,
		testTimeout: 60_000,
		hookTimeout: 180_000,
	},
})
