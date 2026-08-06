import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
		// Ohne hinterlegte KlassenConfig wirft `klassenConfig()` — absichtlich,
		// damit kein Klassenname erraten wird. Die Tests brauchen deshalb eine
		// Konfiguration, und zwar bevor das erste Modul sie abfragt.
		setupFiles: ['./tests/setup.ts'],
	},
})
