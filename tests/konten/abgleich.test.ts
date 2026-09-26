import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
	abgleichAlsText,
	abgleichen,
	hatAbweichungen,
} from '../../src/lib/konten/abgleich.ts'
import { resetGrantsConfig } from '../../src/server/auth/grants.ts'
import {
	AUTHORIZATIONS_PATH,
	authorizationsResponse,
} from '../helpers/authorizations.ts'
import { createTestDb } from '../helpers/db.ts'

const zitadelAntwortet = (
	grants: { userId: string; email?: string; roleKeys: string[] }[],
): ReturnType<typeof vi.fn> =>
	vi.fn(async (url: string) => {
		if (!String(url).includes(AUTHORIZATIONS_PATH)) {
			return new Response('unerwartet', { status: 500 })
		}
		return authorizationsResponse(grants)
	})

let db: Database

const mitglied = (
	id: string,
	email: string | null,
	sub: string | null = null,
	gruppen: string[] = [],
): void => {
	db.prepare(
		'INSERT INTO mitglieder (id, first_name, last_name, email) VALUES (?, ?, ?, ?)',
	).run(id, id, 'Beispiel', email)
	if (sub) {
		db.prepare(
			'INSERT INTO users (sub, login_email, name) VALUES (?, ?, ?)',
		).run(sub, email ?? '', id)
		db.prepare('UPDATE mitglieder SET user_sub = ? WHERE id = ?').run(sub, id)
	}
	for (const gruppe of gruppen) {
		db.prepare('INSERT OR IGNORE INTO groups (key, label) VALUES (?, ?)').run(
			gruppe,
			gruppe,
		)
		db.prepare(
			'INSERT INTO group_memberships (mitglied_id, group_key) VALUES (?, ?)',
		).run(id, gruppe)
	}
}

describe('Der Abgleich', () => {
	const original = { ...process.env }

	beforeEach(() => {
		db = createTestDb()
		process.env.ZITADEL_ISSUER = 'https://id.example.org'
		process.env.ZITADEL_ORG_ID = 'org-1'
		process.env.ZITADEL_PROJECT_ID = 'proj-1'
		process.env.ZITADEL_SERVICE_TOKEN = 'tok'
		resetGrantsConfig()
		vi.spyOn(console, 'log').mockImplementation(() => {})
	})

	afterEach(() => {
		process.env = { ...original }
		resetGrantsConfig()
		vi.restoreAllMocks()
		db.close()
	})

	test('deckt sich alles, meldet er nichts', async () => {
		mitglied('anna', 'anna@example.org', null, ['eltern'])
		vi.stubGlobal(
			'fetch',
			zitadelAntwortet([
				{ userId: 'u-anna', email: 'anna@example.org', roleKeys: ['mitglied'] },
			]),
		)

		const bericht = await abgleichen({ db })

		expect(bericht.entries).toBe(1)
		expect(bericht.entries_with_account).toBe(1)
		expect(bericht.entries_without_account).toEqual([])
		expect(bericht.accounts_without_entry).toEqual([])
		expect(abgleichAlsText(bericht)).toContain('Keine Abweichung.')
		expect(hatAbweichungen(bericht)).toBe(false)
	})

	test('meldet einen Eintrag ohne Konto — mit Grund und Gruppen', async () => {
		mitglied('anna', 'anna@example.org', null, ['eltern'])
		mitglied('bert', 'bert@example.org', null, ['eltern'])
		vi.stubGlobal(
			'fetch',
			zitadelAntwortet([
				{
					userId: 'u-anna',
					email: 'anna@example.org',
					roleKeys: ['mitglied'],
				},
			]),
		)

		const bericht = await abgleichen({ db })

		expect(bericht.entries_without_account).toEqual([
			{
				mitglied_id: 'bert',
				name: 'bert Beispiel',
				email: 'bert@example.org',
				user_sub: null,
				groups: ['eltern'],
				reason: 'no_role',
			},
		])
		expect(bericht.entries_with_account).toBe(1)
		expect(hatAbweichungen(bericht)).toBe(true)
	})

	test('ohne Grant in diesem Projekt heisst der Grund immer no_role', async () => {
		mitglied('carla', 'carla@example.org', 'u-carla')
		mitglied('dora', 'dora@example.org', 'u-dora')
		vi.stubGlobal('fetch', zitadelAntwortet([]))

		const bericht = await abgleichen({ db })

		expect(
			bericht.entries_without_account.map((e) => [e.mitglied_id, e.reason]),
		).toEqual([
			['carla', 'no_role'],
			['dora', 'no_role'],
		])
	})

	test('meldet ein Konto mit Rolle ohne Adressbuch-Eintrag — im Klartext', async () => {
		mitglied('anna', 'anna@example.org')
		vi.stubGlobal(
			'fetch',
			zitadelAntwortet([
				{ userId: 'u-anna', email: 'anna@example.org', roleKeys: ['mitglied'] },
				{ userId: 'u-emil', email: 'emil@example.org', roleKeys: ['admin'] },
			]),
		)

		const bericht = await abgleichen({ db })

		expect(bericht.accounts_without_entry).toEqual([
			{ user_id: 'u-emil', email: 'emil@example.org', roles: ['admin'] },
		])
		expect(hatAbweichungen(bericht)).toBe(true)
		expect(abgleichAlsText(bericht)).toContain('emil@example.org')
	})

	test('ein Konto ohne Leserolle zaehlt nicht als „gehoert dazu"', async () => {
		mitglied('anna', 'anna@example.org')
		vi.stubGlobal(
			'fetch',
			zitadelAntwortet([
				{ userId: 'u-anna', email: 'anna@example.org', roleKeys: ['mitglied'] },
				{ userId: 'u-gast', email: 'gast@example.org', roleKeys: ['gast'] },
			]),
		)

		const bericht = await abgleichen({ db })

		expect(bericht.accounts_without_entry).toEqual([])
	})

	test('bei einer Stoerung kommt ein FEHLER und nicht „alle fehlen"', async () => {
		mitglied('anna', 'anna@example.org', null, ['eltern'])
		mitglied('bert', 'bert@example.org', null, ['eltern'])
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('kaputt', { status: 503 })),
		)

		await expect(abgleichen({ db })).rejects.toThrow(/ZITADEL/)
	})

	test('fehlt die Konfiguration, kommt ebenfalls ein Fehler', async () => {
		delete process.env.ZITADEL_SERVICE_TOKEN
		resetGrantsConfig()
		mitglied('anna', 'anna@example.org')

		await expect(abgleichen({ db })).rejects.toThrow(
			/nicht verfuegbar.*ZITADEL_SERVICE_KEY/,
		)
	})
})
