import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
	activeAuthSession,
	createAuthSession,
	deleteAuthSession,
	type NewAuthSession,
	purgeAuthSessions,
	updateAuthSession,
} from '../../src/lib/db/authSessions.ts'
import {
	issueTokens,
	registerClient,
	verifyAccessToken,
} from '../../src/lib/db/oauth.ts'
import {
	applyLogout,
	handleZitadelEvent,
	revokeUser,
} from '../../src/server/auth/revocation.ts'
import { createTestDb } from '../helpers/db.ts'

let db: Database

const jetzt = () => Math.floor(Date.now() / 1000)

const sitzung = (teile: Partial<NewAuthSession> = {}) =>
	createAuthSession(
		{
			sub: 'u-anna',
			sid: 'sid-1',
			email: 'anna@example.org',
			name: 'Anna',
			roles: ['mitglied'],
			refreshToken: 'rt-1',
			accessExpiresAt: jetzt() + 300,
			expiresAt: jetzt() + 3600,
			...teile,
		},
		db,
	)

beforeEach(() => {
	db = createTestDb()
})

afterEach(() => {
	db.close()
})

describe('serverseitige Sitzungen', () => {
	test('der Keks traegt nur einen Griff; in der Tabelle steht sein Hash', () => {
		const { handle, session } = sitzung()
		expect(session.id).not.toBe(handle)
		expect(activeAuthSession(handle, db)?.sub).toBe('u-anna')
		const zeile = db.prepare('SELECT * FROM auth_sessions').get() as Record<
			string,
			unknown
		>
		expect(Object.values(zeile)).not.toContain(handle)
	})

	test('abgelaufen ist abgemeldet', () => {
		const { handle } = sitzung({ expiresAt: jetzt() - 1 })
		expect(activeAuthSession(handle, db)).toBeNull()
	})

	test('Logout loescht die Zeile', () => {
		const { handle, session } = sitzung()
		expect(deleteAuthSession(session.id, db)).toBe(true)
		expect(activeAuthSession(handle, db)).toBeNull()
		expect(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get()).toEqual(
			{
				n: 0,
			},
		)
	})

	test('eine widerrufene Sitzung laesst sich nicht wiederbeleben', () => {
		const { handle, session } = sitzung()
		revokeUser('u-anna', db)
		expect(activeAuthSession(handle, db)).toBeNull()
		expect(
			updateAuthSession(
				session.id,
				{
					email: '',
					name: '',
					roles: ['admin'],
					refreshToken: 'rt-2',
					accessExpiresAt: jetzt() + 300,
				},
				db,
			),
		).toBe(false)
	})

	test('Aufraeumen entfernt Abgelaufenes, nicht Laufendes', () => {
		sitzung({ expiresAt: jetzt() - 10 })
		const { handle } = sitzung()
		expect(purgeAuthSessions(db)).toBe(1)
		expect(activeAuthSession(handle, db)).not.toBeNull()
	})
})

describe('Widerruf', () => {
	test('per sid trifft genau die eine Sitzung', () => {
		const eins = sitzung({ sid: 'sid-1' })
		const zwei = sitzung({ sid: 'sid-2' })
		expect(applyLogout({ sub: 'u-anna', sid: 'sid-1' }, db)).toBe(1)
		expect(activeAuthSession(eins.handle, db)).toBeNull()
		expect(activeAuthSession(zwei.handle, db)).not.toBeNull()
	})

	test('per sub trifft alle Sitzungen der Person, keine fremde', () => {
		const eins = sitzung({ sid: 'sid-1' })
		const zwei = sitzung({ sid: 'sid-2' })
		const fremd = sitzung({ sub: 'u-bert', sid: 'sid-3' })
		expect(applyLogout({ sub: 'u-anna', sid: null }, db)).toBe(2)
		expect(activeAuthSession(eins.handle, db)).toBeNull()
		expect(activeAuthSession(zwei.handle, db)).toBeNull()
		expect(activeAuthSession(fremd.handle, db)).not.toBeNull()
	})

	test('ein gesperrtes Konto verliert auch seine MCP-Tokens', () => {
		const { client } = registerClient(
			{ client_name: 'Test', redirect_uris: ['http://localhost/cb'] },
			db,
		)
		const tokens = issueTokens(
			{
				client_id: client.client_id,
				user_id: 'u-anna',
				roles: ['admin'],
				scopes: ['mcp'],
				resource: null,
			},
			db,
		)
		expect(verifyAccessToken(tokens.access_token, db)).toBeDefined()
		const ergebnis = handleZitadelEvent(
			{ event_type: 'user.locked', aggregateID: 'u-anna' },
			'proj-1',
			db,
		)
		expect(ergebnis).toMatchObject({ action: 'revoke_user', mcpTokens: 2 })
		expect(verifyAccessToken(tokens.access_token, db)).toBeUndefined()
	})
})

describe('ZITADEL-Ereignisse', () => {
	test.each([
		['user.locked', 'revoke_user'],
		['user.deactivated', 'revoke_user'],
		['user.removed', 'revoke_user'],
		['user.human.signed.out', 'revoke_sessions'],
		['user.token.removed', 'revoke_sessions'],
		['user.human.refresh.token.removed', 'revoke_sessions'],
	])('%s beendet alle Sitzungen des Kontos', (eventType, action) => {
		const { handle } = sitzung()
		const fremd = sitzung({ sub: 'u-bert', sid: 'sid-9' })
		expect(
			handleZitadelEvent(
				{ event_type: eventType, aggregateID: 'u-anna' },
				'proj-1',
				db,
			),
		).toMatchObject({ action, sub: 'u-anna', sessions: 1 })
		expect(activeAuthSession(handle, db)).toBeNull()
		expect(activeAuthSession(fremd.handle, db)).not.toBeNull()
	})

	test.each([
		'oidc_session.access_token.revoked',
		'oidc_session.refresh_token.revoked',
	])('%s erzwingt die Verlaengerung aller Sitzungen', (eventType) => {
		const { handle } = sitzung()
		expect(
			handleZitadelEvent(
				{ event_type: eventType, aggregateID: 'V2_123' },
				'proj-1',
				db,
			),
		).toEqual({ action: 'refresh_all', sessions: 1 })
		expect(activeAuthSession(handle, db)?.accessExpiresAt).toBe(0)
	})

	test('ein entzogener Grant nimmt die userId aus der Nutzlast', () => {
		const { handle } = sitzung()
		expect(
			handleZitadelEvent(
				{
					eventType: 'user.grant.removed',
					aggregateID: 'grant-7',
					event_payload: { userId: 'u-anna', projectId: 'proj-1' },
				},
				'proj-1',
				db,
			),
		).toMatchObject({ action: 'revoke_user', sub: 'u-anna', sessions: 1 })
		expect(activeAuthSession(handle, db)).toBeNull()
	})

	test('ein Grant eines fremden Projekts aendert hier nichts', () => {
		const { handle } = sitzung()
		expect(
			handleZitadelEvent(
				{
					event_type: 'user.grant.removed',
					aggregateID: 'grant-8',
					event_payload: { userId: 'u-anna', projectId: 'proj-anders' },
				},
				'proj-1',
				db,
			).action,
		).toBe('ignored')
		expect(activeAuthSession(handle, db)).not.toBeNull()
	})

	test('ein deaktivierter Grant ohne userId erzwingt die Verlaengerung aller Sitzungen', () => {
		const { handle } = sitzung()
		expect(
			handleZitadelEvent(
				{ event_type: 'user.grant.deactivated', aggregateID: 'grant-9' },
				'proj-1',
				db,
			),
		).toEqual({ action: 'refresh_all', sessions: 1 })
		const danach = activeAuthSession(handle, db)
		expect(danach).not.toBeNull()
		expect(danach?.accessExpiresAt).toBe(0)
	})

	test('ein neuer Grant laesst die Rollen sofort neu lesen', () => {
		const { handle } = sitzung({ roles: [] })
		expect(
			handleZitadelEvent(
				{
					event_type: 'user.grant.added',
					aggregateID: 'grant-10',
					event_payload: { userId: 'u-anna', projectId: 'proj-1' },
				},
				'proj-1',
				db,
			),
		).toMatchObject({ action: 'refresh_user', sessions: 1 })
		expect(activeAuthSession(handle, db)?.accessExpiresAt).toBe(0)
	})

	test('eine beendete ZITADEL-Sitzung beendet alle Sitzungen ihres Kontos', () => {
		const eins = sitzung({ sid: 'sid-1' })
		const zwei = sitzung({ sid: 'sid-2' })
		const fremd = sitzung({ sub: 'u-bert', sid: 'sid-3' })
		expect(
			handleZitadelEvent(
				{ event_type: 'session.terminated', aggregateID: 'sid-1' },
				'proj-1',
				db,
			),
		).toEqual({ action: 'revoke_sessions', sub: 'u-anna', sessions: 2 })
		expect(activeAuthSession(eins.handle, db)).toBeNull()
		expect(activeAuthSession(zwei.handle, db)).toBeNull()
		expect(activeAuthSession(fremd.handle, db)).not.toBeNull()
	})

	test('eine fremde ZITADEL-Sitzung aendert nichts', () => {
		const { handle } = sitzung()
		expect(
			handleZitadelEvent(
				{ event_type: 'session.terminated', aggregateID: 'sid-unbekannt' },
				'proj-1',
				db,
			).action,
		).toBe('ignored')
		expect(activeAuthSession(handle, db)).not.toBeNull()
	})

	test('Unbekanntes wird ignoriert', () => {
		const { handle } = sitzung()
		expect(
			handleZitadelEvent(
				{ event_type: 'user.human.added', aggregateID: 'u-anna' },
				'proj-1',
				db,
			).action,
		).toBe('ignored')
		expect(activeAuthSession(handle, db)).not.toBeNull()
	})
})
