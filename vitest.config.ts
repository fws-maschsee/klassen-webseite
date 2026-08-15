import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts'],
		// Die Integrationstests der Anmeldung brauchen Docker und laufen deshalb
		// über `vitest.integration.config.ts` (`npm run test:integration`). Ohne
		// diesen Ausschluss bräche `npm test` auf jedem Rechner ohne laufendes
		// ZITADEL — und ein Testlauf, der aus einem Grund rot ist, den er nicht
		// meint, wird bald gar nicht mehr gelesen.
		exclude: ['tests/integration/**'],
		environment: 'node',
		// Ohne hinterlegte KlassenConfig wirft `klassenConfig()` — absichtlich,
		// damit kein Klassenname erraten wird. Die Tests brauchen deshalb eine
		// Konfiguration, und zwar bevor das erste Modul sie abfragt.
		setupFiles: ['./tests/setup.ts'],
	},
})
