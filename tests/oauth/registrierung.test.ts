import type { Database } from 'better-sqlite3'
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
import {
	createAuthCode,
	createPendingAuthorization,
	getClient,
	issueTokens,
	OAUTH_CLIENT_KARENZ_SEKUNDEN,
	raeumeOAuthAuf,
	registerClient,
	revokeToken,
} from '../../src/lib/db/oauth.ts'
import { runMigrations } from '../../src/migrations.ts'
import { mcpOAuthProvider } from '../../src/server/oauth/provider.ts'
import { pruefeRedirectUri } from '../../src/server/oauth/redirectZiel.ts'
import { createTestDb } from '../helpers/db.ts'

describe('pruefeRedirectUri', () => {
	test.each([
		['https://claude.ai/api/mcp/auth_callback', 'freigegeben', 'claude.ai'],
		['https://claude.com/api/mcp/auth_callback', 'freigegeben', 'claude.com'],
		['http://localhost:33418/callback', 'lokal', 'localhost:33418'],
		['http://127.0.0.1:41234/cb', 'lokal', '127.0.0.1:41234'],
		['http://[::1]:8080/cb', 'lokal', '[::1]:8080'],
	])('%s ist erlaubt', (uri, art, host) => {
		expect(pruefeRedirectUri(uri)).toEqual({ ok: true, ziel: { art, host } })
	})

	test.each([
		'https://boese.example/cb',
		'https://claude.ai.boese.example/cb',
		'http://claude.ai/api/mcp/auth_callback',
		'https://claude.ai/api/mcp/auth_callback#x',
		'https://nutzer:pw@claude.ai/cb',
		'javascript:alert(1)',
		'cursor://anysphere.cursor-retrieval/oauth/callback',
		'/relativ',
		'http://localhost.boese.example/cb',
	])('%s wird abgelehnt', (uri) => {
		expect(pruefeRedirectUri(uri).ok).toBe(false)
	})
})

describe('Registrierung über den Provider', () => {
	beforeAll(() => {
		vi.stubEnv('DB_PATH', ':memory:')
		runMigrations(openDb())
	})
	afterAll(() => {
		closeDb()
		vi.unstubAllEnvs()
	})

	const registrieren = (redirect_uris: string[], client_name = 'Claude') =>
		mcpOAuthProvider.clientsStore.registerClient?.({
			client_name,
			redirect_uris,
			token_endpoint_auth_method: 'none',
		} as never)

	test('Claude und loopback werden registriert', async () => {
		const client = await registrieren([
			'https://claude.ai/api/mcp/auth_callback',
		])
		expect(client?.client_id).toMatch(/^mcp_/)
		expect(await registrieren(['http://localhost:5555/callback'])).toBeTruthy()
	})

	test('ein fremdes Ziel wird mit invalid_redirect_uri abgewiesen', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		await expect(
			(async () => registrieren(['https://boese.example/cb']))(),
		).rejects.toMatchObject({ errorCode: 'invalid_redirect_uri' })
		await expect(
			(async () =>
				registrieren([
					'https://claude.ai/api/mcp/auth_callback',
					'https://boese.example/cb',
				]))(),
		).rejects.toMatchObject({ errorCode: 'invalid_redirect_uri' })
	})

	test('ein überlanger Name wird abgewiesen', async () => {
		await expect(
			(async () =>
				registrieren(
					['https://claude.ai/cb'],
					'Klassenverwaltung '.repeat(10),
				))(),
		).rejects.toMatchObject({ errorCode: 'invalid_client_metadata' })
	})

	test('ein Altbestand mit fremdem Ziel gilt als unbekannt', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const alt = registerClient({
			client_name: 'Alt',
			redirect_uris: ['https://boese.example/cb'],
		}).client
		expect(await mcpOAuthProvider.clientsStore.getClient(alt.client_id)).toBe(
			undefined,
		)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('gesperrt'))
	})
})

describe('raeumeOAuthAuf', () => {
	let db: Database
	const jetzt = 2_000_000_000
	const alt = jetzt - OAUTH_CLIENT_KARENZ_SEKUNDEN - 1

	const client = (ausgestellt: number): string => {
		const id = registerClient(
			{ client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] },
			db,
		).client.client_id
		db.prepare(
			'UPDATE oauth_clients SET client_id_issued_at = ? WHERE client_id = ?',
		).run(ausgestellt, id)
		return id
	}

	const tokens = (client_id: string, ttl: number) =>
		issueTokens(
			{
				client_id,
				user_id: 'sub-1',
				roles: null,
				scopes: ['mcp'],
				resource: null,
				access_ttl_seconds: ttl,
				refresh_ttl_seconds: ttl,
			},
			db,
		)

	beforeEach(() => {
		db = createTestDb()
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(jetzt * 1000)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	test('eine verlassene Registrierung verschwindet nach der Karenz', () => {
		const verlassen = client(alt)
		const frisch = client(jetzt - 60)
		expect(raeumeOAuthAuf(db, jetzt).clients).toBe(1)
		expect(getClient(verlassen, db)).toBeUndefined()
		expect(getClient(frisch, db)).toBeDefined()
	})

	test('ein benutzter Client bleibt, solange ein Refresh-Token gilt', () => {
		const benutzt = client(alt)
		tokens(benutzt, 3600)
		expect(raeumeOAuthAuf(db, jetzt).clients).toBe(0)
		expect(getClient(benutzt, db)).toBeDefined()
	})

	test('sind alle Tokens abgelaufen oder widerrufen, geht auch der Client', () => {
		const abgelaufen = client(alt)
		const widerrufen = client(alt)
		vi.setSystemTime((jetzt - 10) * 1000)
		tokens(abgelaufen, 5)
		vi.setSystemTime(jetzt * 1000)
		const t = tokens(widerrufen, 3600)
		revokeToken(t.access_token, db)
		revokeToken(t.refresh_token, db)
		const ergebnis = raeumeOAuthAuf(db, jetzt)
		expect(ergebnis.clients).toBe(2)
		expect(ergebnis.tokens).toBe(2)
	})

	test('abgelaufene Codes und offene Zustimmungen werden gelöscht', () => {
		const id = client(jetzt)
		vi.setSystemTime((jetzt - 700) * 1000)
		createAuthCode(
			{
				client_id: id,
				user_id: 'sub-1',
				code_challenge: 'c',
				redirect_uri: 'https://claude.ai/cb',
			},
			db,
		)
		createPendingAuthorization(
			{
				client_id: id,
				redirect_uri: 'https://claude.ai/cb',
				code_challenge: 'c',
			},
			db,
		)
		vi.setSystemTime(jetzt * 1000)
		expect(raeumeOAuthAuf(db, jetzt)).toMatchObject({ codes: 1, pending: 1 })
	})
})
