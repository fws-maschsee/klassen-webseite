import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'

/**
 * Kein Modul dieses Packages darf beim IMPORT die KlassenConfig lesen.
 *
 * Das ist die verallgemeinerte Fassung des Fehlers aus `./start.test.ts`: dort
 * war es `mcp/handler.js`, das `publicBaseUrl()` in einer Modulkonstante rief
 * und damit jeden Start ohne `PUBLIC_BASE_URL` abbrach. Ein einzelner Test auf
 * dieses eine Modul hätte das nächste Vorkommen nicht verhindert — die Regel
 * gilt für jedes Modul, das ein `server.ts` erreichen kann, und die Reihenfolge
 * ist bei ESM nie die, die man beim Lesen erwartet.
 *
 * Geprüft wird gegen die QUELLEN und nicht gegen `dist/`, damit `npm test` ohne
 * vorherigen Build läuft. Der Unterschied ist hier keiner: tsc verschiebt keine
 * Ausdrücke zwischen Modulkopf und Funktionsrumpf.
 */

const SRC = fileURLToPath(new URL('../../src', import.meta.url))

const alleModule = (verzeichnis: string): string[] =>
	fs
		.readdirSync(verzeichnis, { withFileTypes: true })
		.flatMap((eintrag) => {
			const voll = path.join(verzeichnis, eintrag.name)
			if (eintrag.isDirectory()) return alleModule(voll)
			return eintrag.name.endsWith('.ts') ? [voll] : []
		})
		.sort()

/**
 * `src/routes/**` bleibt außen vor: diese Dateien importieren das Package unter
 * seinem eigenen Namen (`@fws-maschsee/klassen-webseite/lib/...`), weil sie beim
 * Verbraucher aus `node_modules` heraus geladen werden. Vitest löst diesen Namen
 * nicht auf — ein Alias hier wäre eine zweite Auflösungsregel neben der von
 * tsc und Vite, und eine davon wäre irgendwann falsch. Die Routen sind ohnehin
 * über `astro build` der Klassen abgedeckt.
 */
const AUSGENOMMEN = [`${path.sep}routes${path.sep}`]

const module = alleModule(SRC).filter(
	(datei) => !AUSGENOMMEN.some((teil) => datei.includes(teil)),
)

describe('Importzeit', () => {
	test('es gibt überhaupt Module zu prüfen', () => {
		// Ohne diese Zusicherung wäre ein kaputtes `alleModule()` ein grüner Test
		// über die leere Menge.
		expect(module.length).toBeGreaterThan(40)
	})

	test.each(module.map((datei) => path.relative(SRC, datei)))(
		'src/%s lässt sich ohne hinterlegte KlassenConfig importieren',
		async (relativ) => {
			// Leeres Register wie in einem frisch gestarteten Container: `setup.ts`
			// hat für alle anderen Tests eine Konfiguration hinterlegt, und mit ihr
			// wäre diese Prüfung wertlos.
			vi.resetModules()
			vi.stubEnv('PUBLIC_BASE_URL', undefined)
			vi.stubEnv('DB_PATH', undefined)
			vi.stubEnv('MAIL_FROM', undefined)
			vi.stubEnv('MCP_INSTANCE_NAME', undefined)

			await import(path.join(SRC, relativ))

			vi.unstubAllEnvs()
		},
	)
})
