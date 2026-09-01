import fs from 'node:fs'
import type { Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TESTKLASSE } from '../setup.ts'

/**
 * Was unter `public/` der Klasse liegt, ist NICHT oeffentlich.
 *
 * Dieser Test ist gegen einen gemessenen Zustand der laufenden Seite
 * geschrieben, nicht gegen eine Befuerchtung: `/` und `/verteiler` antworteten
 * mit 401, `/dokumente/stundenplan.pdf` mit 200 — weil `express.static` vor dem
 * Astro-Handler lief und die Anmelde-Middleware fuer Dateien damit nie
 * drankam.
 *
 * Geprueft werden beide Richtungen, denn eine Sperre, die alles sperrt, ist
 * genauso kaputt: Der Kalender unter `/public/` MUSS ohne Anmeldung erreichbar
 * bleiben — eine Kalender-App bringt kein Cookie mit, und ein 401 dort laesst
 * jedes Abo still veralten.
 */

const ENTRY_FIXTURE = fileURLToPath(
	new URL('../fixtures/astro-entry.mjs', import.meta.url),
)

type Aufraeumen = () => void | Promise<void>
const aufraeumen: Aufraeumen[] = []

afterEach(async () => {
	while (aufraeumen.length > 0) await aufraeumen.pop()?.()
	vi.unstubAllEnvs()
})

/** Startet die App mit einem bestueckten `dist/client` und gibt die Basis-URL. */
const starte = async (): Promise<string> => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'statisch-'))
	aufraeumen.push(() => fs.rmSync(tmp, { recursive: true, force: true }))

	const statisch = path.join(tmp, 'client')
	fs.mkdirSync(path.join(statisch, 'dokumente'), { recursive: true })
	fs.mkdirSync(path.join(statisch, 'public'), { recursive: true })
	fs.writeFileSync(path.join(statisch, 'dokumente', 'geheim.pdf'), '%PDF-1.7\n')
	fs.writeFileSync(
		path.join(statisch, 'public', 'kalender.ics'),
		'BEGIN:VCALENDAR\n',
	)

	vi.stubEnv('PUBLIC_BASE_URL', undefined)
	vi.stubEnv('PORT', '0')
	vi.stubEnv('DB_PATH', path.join(tmp, 'klasse-beispiel.db'))
	vi.stubEnv('MCP_INSTANCE_NAME', undefined)
	// Der Schalter, den die Tests sonst setzen, ist hier genau das Gegenteil
	// dessen, was geprueft wird.
	vi.stubEnv('DISABLE_AUTH', undefined)

	vi.resetModules()

	const { startServer } = await import('../../src/server/app.ts')
	const { setKlassenConfig } = await import('../../src/klasse/config.ts')
	const { stopQueueWorker } = await import('../../src/server/queue-worker.ts')
	const { closeDb } = await import('../../src/lib/db/index.ts')

	setKlassenConfig(TESTKLASSE)

	const server: Server = await startServer({
		config: TESTKLASSE,
		astroEntry: ENTRY_FIXTURE,
		staticDir: statisch,
	})
	aufraeumen.push(() => {
		stopQueueWorker()
		server.close()
		closeDb()
	})

	const adresse = server.address()
	if (adresse === null || typeof adresse === 'string') {
		throw new Error('Server hat keinen TCP-Port belegt')
	}
	return `http://127.0.0.1:${adresse.port}`
}

describe('statische Dateien', () => {
	// Die Frist ist hoeher als die Vorgabe, weil `vi.resetModules()` vor dem
	// ersten Start die ganze Serverkette neu laedt (Express, MCP-SDK, SQLite)
	// und die Migrationen mitlaufen — das dauert auf einem kalten Lauf
	// mehrere Sekunden und hat mit dem, was hier geprueft wird, nichts zu tun.
	test(
		'eine Datei unter /dokumente/ bekommt ohne Anmeldung keine 200',
		{ timeout: 30_000 },
		async () => {
			const basis = await starte()

			const antwort = await fetch(`${basis}/dokumente/geheim.pdf`, {
				redirect: 'manual',
			})

			// Kein `toBe(401)`: Ob 401 oder eine Umleitung zum Login kommt, haengt
			// am `Accept`-Kopf. Die Behauptung ist die, auf die es ankommt — der
			// Inhalt geht nicht heraus.
			expect(antwort.status).not.toBe(200)
			expect(await antwort.text()).not.toContain('%PDF')
		},
	)

	test(
		'der Kalender unter /public/ bleibt ohne Anmeldung erreichbar',
		{ timeout: 30_000 },
		async () => {
			const basis = await starte()

			const antwort = await fetch(`${basis}/public/kalender.ics`)

			expect(antwort.status).toBe(200)
			expect(await antwort.text()).toContain('BEGIN:VCALENDAR')
		},
	)
})
