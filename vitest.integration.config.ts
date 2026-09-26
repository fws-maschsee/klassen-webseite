import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['tests/integration/**/*.test.ts'],
		environment: 'node',
		setupFiles: ['./tests/setup.ts'],
		globalSetup: ['./tests/integration/global-setup.ts'],
		// Alle Dateien teilen eine ZITADEL-Instanz; der Rechte-Entzug würde parallelen Tests den Boden wegziehen.
		fileParallelism: false,
		testTimeout: 60_000,
		hookTimeout: 180_000,
	},
})
