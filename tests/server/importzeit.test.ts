import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'

/**
 * Kein Modul des geteilten Codes darf beim IMPORT die KlassenConfig lesen.
 *
 * Das ist die verallgemeinerte Fassung des Fehlers aus `./start.test.ts`: dort
 * war es `mcp/handler.ts`, das `publicBaseUrl()` in einer Modulkonstante rief
 * und damit jeden Start ohne `PUBLIC_BASE_URL` abbrach. Ein einzelner Test auf
 * dieses eine Modul hätte das nächste Vorkommen nicht verhindert — die Regel
 * gilt für jedes Modul, das ein `server.ts` erreichen kann, und die Reihenfolge
 * ist bei ESM nie die, die man beim Lesen erwartet.
 *
 * Die Regel hat nichts mit npm zu tun und gilt per Submodule unverändert: sie
 * folgt aus der Auswertungsreihenfolge von ESM-Importen. Ein `import` ist
 * vollständig ausgewertet, bevor der Rumpf des importierenden Moduls läuft —
 * `setKlassenConfig()` in `startServer()` kommt damit immer zu spät.
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
 * ALLE Module unter `src/`, ohne Ausnahme.
 *
 * `src/routes/**` war ausgenommen, solange diese Dateien den geteilten Code
 * unter seinem Package-Namen importierten — den löste vitest nicht auf, und ein
 * Alias hier wäre eine zweite Auflösungsregel neben der von tsc und Vite
 * gewesen. Seit alles relativ importiert wird, gibt es keinen Namen mehr
 * aufzulösen, und die Routen fallen unter dieselbe Regel wie der Rest: sie
 * werden von `injectRoute` in JEDER Klasse geladen.
 */
const module = alleModule(SRC)

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
