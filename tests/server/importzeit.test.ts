import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'

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

const module = alleModule(SRC)

describe('Importzeit', () => {
	test('es gibt überhaupt Module zu prüfen', () => {
		// Sonst waere ein kaputtes `alleModule()` ein gruener Test ueber die leere Menge.
		expect(module.length).toBeGreaterThan(40)
	})

	test.each(module.map((datei) => path.relative(SRC, datei)))(
		'src/%s lässt sich ohne hinterlegte KlassenConfig importieren',
		async (relativ) => {
			// Leeres Register wie im frischen Container; setup.ts hat sonst schon eine Konfiguration hinterlegt.
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
