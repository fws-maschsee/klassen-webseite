import { defineConfig } from 'vitest/config'

/**
 * Die Integrationstests der Anmeldung — eigene Konfiguration, weil sie etwas
 * brauchen, das `npm test` nicht voraussetzen darf: Docker.
 *
 * Zwei Läufe statt einem Lauf mit einem Schalter. Ein Schalter hiesse, dass
 * `npm test` auf einem Rechner ohne Docker mit einer unverständlichen Meldung
 * abbricht — und dann schaltet man ihn ab und merkt nicht, wann er wieder an
 * gehört. Getrennt ist die Frage „läuft ZITADEL?" eine Eigenschaft des
 * Befehls, den man aufruft.
 */
export default defineConfig({
	test: {
		include: ['tests/integration/**/*.test.ts'],
		environment: 'node',
		// Dieselbe Testklasse wie überall sonst, aus demselben Grund: Ein Test
		// gegen eine der echten Klassen sagt nichts über die andere.
		setupFiles: ['./tests/setup.ts'],
		// Startet ZITADEL und Postgres einmal für den ganzen Lauf.
		globalSetup: ['./tests/integration/global-setup.ts'],
		// Eine Instanz, ein Server, eine Organisation: Parallele Dateien
		// arbeiteten auf demselben Zustand, und der Entzug in (d) zöge einem
		// anderen Test den Boden weg.
		fileParallelism: false,
		// Der Entzug in (d) wartet auf den Zwischenspeicher in `grants.ts`
		// (fünf Sekunden) und dann auf ZITADELs Projektion. Die Frist begrenzt
		// einen Hänger; erreicht wird sie im grünen Fall nie.
		testTimeout: 60_000,
		// Der Aufbau: Server starten, dann rund fünfzehn Aufrufe gegen ZITADEL.
		hookTimeout: 180_000,
	},
})
