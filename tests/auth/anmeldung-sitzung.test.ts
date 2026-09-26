import { jwtVerify } from 'jose'
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from 'vitest'
import { closeDb, openDb } from '../../src/lib/db/index.ts'
import { runMigrations } from '../../src/migrations.ts'
import { resetDiscovery } from '../../src/server/auth/discovery.ts'
import {
	handleBackchannelLogout,
	handleCallback,
	handleLogout,
	resetOidcConfig,
	resolveSession,
	startLogin,
} from '../../src/server/auth/oidc.ts'
import { BACKCHANNEL_LOGOUT_EVENT } from '../../src/server/auth/revocation.ts'
import { projectRolesClaim } from '../../src/server/auth/tokenRoles.ts'
import { createIdp, type Idp, ISSUER, pem, rsaKeyPair } from '../helpers/idp.ts'

const CLIENT_ID = 'client-1@projekt'
const clientSchluessel = rsaKeyPair()
const ROLLEN = projectRolesClaim('proj-1')

type TokenAntwort = Record<string, unknown> | { status: number; body: unknown }

let idp: Idp
let tokenAntworten: TokenAntwort[]
let tokenAnfragen: URLSearchParams[]
let widerrufen: URLSearchParams[]

const rollen = (...namen: string[]) =>
	Object.fromEntries(namen.map((n) => [n, { 'org-1': 'schule.example.org' }]))

const idToken = (claims: Record<string, unknown>) =>
	idp.sign({
		aud: CLIENT_ID,
		sub: 'u-anna',
		sid: 'sid-1',
		email: 'anna@example.org',
		name: 'Anna',
		...claims,
	})

beforeAll(() => {
	vi.stubEnv('DB_PATH', ':memory:')
	runMigrations(openDb())
})

afterAll(() => {
	closeDb()
	vi.unstubAllEnvs()
})

beforeEach(() => {
	idp = createIdp()
	tokenAntworten = []
	tokenAnfragen = []
	widerrufen = []
	vi.stubEnv('OIDC_ISSUER', ISSUER)
	vi.stubEnv('OIDC_CLIENT_ID', CLIENT_ID)
	vi.stubEnv(
		'OIDC_CLIENT_KEY',
		JSON.stringify({
			type: 'application',
			keyId: 'app-key-1',
			key: pem(clientSchluessel.privateKey),
			appId: 'app-1',
			clientId: CLIENT_ID,
		}),
	)
	vi.stubEnv('OIDC_CLIENT_SECRET', '')
	vi.stubEnv('OIDC_PUBLIC_ORIGIN', 'http://klasse.example.org')
	vi.stubEnv('SESSION_SECRET', 'testgeheimnis')
	vi.stubEnv('ZITADEL_PROJECT_ID', 'proj-1')
	vi.stubEnv('ZITADEL_ORG_ID', 'org-1')
	vi.stubEnv('ZITADEL_SERVICE_KEY', '')
	vi.stubEnv('ZITADEL_SERVICE_TOKEN', '')
	resetOidcConfig()
	resetDiscovery()
	openDb().exec('DELETE FROM auth_sessions')
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string | URL, init?: RequestInit) => {
			const ziel = String(url)
			if (ziel.endsWith('/.well-known/openid-configuration')) {
				return Response.json(idp.discovery)
			}
			if (ziel === idp.discovery.userinfo_endpoint) {
				return Response.json({ sub: 'u-anna', [ROLLEN]: rollen('admin') })
			}
			if (ziel === idp.discovery.jwks_uri)
				return Response.json(await idp.jwks())
			if (ziel === idp.discovery.revocation_endpoint) {
				widerrufen.push(new URLSearchParams(String(init?.body)))
				return new Response(null, { status: 200 })
			}
			if (ziel === idp.discovery.token_endpoint) {
				tokenAnfragen.push(new URLSearchParams(String(init?.body)))
				const antwort = tokenAntworten.shift()
				if (!antwort)
					return Response.json({ error: 'invalid_grant' }, { status: 400 })
				if ('status' in antwort) {
					return Response.json(antwort.body, {
						status: antwort.status as number,
					})
				}
				return Response.json(antwort)
			}
			return new Response('unerwartet', { status: 500 })
		}),
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
	vi.restoreAllMocks()
	resetOidcConfig()
})

const anmelden = async (
	claims: Record<string, unknown> = { [ROLLEN]: rollen('mitglied') },
) => {
	const start = await startLogin(
		new Request('http://klasse.example.org/verwaltung'),
		'/verwaltung',
	)
	const authorize = new URL(start.headers.get('location') as string)
	const stateKeks = (start.headers.get('set-cookie') as string).split(
		';',
	)[0] as string
	tokenAntworten.push({
		id_token: await idToken({
			nonce: authorize.searchParams.get('nonce'),
			...claims,
		}),
		access_token: 'at-1',
		refresh_token: 'rt-1',
		expires_in: 300,
	})
	const rueck = await handleCallback(
		new Request(
			`http://klasse.example.org/auth/callback?code=c1&state=${authorize.searchParams.get('state')}`,
			{ headers: { cookie: stateKeks } },
		),
	)
	expect(rueck.status).toBe(302)
	const sitzungsKeks = rueck.headers
		.getSetCookie()
		.find((k) => k.startsWith('fws_session=')) as string
	return { authorize, keks: sitzungsKeks.split(';')[0] as string }
}

const mitKeks = (keks: string) =>
	new Request('http://klasse.example.org/verwaltung', {
		headers: { cookie: keks },
	})

describe('Anmeldung mit kurzlebigen Tokens', () => {
	test('fragt die Rollen des Projekts per Scope an', async () => {
		const { authorize } = await anmelden()
		const scopes = authorize.searchParams.get('scope')?.split(' ')
		expect(scopes).toContain('urn:zitadel:iam:org:project:id:proj-1:aud')
		expect(scopes).toContain('urn:zitadel:iam:org:projects:roles')
	})

	test('der Code-Tausch authentisiert sich mit private_key_jwt statt Geheimnis', async () => {
		await anmelden()
		const form = tokenAnfragen[0] as URLSearchParams
		expect(form.get('client_assertion_type')).toBe(
			'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
		)
		expect(form.get('client_id')).toBe(CLIENT_ID)
		const { payload, protectedHeader } = await jwtVerify(
			form.get('client_assertion') as string,
			clientSchluessel.publicKey,
			{ issuer: CLIENT_ID, subject: CLIENT_ID, audience: ISSUER },
		)
		expect(protectedHeader.kid).toBe('app-key-1')
		expect(payload.jti).toBeTruthy()
	})

	test('die Rollen kommen aus dem ID-Token, ohne Dienstzugang', async () => {
		const { keks } = await anmelden()
		const ergebnis = await resolveSession(mitKeks(keks))
		expect(ergebnis.state).toBe('ok')
		expect(ergebnis.session?.roles).toEqual(['mitglied'])
	})

	test('der Keks enthaelt kein Token, nur einen Griff', async () => {
		const { keks } = await anmelden()
		expect(keks).not.toContain('rt-1')
		const zeile = openDb()
			.prepare('SELECT refresh_token, sid FROM auth_sessions')
			.get()
		expect(zeile).toEqual({ refresh_token: 'rt-1', sid: 'sid-1' })
	})

	test('fehlt der Rollen-Claim im ID-Token, gilt Userinfo', async () => {
		const { keks } = await anmelden({})
		const ergebnis = await resolveSession(mitKeks(keks))
		expect(ergebnis.session?.roles).toEqual(['admin'])
	})

	test('ohne Rolle: angemeldet, aber kein Zugang', async () => {
		const { keks } = await anmelden({ [ROLLEN]: rollen('gast') })
		expect((await resolveSession(mitKeks(keks))).state).toBe('unauthorized')
	})

	test('nach Ablauf des Access-Tokens wird verlaengert und die Rolle neu gelesen', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
		const { keks } = await anmelden()

		vi.setSystemTime(new Date('2026-09-26T12:03:00Z'))
		expect((await resolveSession(mitKeks(keks))).state).toBe('ok')
		expect(tokenAnfragen).toHaveLength(1)

		vi.setSystemTime(new Date('2026-09-26T12:05:00Z'))
		tokenAntworten.push({
			id_token: await idToken({ [ROLLEN]: {} }),
			access_token: 'at-2',
			refresh_token: 'rt-2',
			expires_in: 300,
		})
		expect((await resolveSession(mitKeks(keks))).state).toBe('unauthorized')
		const refresh = tokenAnfragen[1] as URLSearchParams
		expect(refresh.get('grant_type')).toBe('refresh_token')
		expect(refresh.get('refresh_token')).toBe('rt-1')
		expect(refresh.get('client_assertion')).toBeTruthy()
	})

	test('scheitert die Verlaengerung, ist man abgemeldet', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
		const { keks } = await anmelden()
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		vi.setSystemTime(new Date('2026-09-26T12:06:00Z'))
		tokenAntworten.push({ status: 400, body: { error: 'invalid_grant' } })
		expect((await resolveSession(mitKeks(keks))).state).toBe('unauthenticated')
		expect(
			openDb().prepare('SELECT COUNT(*) AS n FROM auth_sessions').get(),
		).toEqual({ n: 0 })
	})

	test('gleichzeitige Anfragen verlaengern nur einmal', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
		const { keks } = await anmelden()
		vi.setSystemTime(new Date('2026-09-26T12:06:00Z'))
		tokenAntworten.push({
			id_token: await idToken({ [ROLLEN]: rollen('mitglied') }),
			access_token: 'at-2',
			refresh_token: 'rt-2',
			expires_in: 300,
		})
		const ergebnisse = await Promise.all([
			resolveSession(mitKeks(keks)),
			resolveSession(mitKeks(keks)),
			resolveSession(mitKeks(keks)),
		])
		expect(ergebnisse.map((e) => e.state)).toEqual(['ok', 'ok', 'ok'])
		expect(tokenAnfragen).toHaveLength(2)
	})

	test('Logout loescht die Sitzung und widerruft das Refresh-Token', async () => {
		const { keks } = await anmelden()
		const antwort = await handleLogout(mitKeks(keks))
		expect(antwort.status).toBe(302)
		expect(antwort.headers.get('location')).toContain('/oidc/v1/end_session')
		expect(widerrufen[0]?.get('token')).toBe('rt-1')
		expect((await resolveSession(mitKeks(keks))).state).toBe('unauthenticated')
	})

	test('Back-Channel-Logout beendet die Sitzung sofort', async () => {
		const { keks } = await anmelden()
		vi.spyOn(console, 'log').mockImplementation(() => {})
		const logoutToken = await idp.sign({
			aud: CLIENT_ID,
			sub: 'u-anna',
			sid: 'sid-1',
			jti: 'l1',
			events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
		})
		const antwort = await handleBackchannelLogout(
			new Request('http://klasse.example.org/auth/backchannel-logout', {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ logout_token: logoutToken }).toString(),
			}),
		)
		expect(antwort.status).toBe(200)
		expect((await resolveSession(mitKeks(keks))).state).toBe('unauthenticated')
	})

	test('Back-Channel-Logout ohne gueltiges Token: 400, Sitzung bleibt', async () => {
		const { keks } = await anmelden()
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const antwort = await handleBackchannelLogout(
			new Request('http://klasse.example.org/auth/backchannel-logout', {
				method: 'POST',
				body: new URLSearchParams({ logout_token: 'x.y.z' }).toString(),
			}),
		)
		expect(antwort.status).toBe(400)
		expect((await resolveSession(mitKeks(keks))).state).toBe('ok')
	})

	test('ein Keks mit fremdem Schluessel oeffnet nichts', async () => {
		await anmelden()
		expect((await resolveSession(mitKeks('fws_session=erfunden'))).state).toBe(
			'unauthenticated',
		)
	})
})

describe('Uebergang: Client-Geheimnis', () => {
	test('ohne OIDC_CLIENT_KEY wird mit Basic-Auth getauscht', async () => {
		vi.stubEnv('OIDC_CLIENT_KEY', '')
		vi.stubEnv('OIDC_CLIENT_SECRET', 'geheim')
		resetOidcConfig()
		const fetchMock = vi.mocked(fetch)
		await anmelden()
		const tokenAufruf = fetchMock.mock.calls.find(
			([url]) => String(url) === idp.discovery.token_endpoint,
		)
		const kopf = new Headers(tokenAufruf?.[1]?.headers)
		expect(kopf.get('authorization')).toMatch(/^Basic /)
		expect(tokenAnfragen[0]?.get('client_assertion')).toBeNull()
	})
})
