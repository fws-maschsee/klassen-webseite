import fs from 'node:fs'
import type { Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { pruefeHerkunft } from '../../src/server/herkunft.ts'
import { TESTKLASSE } from '../setup.ts'

const EIGENE = 'https://klasse.example.org'

describe('pruefeHerkunft', () => {
	const urteil = (
		method: string,
		pfad: string,
		secFetchSite?: string,
		origin?: string,
	) => pruefeHerkunft({ method, pfad, secFetchSite, origin }, EIGENE)

	test.each([
		['GET', 'cross-site'],
		['HEAD', 'cross-site'],
		['OPTIONS', 'cross-site'],
	])('%s ist immer erlaubt', (method, site) => {
		expect(urteil(method, '/verwaltung', site).erlaubt).toBe(true)
	})

	test.each(['same-origin', 'none'])(
		'Sec-Fetch-Site %s ist erlaubt',
		(site) => {
			expect(
				urteil('POST', '/verwaltung', site, 'https://boese.example').erlaubt,
			).toBe(true)
		},
	)

	test.each(['cross-site', 'same-site'])(
		'Sec-Fetch-Site %s wird abgewiesen, auch mit passendem Origin',
		(site) => {
			expect(urteil('POST', '/verwaltung', site, EIGENE).erlaubt).toBe(false)
		},
	)

	test('ohne Sec-Fetch-Site entscheidet Origin gegen die konfigurierte Adresse', () => {
		expect(urteil('POST', '/verwaltung', undefined, EIGENE).erlaubt).toBe(true)
		expect(
			urteil('POST', '/verwaltung', undefined, 'https://boese.example').erlaubt,
		).toBe(false)
		expect(urteil('POST', '/verwaltung', undefined, 'null').erlaubt).toBe(false)
		expect(
			urteil('POST', '/verwaltung', undefined, 'http://klasse.example.org')
				.erlaubt,
		).toBe(false)
	})

	test('ohne beide Köpfe ist es kein Browser', () => {
		expect(urteil('POST', '/verwaltung').erlaubt).toBe(true)
	})

	test('Ausnahmen gelten nur für den exakten Pfad', () => {
		expect(urteil('POST', '/api/lists/incoming', 'cross-site')).toEqual({
			erlaubt: true,
			ausnahme: true,
		})
		expect(urteil('POST', '/api/lists/incoming/', 'cross-site').erlaubt).toBe(
			false,
		)
		expect(urteil('POST', '/api/lists/incomingx', 'cross-site').erlaubt).toBe(
			false,
		)
		expect(urteil('POST', '/auth/logout', 'cross-site').erlaubt).toBe(false)
		expect(urteil('POST', '/oauth/consent', 'cross-site').erlaubt).toBe(false)
		expect(urteil('POST', '/authorize', 'cross-site').erlaubt).toBe(false)
	})
})

const ECHO = fileURLToPath(
	new URL('../fixtures/astro-echo.mjs', import.meta.url),
)

describe('der Server hinter Express', () => {
	let basis: string
	let beenden: () => void

	beforeAll(async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herkunft-'))
		vi.stubEnv('PUBLIC_BASE_URL', EIGENE)
		vi.stubEnv('OIDC_PUBLIC_ORIGIN', EIGENE)
		vi.stubEnv('PORT', '0')
		vi.stubEnv('DB_PATH', path.join(tmp, 'klasse-beispiel.db'))
		vi.resetModules()
		const { startServer } = await import('../../src/server/app.ts')
		const { setKlassenConfig } = await import('../../src/klasse/config.ts')
		const { stopQueueWorker } = await import('../../src/server/queue-worker.ts')
		const { closeDb } = await import('../../src/lib/db/index.ts')
		setKlassenConfig(TESTKLASSE)
		vi.spyOn(console, 'log').mockImplementation(() => {})
		const server: Server = await startServer({
			config: TESTKLASSE,
			astroEntry: ECHO,
		})
		const adresse = server.address()
		if (adresse === null || typeof adresse === 'string') {
			throw new Error('Server hat keinen TCP-Port belegt')
		}
		basis = `http://127.0.0.1:${adresse.port}`
		beenden = () => {
			stopQueueWorker()
			server.close()
			closeDb()
			fs.rmSync(tmp, { recursive: true, force: true })
		}
	})

	afterAll(() => {
		beenden()
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	const post = (pfad: string, kopf: Record<string, string>) =>
		fetch(`${basis}${pfad}`, { method: 'POST', headers: kopf, body: 'x=1' })

	test('Cross-Site-POST: 403 mit Text, und es steht im Log', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const antwort = await post('/verwaltung', {
			'sec-fetch-site': 'cross-site',
			cookie: '__Host-fws_session=x',
		})
		expect(antwort.status).toBe(403)
		expect(await antwort.text()).toContain('nicht von dieser Seite')
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('[herkunft] POST /verwaltung abgewiesen'),
		)
	})

	test('fremder Origin ohne Sec-Fetch-Site: 403', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const antwort = await post('/public/mitbringen/abc/eintrag', {
			origin: 'https://boese.example',
		})
		expect(antwort.status).toBe(403)
	})

	test('Same-Origin-POST kommt durch, mit Keks', async () => {
		const antwort = await post('/verwaltung', {
			'sec-fetch-site': 'same-origin',
			origin: EIGENE,
			cookie: '__Host-fws_session=x',
		})
		expect(antwort.status).toBe(200)
		expect(await antwort.json()).toEqual({
			method: 'POST',
			cookie: '__Host-fws_session=x',
		})
	})

	test.each([
		'/api/lists/incoming',
		'/auth/backchannel-logout',
		'/auth/zitadel-events',
	])(
		'%s: signierter Eingang kommt cross-site durch, aber ohne Keks',
		async (pfad) => {
			const antwort = await post(pfad, {
				'sec-fetch-site': 'cross-site',
				cookie: '__Host-fws_session=x',
			})
			expect(antwort.status).toBe(200)
			expect(await antwort.json()).toEqual({ method: 'POST', cookie: null })
		},
	)

	test('/register ist cross-site erreichbar und lehnt fremde Ziele ab', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const registrieren = (redirect: string) =>
			fetch(`${basis}/register`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'sec-fetch-site': 'cross-site',
					origin: 'https://claude.ai',
				},
				body: JSON.stringify({
					client_name: 'Claude',
					redirect_uris: [redirect],
					token_endpoint_auth_method: 'none',
				}),
			})
		const fremd = await registrieren('https://boese.example/cb')
		expect(fremd.status).toBe(400)
		expect(await fremd.json()).toMatchObject({ error: 'invalid_redirect_uri' })
		const claude = await registrieren('https://claude.ai/api/mcp/auth_callback')
		expect(claude.status).toBe(201)
	})

	test('jede Antwort verbietet das Einbetten', async () => {
		const antwort = await fetch(`${basis}/irgendwas`)
		expect(antwort.headers.get('content-security-policy')).toBe(
			"frame-ancestors 'none'",
		)
		expect(antwort.headers.get('x-frame-options')).toBe('DENY')
		const abgewiesen = await post('/verwaltung', {
			'sec-fetch-site': 'cross-site',
		})
		expect(abgewiesen.headers.get('x-frame-options')).toBe('DENY')
	})

	describe('Umzug des Sitzungskekses', () => {
		test('der alte Keks wird umbenannt, niemand wird abgemeldet', async () => {
			const antwort = await fetch(`${basis}/verwaltung`, {
				headers: { cookie: 'andere=1; fws_session=griff%2Bwert' },
			})
			expect(await antwort.json()).toEqual({
				method: 'GET',
				cookie: 'andere=1; __Host-fws_session=griff%2Bwert',
			})
			const gesetzt = antwort.headers.getSetCookie()
			expect(gesetzt[0]).toMatch(
				/^__Host-fws_session=griff%2Bwert; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/,
			)
			expect(gesetzt[0]).not.toContain('Domain')
			expect(gesetzt[1]).toMatch(/^fws_session=; Path=\/;.*Max-Age=0/)
		})

		test('ist der neue schon da, wird der alte nur gelöscht', async () => {
			const antwort = await fetch(`${basis}/verwaltung`, {
				headers: { cookie: 'fws_session=alt; __Host-fws_session=neu' },
			})
			expect((await antwort.json()).cookie).toBe('__Host-fws_session=neu')
			const gesetzt = antwort.headers.getSetCookie()
			expect(gesetzt).toHaveLength(1)
			expect(gesetzt[0]).toMatch(/^fws_session=;.*Max-Age=0/)
		})

		test('ein doppelter alter Keks wird nicht übernommen', async () => {
			vi.spyOn(console, 'warn').mockImplementation(() => {})
			const antwort = await fetch(`${basis}/verwaltung`, {
				headers: { cookie: 'fws_session=opfer; fws_session=angreifer' },
			})
			expect((await antwort.json()).cookie).toBeNull()
			expect(antwort.headers.getSetCookie().join('\n')).not.toContain('__Host-')
		})

		test('ohne alten Keks bleibt alles, wie es ist', async () => {
			const antwort = await fetch(`${basis}/verwaltung`, {
				headers: { cookie: '__Host-fws_session=neu' },
			})
			expect(antwort.headers.getSetCookie()).toEqual([])
			expect((await antwort.json()).cookie).toBe('__Host-fws_session=neu')
		})
	})
})
