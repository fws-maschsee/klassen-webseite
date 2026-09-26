import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { resetGrantsConfig } from '../../src/server/auth/grants.ts'
import {
	AUTHORIZATIONS_PATH,
	authorizationsResponse,
} from '../helpers/authorizations.ts'
import { createTestDb } from '../helpers/db.ts'

const { accountCheckMode, berichtAlsText, hatBefund, obfuscate, pruefeKonten } =
	await import('../../src/lib/versand/kontopruefung.ts')

type Kandidat = { email: string; mitglied_id: string | null }

const kandidat = (r: Kandidat) => ({
	email: r.email,
	from_address_book: r.mitglied_id !== null,
})

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
}

describe('Konten-Pruefung vor dem Versand', () => {
	const original = { ...process.env }

	beforeEach(() => {
		db = createTestDb()
		process.env.ZITADEL_ISSUER = 'https://id.example.org'
		process.env.ZITADEL_ORG_ID = 'org-1'
		process.env.ZITADEL_PROJECT_ID = 'proj-1'
		process.env.ZITADEL_SERVICE_TOKEN = 'tok'
		resetGrantsConfig()
	})

	afterEach(() => {
		process.env = { ...original }
		resetGrantsConfig()
		vi.restoreAllMocks()
		db.close()
	})

	describe('Betriebsart', () => {
		test('ohne Einstellung gilt "report" — nichts wird geschnitten', () => {
			process.env.LIST_ACCOUNT_CHECK = undefined
			delete process.env.LIST_ACCOUNT_CHECK
			expect(accountCheckMode()).toBe('report')
		})

		test('"enforce" wird gelesen', () => {
			process.env.LIST_ACCOUNT_CHECK = 'ENFORCE'
			expect(accountCheckMode()).toBe('enforce')
		})

		test('ein Tippfehler faellt auf "report" zurueck und nicht auf "enforce"', () => {
			process.env.LIST_ACCOUNT_CHECK = 'enforc'
			const warnung = vi.spyOn(console, 'warn').mockImplementation(() => {})
			expect(accountCheckMode()).toBe('report')
			expect(warnung).toHaveBeenCalled()
		})
	})

	describe('Wer bleibt und wer faellt', () => {
		test('Konto mit Rolle bleibt, ohne Rolle faellt — ueber die Adresse verbunden', async () => {
			mitglied('anna', 'anna@example.org')
			mitglied('bert', 'bert@example.org')
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

			const ergebnis = await pruefeKonten(
				[
					{ email: 'anna@example.org', mitglied_id: 'anna' },
					{ email: 'bert@example.org', mitglied_id: 'bert' },
				],
				kandidat,
				{ db, mode: 'enforce', occasion: 'Test' },
			)

			expect(ergebnis.recipients.map((r) => r.email)).toEqual([
				'anna@example.org',
			])
			expect(ergebnis.cut).toEqual([
				{
					recipient: { email: 'bert@example.org', mitglied_id: 'bert' },
					reason: 'no_role',
				},
			])
		})

		test('`user_sub` schlaegt die Adresse — eine Adressaenderung wirft niemanden raus', async () => {
			mitglied('clara', 'clara-neu@example.org', 'u-clara')
			vi.stubGlobal(
				'fetch',
				zitadelAntwortet([
					{
						userId: 'u-clara',
						email: 'clara-alt@example.org',
						roleKeys: ['mitglied'],
					},
				]),
			)

			const ergebnis = await pruefeKonten(
				[{ email: 'clara-neu@example.org', mitglied_id: 'clara' }],
				kandidat,
				{ db, mode: 'enforce', occasion: 'Test' },
			)
			expect(ergebnis.cut).toEqual([])
			expect(ergebnis.recipients).toHaveLength(1)
		})

		test('`admin` allein genuegt — wer verwalten darf, bekommt auch Post', async () => {
			mitglied('dora', 'dora@example.org')
			vi.stubGlobal(
				'fetch',
				zitadelAntwortet([
					{ userId: 'u-dora', email: 'dora@example.org', roleKeys: ['admin'] },
				]),
			)
			const ergebnis = await pruefeKonten(
				[{ email: 'dora@example.org', mitglied_id: 'dora' }],
				kandidat,
				{ db, mode: 'enforce', occasion: 'Test' },
			)
			expect(ergebnis.cut).toEqual([])
		})

		test('ohne Grant in diesem Projekt heisst es immer `no_role` — mehr sieht der Dienstzugang nicht', async () => {
			mitglied('emil', 'emil@example.org', 'u-emil')
			mitglied('frida', 'frida@example.org')
			const fetchMock = zitadelAntwortet([])
			vi.stubGlobal('fetch', fetchMock)
			const ergebnis = await pruefeKonten(
				[
					{ email: 'emil@example.org', mitglied_id: 'emil' },
					{ email: 'frida@example.org', mitglied_id: 'frida' },
				],
				kandidat,
				{ db, mode: 'enforce', occasion: 'Test' },
			)
			expect(ergebnis.cut.map((c) => c.reason)).toEqual(['no_role', 'no_role'])
			expect(fetchMock).toHaveBeenCalledOnce()
			for (const [url] of fetchMock.mock.calls) {
				expect(String(url)).not.toContain('/management/v1/users/_search')
			}
		})
	})

	describe('extra_recipients', () => {
		test('Einzeladressen ohne Adressbuch-Eintrag passieren die Pruefung', async () => {
			mitglied('gustav', 'gustav@example.org')
			vi.stubGlobal('fetch', zitadelAntwortet([]))

			const ergebnis = await pruefeKonten(
				[
					{ email: 'gustav@example.org', mitglied_id: 'gustav' },
					{ email: 'sekretariat@example.org', mitglied_id: null },
				],
				kandidat,
				{ db, mode: 'enforce', occasion: 'Test' },
			)

			expect(ergebnis.recipients.map((r) => r.email)).toEqual([
				'sekretariat@example.org',
			])
			expect(ergebnis.report.extra_recipients).toBe(1)
			expect(ergebnis.report.checked).toBe(1)
		})
	})

	describe('report gegen enforce', () => {
		const lage = async (mode: 'report' | 'enforce') => {
			mitglied('hans', 'hans@example.org')
			vi.stubGlobal('fetch', zitadelAntwortet([]))
			return pruefeKonten(
				[{ email: 'hans@example.org', mitglied_id: 'hans' }],
				kandidat,
				{ db, mode, occasion: 'Liste eltern' },
			)
		}

		test('report schneidet NICHTS, meldet aber, wen es treffen wuerde', async () => {
			const ergebnis = await lage('report')
			expect(ergebnis.recipients).toHaveLength(1)
			expect(ergebnis.report.kept).toBe(1)
			expect(ergebnis.report.cut).toEqual([
				{ email: 'h***@***mple.org', reason: 'no_role' },
			])
		})

		test('enforce schneidet — und meldet dasselbe', async () => {
			const ergebnis = await lage('enforce')
			expect(ergebnis.recipients).toHaveLength(0)
			expect(ergebnis.report.kept).toBe(0)
			expect(ergebnis.report.cut).toEqual([
				{ email: 'h***@***mple.org', reason: 'no_role' },
			])
		})

		test('im Bericht steht keine vollstaendige Adresse', async () => {
			const ergebnis = await lage('enforce')
			const text =
				JSON.stringify(ergebnis.report) + berichtAlsText(ergebnis.report)
			expect(text).not.toContain('hans@example.org')
		})
	})

	describe('die andere Richtung', () => {
		test('Konten mit Rolle ohne Adressbuch-Eintrag werden gemeldet', async () => {
			mitglied('ida', 'ida@example.org')
			vi.stubGlobal(
				'fetch',
				zitadelAntwortet([
					{ userId: 'u-ida', email: 'ida@example.org', roleKeys: ['mitglied'] },
					{ userId: 'u-neu', email: 'neu@example.org', roleKeys: ['mitglied'] },
				]),
			)

			const ergebnis = await pruefeKonten(
				[{ email: 'ida@example.org', mitglied_id: 'ida' }],
				kandidat,
				{ db, mode: 'report', occasion: 'Test' },
			)

			expect(ergebnis.report.accounts_without_entry).toEqual([
				'n***@***mple.org',
			])
		})
	})

	describe('ZITADEL gestoert', () => {
		const stoerung = () =>
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => {
					throw new Error('ECONNREFUSED')
				}),
			)

		test('in report wird trotzdem verschickt, die Pruefung ist blind', async () => {
			mitglied('jens', 'jens@example.org')
			stoerung()
			vi.spyOn(console, 'warn').mockImplementation(() => {})

			const ergebnis = await pruefeKonten(
				[{ email: 'jens@example.org', mitglied_id: 'jens' }],
				kandidat,
				{ db, mode: 'report', occasion: 'Test' },
			)

			expect(ergebnis.recipients).toHaveLength(1)
			expect(ergebnis.cut).toEqual([])
			expect(ergebnis.report.unavailable).toContain('ECONNREFUSED')
		})

		test('in enforce wird geworfen — lieber keine Mail als eine an Fremde', async () => {
			mitglied('kai', 'kai@example.org')
			stoerung()
			await expect(
				pruefeKonten(
					[{ email: 'kai@example.org', mitglied_id: 'kai' }],
					kandidat,
					{ db, mode: 'enforce', occasion: 'Test' },
				),
			).rejects.toThrow(/nicht erreichbar/)
		})

		test('fehlende Konfiguration ist in enforce ebenfalls ein Stopp', async () => {
			mitglied('lena', 'lena@example.org')
			process.env.ZITADEL_SERVICE_TOKEN = ''
			resetGrantsConfig()
			await expect(
				pruefeKonten(
					[{ email: 'lena@example.org', mitglied_id: 'lena' }],
					kandidat,
					{ db, mode: 'enforce', occasion: 'Test' },
				),
			).rejects.toThrow(/nicht verfuegbar/)
		})
	})

	describe('Sparsamkeit', () => {
		test('EIN Aufruf je Versand, nicht einer je Empfaenger', async () => {
			for (const name of ['m1', 'm2', 'm3', 'm4', 'm5']) {
				mitglied(name, `${name}@example.org`)
			}
			const fetchMock = zitadelAntwortet(
				['m1', 'm2', 'm3', 'm4', 'm5'].map((n) => ({
					userId: `u-${n}`,
					email: `${n}@example.org`,
					roleKeys: ['mitglied'],
				})),
			)
			vi.stubGlobal('fetch', fetchMock)

			await pruefeKonten(
				['m1', 'm2', 'm3', 'm4', 'm5'].map((n) => ({
					email: `${n}@example.org`,
					mitglied_id: n,
				})),
				kandidat,
				{ db, mode: 'enforce', occasion: 'Test' },
			)
			expect(fetchMock).toHaveBeenCalledTimes(1)
		})
	})

	describe('Obfuskierung', () => {
		test('erkennbar, aber nicht abschreibbar', () => {
			expect(obfuscate('post@levinkeller.de')).toBe('p***@***eller.de')
			expect(obfuscate('  Anna@Example.ORG ')).toBe('a***@***mple.org')
			expect(obfuscate('')).toBe('(leer)')
		})
	})
})

describe('Meldung nur bei Befund', () => {
	const bericht = (
		teile: Partial<Parameters<typeof hatBefund>[0]>,
	): Parameters<typeof hatBefund>[0] => ({
		mode: 'enforce',
		occasion: 'Test',
		checked: 3,
		kept: 3,
		cut: [],
		extra_recipients: 0,
		accounts_without_entry: [],
		unavailable: null,
		...teile,
	})

	test('saubere Lage: kein Befund', () => {
		expect(hatBefund(bericht({}))).toBe(false)
	})

	test('jemand wurde uebergangen: Befund', () => {
		expect(
			hatBefund(
				bericht({ cut: [{ email: 'a***@***mple.org', reason: 'no_role' }] }),
			),
		).toBe(true)
	})

	test('jemandem fehlt der Adressbuch-Eintrag: Befund', () => {
		expect(
			hatBefund(bericht({ accounts_without_entry: ['n***@***mple.org'] })),
		).toBe(true)
	})

	test('eine blinde Pruefung ist KEIN Befund', () => {
		expect(hatBefund(bericht({ unavailable: 'ECONNREFUSED' }))).toBe(false)
	})
})
