import fs from 'node:fs'
import type { Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TESTKLASSE } from '../setup.js'

/**
 * Der Start einer Klassen-App, so wie ihr `server.ts` ihn macht: Modul
 * importieren, Konfiguration hinterlegen, App starten — und zwar OHNE
 * `PUBLIC_BASE_URL` in der Umgebung.
 *
 * Genau dieser Ablauf war in 0.2.0 unmöglich. `dist/server/app.js` importiert
 * `mcp/handler.js`, und dessen Modulkopf baute die Bearer-Middleware als
 * Konstante — mit einem Aufruf von `publicBaseUrl()`, der ohne
 * `PUBLIC_BASE_URL` auf `klassenConfig()` zurückfällt. ESM wertet Importe
 * vollständig aus, bevor der Rumpf des importierenden Moduls läuft; das
 * `setKlassenConfig()` in `startServer()` kam damit immer zu spät und der
 * Prozess starb mit „Keine KlassenConfig hinterlegt".
 *
 * Im Cluster fiel das nicht auf, weil dort `PUBLIC_BASE_URL` gesetzt ist.
 * Aufgefallen ist es in den Image-Smoke-Tests von `klasse-wiesen` und
 * `klasse-christophers`, die das Image absichtlich ohne Cluster-Env starten —
 * und behelfsweise behoben mit einem dynamischen Import in beiden `server.ts`.
 * Dieser Test ist die Bedingung dafür, dass dort wieder der Dreizeiler aus der
 * README stehen darf.
 *
 * `vi.resetModules()` ist der Kern des Tests und keine Hygiene: `tests/setup.ts`
 * hinterlegt für alle anderen Tests eine Konfiguration, und mit ihr wäre der
 * Fehler nicht reproduzierbar. Nach dem Reset ist das Register genauso leer wie
 * in einem frisch gestarteten Container.
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

describe('startServer ohne PUBLIC_BASE_URL', () => {
	test('der Import von server-app wertet die Konfiguration nicht aus', async () => {
		vi.stubEnv('PUBLIC_BASE_URL', undefined)
		vi.resetModules()

		// Kein `expect(...).resolves` und kein try/catch: der Import IST die
		// Behauptung. Schlug er fehl, war die Fehlermeldung „Keine KlassenConfig
		// hinterlegt" — und die soll im Testprotokoll stehen, nicht ein
		// abstrahiertes `toThrow`.
		const modul = await import('../../src/server/app.js')
		expect(typeof modul.startServer).toBe('function')
	})

	test('Konfiguration hinterlegen, dann starten — der Dreizeiler aus der README', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'start-server-'))
		aufraeumen.push(() => fs.rmSync(tmp, { recursive: true, force: true }))

		vi.stubEnv('PUBLIC_BASE_URL', undefined)
		// Port 0: das Betriebssystem sucht einen freien Port. Ein festes 4321
		// wäre ein Test, der scheitert, weil jemand daneben einen Server laufen
		// hat.
		vi.stubEnv('PORT', '0')
		vi.stubEnv('DB_PATH', path.join(tmp, 'klasse-beispiel.db'))
		vi.stubEnv('MCP_INSTANCE_NAME', undefined)

		vi.resetModules()

		// Reihenfolge wie in `server.ts` einer Klasse: erst der Import des
		// Packages, DANN die Konfiguration.
		const { startServer } = await import('../../src/server/app.js')
		// Aus derselben Modulinstanz wie die, die `app.js` gerade geladen hat —
		// nach `resetModules()` ist das Register ein anderes Objekt als das aus
		// `tests/setup.ts`.
		const { setKlassenConfig } = await import('../../src/klasse/config.js')
		const { stopQueueWorker } = await import('../../src/server/queue-worker.js')
		const { closeDb } = await import('../../src/lib/db/index.js')

		setKlassenConfig(TESTKLASSE)

		const server: Server = await startServer({
			config: TESTKLASSE,
			astroEntry: ENTRY_FIXTURE,
		})
		aufraeumen.push(() => {
			stopQueueWorker()
			server.close()
			closeDb()
		})

		expect(server.listening).toBe(true)

		const adresse = server.address()
		if (adresse === null || typeof adresse === 'string') {
			throw new Error('Server hat keinen TCP-Port belegt')
		}
		const basis = `http://127.0.0.1:${adresse.port}`

		// Die Middleware entsteht erst hier, beim ersten Request — und sie muss
		// funktionieren, nicht nur existieren. 401 mit `WWW-Authenticate` beweist
		// beides: gebaut wurde sie, und `publicBaseUrl()` hat die hinterlegte
		// Konfiguration gefunden.
		const mcp = await fetch(`${basis}/mcp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		})
		expect(mcp.status).toBe(401)
		expect(mcp.headers.get('www-authenticate')).toContain(
			`${TESTKLASSE.siteUrl}/.well-known/oauth-protected-resource`,
		)

		// Der OAuth-Router hängt am `issuerUrl`, den `publicBaseUrl()` liefert.
		// Steht dort der Wert aus der KlassenConfig, ist die Kette vollständig.
		const metadaten = await fetch(
			`${basis}/.well-known/oauth-authorization-server`,
		)
		expect(metadaten.status).toBe(200)
		expect(await metadaten.json()).toMatchObject({
			issuer: `${TESTKLASSE.siteUrl}/`,
		})

		// Der Astro-Handler bekommt alles Übrige — hier die Fixture statt eines
		// echten Astro-Builds.
		const seite = await fetch(`${basis}/irgendwas`)
		expect(await seite.text()).toBe('astro-fixture')

		// Ohne `calendarLegacyPath` gibt es keine Umleitung: der Pfad landet beim
		// Astro-Handler wie jeder andere. Sonst bekäme jede Klasse eine Route, die
		// sie nie bestellt hat.
		const ohneAlt = await fetch(`${basis}/beispiel.ics`, { redirect: 'manual' })
		expect(ohneAlt.status).not.toBe(301)
	})
})

/**
 * Die alte Kalenderadresse. In `klasse-christophers` lag die Datei sieben
 * Monate unter einem anderen Pfad; wer in diesem Zeitraum abonniert hat, hängt
 * daran und darf nicht ein zweites Mal stillschweigend herausfallen.
 *
 * Geprüft wird am laufenden Server und nicht an der Konfiguration: dass der
 * Wert im Objekt steht, sagt nichts darüber, ob eine Kalender-App eine
 * Weiterleitung bekommt.
 */
describe('alte Kalenderadresse', () => {
	test('antwortet mit 301 auf den heutigen Pfad', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'start-server-alt-'))
		aufraeumen.push(() => fs.rmSync(tmp, { recursive: true, force: true }))

		vi.stubEnv('PUBLIC_BASE_URL', undefined)
		vi.stubEnv('PORT', '0')
		vi.stubEnv('DB_PATH', path.join(tmp, 'klasse-beispiel.db'))
		vi.stubEnv('MCP_INSTANCE_NAME', undefined)

		vi.resetModules()

		const { startServer } = await import('../../src/server/app.js')
		const { defineKlassenConfig, setKlassenConfig } = await import(
			'../../src/klasse/config.js'
		)
		const { stopQueueWorker } = await import('../../src/server/queue-worker.js')
		const { closeDb } = await import('../../src/lib/db/index.js')

		const config = defineKlassenConfig({
			slug: 'klasse-beispiel',
			label: 'Klasse Beispiel',
			domain: 'klasse-beispiel.example.org',
			repoUrl: 'https://github.com/fws-maschsee/klasse-beispiel',
			contactMail: 'verwaltung@example.org',
			calendarPath: '/public/beispiel.ics',
			calendarLegacyPath: '/beispiel.ics',
		})
		setKlassenConfig(config)

		const server: Server = await startServer({
			config,
			astroEntry: ENTRY_FIXTURE,
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

		// `redirect: 'manual'` — sonst folgt fetch der Umleitung und der Test
		// prüfte am Ende den Astro-Handler statt der Weiterleitung.
		const antwort = await fetch(
			`http://127.0.0.1:${adresse.port}/beispiel.ics`,
			{ redirect: 'manual' },
		)
		expect(antwort.status).toBe(301)
		expect(antwort.headers.get('location')).toBe('/public/beispiel.ics')
	})
})
