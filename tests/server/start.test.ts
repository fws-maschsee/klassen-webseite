import fs from 'node:fs'
import type { Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TESTKLASSE } from '../setup.ts'

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
		// Leeres Register wie im frischen Container; setup.ts hat sonst schon eine Konfiguration hinterlegt.
		vi.resetModules()

		// Kein `resolves`/try: der Import ist die Behauptung, seine Fehlermeldung soll im Protokoll stehen.
		const modul = await import('../../src/server/app.ts')
		expect(typeof modul.startServer).toBe('function')
	})

	test('Konfiguration hinterlegen, dann starten — der Dreizeiler aus der README', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'start-server-'))
		aufraeumen.push(() => fs.rmSync(tmp, { recursive: true, force: true }))

		vi.stubEnv('PUBLIC_BASE_URL', undefined)
		vi.stubEnv('PORT', '0')
		vi.stubEnv('DB_PATH', path.join(tmp, 'klasse-beispiel.db'))
		vi.stubEnv('MCP_INSTANCE_NAME', undefined)

		vi.resetModules()

		const { startServer } = await import('../../src/server/app.ts')
		// Nach resetModules aus derselben Modulinstanz wie app.ts, nicht aus setup.ts.
		const { setKlassenConfig } = await import('../../src/klasse/config.ts')
		const { stopQueueWorker } = await import('../../src/server/queue-worker.ts')
		const { closeDb } = await import('../../src/lib/db/index.ts')

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

		const mcp = await fetch(`${basis}/mcp`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{}',
		})
		expect(mcp.status).toBe(401)
		expect(mcp.headers.get('www-authenticate')).toContain(
			`${TESTKLASSE.siteUrl}/.well-known/oauth-protected-resource`,
		)

		const metadaten = await fetch(
			`${basis}/.well-known/oauth-authorization-server`,
		)
		expect(metadaten.status).toBe(200)
		expect(await metadaten.json()).toMatchObject({
			issuer: `${TESTKLASSE.siteUrl}/`,
		})

		const seite = await fetch(`${basis}/irgendwas`)
		expect(await seite.text()).toBe('astro-fixture')

		const ohneAlt = await fetch(`${basis}/beispiel.ics`, { redirect: 'manual' })
		expect(ohneAlt.status).not.toBe(301)
	})
})

describe('alte Kalenderadresse', () => {
	test('antwortet mit 301 auf den heutigen Pfad', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'start-server-alt-'))
		aufraeumen.push(() => fs.rmSync(tmp, { recursive: true, force: true }))

		vi.stubEnv('PUBLIC_BASE_URL', undefined)
		vi.stubEnv('PORT', '0')
		vi.stubEnv('DB_PATH', path.join(tmp, 'klasse-beispiel.db'))
		vi.stubEnv('MCP_INSTANCE_NAME', undefined)

		vi.resetModules()

		const { startServer } = await import('../../src/server/app.ts')
		const { defineKlassenConfig, setKlassenConfig } = await import(
			'../../src/klasse/config.ts'
		)
		const { stopQueueWorker } = await import('../../src/server/queue-worker.ts')
		const { closeDb } = await import('../../src/lib/db/index.ts')

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

		const antwort = await fetch(
			`http://127.0.0.1:${adresse.port}/beispiel.ics`,
			{ redirect: 'manual' },
		)
		expect(antwort.status).toBe(301)
		expect(antwort.headers.get('location')).toBe('/public/beispiel.ics')
	})
})
