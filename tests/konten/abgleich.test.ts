import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
	abgleichAlsText,
	abgleichen,
	hatAbweichungen,
} from '../../src/lib/konten/abgleich.ts'
import { resetGrantsConfig } from '../../src/server/auth/grants.ts'
import { createTestDb } from '../helpers/db.ts'

/**
 * Der Abgleich — die Regel gegen Attrappen.
 *
 * Was hier NICHT geprueft wird: ob ZITADEL wirklich so antwortet. Das kann nur
 * ein echtes ZITADEL beweisen und steht in `tests/integration/abgleich.test.ts`.
 * Hier steht, was der Abgleich aus einer Antwort MACHT — und vor allem, was er
 * bei einer STOERUNG macht, denn das ist die Stelle, an der ein Abgleich
 * gefaehrlich wird: „ZITADEL antwortet nicht" darf nie wie „alle ausgetreten"
 * aussehen.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

/** Antwort auf `/users/grants/_search` bzw. `/users/_search`. */
const zitadelAntwortet = (
	grants: { userId: string; email?: string; roleKeys: string[] }[],
	konten: { id: string; email: string }[] = [],
): ReturnType<typeof vi.fn> =>
	vi.fn(async (url: string) => {
		if (String(url).includes('/users/grants/_search')) {
			return new Response(
				JSON.stringify({
					result: grants.map((g) => ({
						userId: g.userId,
						email: g.email,
						roleKeys: g.roleKeys,
						state: 'USER_GRANT_STATE_ACTIVE',
					})),
				}),
				{ status: 200 },
			)
		}
		return new Response(
			JSON.stringify({
				result: konten.map((k) => ({
					id: k.id,
					human: { email: { email: k.email } },
				})),
			}),
			{ status: 200 },
		)
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
		// GEFRAGT wird immer geantwortet — auch beruhigend.
		expect(abgleichAlsText(bericht)).toContain('Keine Abweichung.')
		// VON SELBST wird geschwiegen. „das will ich nicht andauernd bekommen.
		// ich will nur fehler sehen." (Levin, 15.08.) Wer einen regelmaessigen
		// Lauf oder eine Benachrichtigung baut, fragt das hier VOR dem
		// Verschicken — eine Mail mit lauter Nullen erzieht zum Wegklicken.
		expect(hatAbweichungen(bericht)).toBe(false)
	})

	test('meldet einen Eintrag ohne Konto — mit Grund und Gruppen', async () => {
		// Die eine Richtung: Diese Person bekommt nach dem Scharfschalten keine
		// Post mehr. Dass sie in einer Gruppe steht, ist der Unterschied zwischen
		// „faellt auf" und „faellt niemandem auf".
		mitglied('anna', 'anna@example.org', null, ['eltern'])
		mitglied('bert', 'bert@example.org', null, ['eltern'])
		vi.stubGlobal(
			'fetch',
			zitadelAntwortet(
				[
					{
						userId: 'u-anna',
						email: 'anna@example.org',
						roleKeys: ['mitglied'],
					},
				],
				// Bert hat ueberhaupt kein Konto.
				[{ id: 'u-anna', email: 'anna@example.org' }],
			),
		)

		const bericht = await abgleichen({ db })

		expect(bericht.entries_without_account).toEqual([
			{
				mitglied_id: 'bert',
				name: 'bert Beispiel',
				email: 'bert@example.org',
				user_sub: null,
				groups: ['eltern'],
				reason: 'no_account',
			},
		])
		expect(bericht.entries_with_account).toBe(1)
		expect(hatAbweichungen(bericht)).toBe(true)
	})

	test('unterscheidet entzogene Rolle von geloeschtem Konto', async () => {
		// Zwei verschiedene Handgriffe fuer den Menschen, der den Bericht liest:
		// Grant wieder erteilen oder den Eintrag wegraeumen. Der entzogene Grant
		// ist dabei der Fall, den ein Webhook NIE gemeldet haette — er loest kein
		// Ereignis aus.
		mitglied('carla', 'carla@example.org', 'u-carla')
		mitglied('dora', 'dora@example.org', 'u-dora')
		vi.stubGlobal(
			'fetch',
			zitadelAntwortet(
				[],
				// Carlas Konto gibt es noch (nur ohne Grant), Doras nicht mehr.
				[{ id: 'u-carla', email: 'carla@example.org' }],
			),
		)

		const bericht = await abgleichen({ db })

		expect(
			bericht.entries_without_account.map((e) => [e.mitglied_id, e.reason]),
		).toEqual([
			['carla', 'role_missing'],
			['dora', 'account_unknown'],
		])
	})

	test('meldet ein Konto mit Rolle ohne Adressbuch-Eintrag — im Klartext', async () => {
		// Die andere Richtung. Sie faellt in keiner Zustellung auf, weil dort
		// niemand fehlt, den man vermissen koennte. Die Adresse steht hier
		// UNOBFUSKIERT: Wer den Fehler abstellen soll, muss die Person einladen
		// oder eintragen koennen.
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
		// Auch die Gegenrichtung allein ist ein Anlass.
		expect(hatAbweichungen(bericht)).toBe(true)
		expect(abgleichAlsText(bericht)).toContain('emil@example.org')
	})

	test('ein Konto ohne Leserolle zaehlt nicht als „gehoert dazu"', async () => {
		// Ein Grant im Projekt, aber mit einer Rolle, die keinen Zugang gibt.
		// Wuerde er hier zaehlen, meldete der Abgleich einen fehlenden Eintrag
		// fuer jemanden, der gar nicht hereinkommt.
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
		// Der wichtigste Test dieser Datei. Ein Abgleich, der eine Stoerung als
		// leere Grant-Menge ausgibt, meldet den ganzen Verteiler als ausgetreten —
		// und wer daraufhin aufraeumt, loescht ihn.
		mitglied('anna', 'anna@example.org', null, ['eltern'])
		mitglied('bert', 'bert@example.org', null, ['eltern'])
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('kaputt', { status: 503 })),
		)

		await expect(abgleichen({ db })).rejects.toThrow(/ZITADEL/)
	})

	test('fehlt die Konfiguration, kommt ebenfalls ein Fehler', async () => {
		// Dieselbe Ueberlegung: Ohne Zugangsdaten weiss der Abgleich nichts. Ein
		// Bericht, der dann „niemand hat ein Konto" sagt, waere eine Luege mit
		// Handlungsanweisung.
		delete process.env.ZITADEL_SERVICE_TOKEN
		resetGrantsConfig()
		mitglied('anna', 'anna@example.org')

		await expect(abgleichen({ db })).rejects.toThrow(
			/nicht konfiguriert|ZITADEL_SERVICE_TOKEN/,
		)
	})
})
