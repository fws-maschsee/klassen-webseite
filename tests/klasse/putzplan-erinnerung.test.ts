import type { Database } from 'better-sqlite3'
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from 'vitest'
import {
	defineKlassenConfig,
	setKlassenConfig,
} from '../../src/klasse/config.ts'
import type {
	FamilienEmpfaenger,
	PutzplanQuelle,
	PutzTermin,
} from '../../src/klasse/putzplanErinnerung.ts'
import {
	baueErinnerungstext,
	istFaellig,
	sendeFaelligeErinnerung,
	sendezeitFuer,
} from '../../src/klasse/putzplanErinnerung.ts'
import { upsertGroup } from '../../src/lib/db/groups.ts'
import { upsertMitglied } from '../../src/lib/db/members.ts'
import { erinnerungZuTermin } from '../../src/lib/db/putzplanReminders.ts'
import { suppressAddress } from '../../src/lib/db/suppressions.ts'
import type { SendInput } from '../../src/lib/email/transport.ts'
import { resetGrantsConfig } from '../../src/server/auth/grants.ts'
import { createTestDb } from '../helpers/db.ts'
import { TESTKLASSE } from '../setup.ts'

const KLASSE = defineKlassenConfig({
	...TESTKLASSE,
	contactName: 'Ludwig Muster',
})

const FREITAG = new Date('2026-08-21T00:00:00.000Z')
const SONNTAG_17_UHR = new Date('2026-08-16T15:00:00.000Z')
const SONNTAG_16_59_UHR = new Date('2026-08-16T14:59:00.000Z')
const SAMSTAG_DAVOR = new Date('2026-08-15T18:00:00.000Z')
const DIENSTAG_DANACH = new Date('2026-08-18T07:00:00.000Z')
const FREITAG_FRUEH = new Date('2026-08-21T04:00:00.000Z')

test('die Testdaten liegen auf den Wochentagen, die sie behaupten', () => {
	expect(FREITAG.getUTCDay()).toBe(5)
	expect(SONNTAG_17_UHR.getUTCDay()).toBe(0)
	expect(SAMSTAG_DAVOR.getUTCDay()).toBe(6)
	expect(DIENSTAG_DANACH.getUTCDay()).toBe(2)
})

let db: Database
let sent: SendInput[]
let scheitert: Set<string>
let termine: PutzTermin[]
let familien: Record<string, FamilienEmpfaenger[]>

const EIN_TAG_MS = 24 * 60 * 60 * 1000

const quelle: PutzplanQuelle = {
	naechsterPutztermin: (ab) =>
		[...termine]
			.sort((a, b) => a.datum.getTime() - b.datum.getTime())
			.find((t) => t.datum.getTime() + EIN_TAG_MS > ab.getTime()) ?? null,
	familienEmpfaenger: (groupKey) => familien[groupKey] ?? [],
}

const transport = {
	send: async (input: SendInput) => {
		if (scheitert.has(input.to)) throw new Error('Postfach nicht erreichbar')
		sent.push(input)
		return { messageId: `<${sent.length}@example.org>` }
	},
}

const nachsehen = (jetzt: Date) => {
	vi.setSystemTime(jetzt)
	return sendeFaelligeErinnerung({ quelle, db, transport })
}

const anFamilien = () =>
	sent
		.filter(
			(m) =>
				m.to !== KLASSE.contactMail &&
				m.to !== (process.env.REMINDER_RECEIPT_TO ?? '').trim(),
		)
		.map((m) => m.to)

const anBetrieb = () => sent.filter((m) => m.to === KLASSE.contactMail)

beforeEach(() => {
	setKlassenConfig(KLASSE)
	vi.useFakeTimers()
	db = createTestDb()
	sent = []
	scheitert = new Set()
	delete process.env.REMINDER_RECEIPT_TO
	termine = [{ datum: FREITAG, gruppen: ['probst-vogel', 'sonnenschein'] }]
	familien = {
		'probst-vogel': [
			{ email: 'anke@example.org', name: 'Anke Probst' },
			{ email: 'jens@example.org', name: 'Jens Vogel' },
		],
		sonnenschein: [{ email: 'mira@example.org', name: 'Mira Sonnenschein' }],
	}
	upsertGroup({ key: 'probst-vogel', label: 'Familie Probst/Vogel' }, db)
	upsertGroup({ key: 'sonnenschein', label: 'Sonnenschein' }, db)
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	delete process.env.LIST_ACCOUNT_CHECK
	delete process.env.ZITADEL_ISSUER
	delete process.env.ZITADEL_ORG_ID
	delete process.env.ZITADEL_PROJECT_ID
	delete process.env.ZITADEL_SERVICE_TOKEN
	resetGrantsConfig()
	db.close()
})

afterAll(() => {
	setKlassenConfig(TESTKLASSE)
})

describe('Fälligkeit', () => {
	test('Sendezeitpunkt ist der Sonntag davor um 17 Uhr Ortszeit', () => {
		expect(sendezeitFuer(FREITAG).toISOString()).toBe(
			'2026-08-16T15:00:00.000Z',
		)
	})

	test('im Winter dieselbe Wanduhrzeit, eine andere UTC-Stunde', () => {
		const winter = sendezeitFuer(new Date('2026-12-04T00:00:00.000Z'))
		expect(winter.toISOString()).toBe('2026-11-29T16:00:00.000Z')
		expect(winter.getUTCHours()).not.toBe(sendezeitFuer(FREITAG).getUTCHours())
	})

	test('ein vorgezogener Donnerstagstermin nimmt denselben Sonntag', () => {
		expect(
			sendezeitFuer(new Date('2026-10-01T00:00:00.000Z')).toISOString(),
		).toBe('2026-09-27T15:00:00.000Z')
	})

	test('das Fenster reicht von Sonntag 17 Uhr bis zum Anbruch des Termintages', () => {
		expect(istFaellig(FREITAG, SONNTAG_16_59_UHR)).toBe(false)
		expect(istFaellig(FREITAG, SONNTAG_17_UHR)).toBe(true)
		expect(istFaellig(FREITAG, DIENSTAG_DANACH)).toBe(true)
		expect(istFaellig(FREITAG, FREITAG_FRUEH)).toBe(false)
	})
})

describe('Versand', () => {
	test('sonntags nach 17 Uhr an alle Mitglieder der eingeteilten Familien', async () => {
		const ergebnis = await nachsehen(SONNTAG_17_UHR)

		expect(ergebnis).toMatchObject({
			kind: 'sent',
			terminDate: '2026-08-21',
			recipients: 3,
			unreached: [],
		})
		expect(anFamilien().sort()).toEqual([
			'anke@example.org',
			'jens@example.org',
			'mira@example.org',
		])
		expect(anBetrieb()).toHaveLength(0)

		const mail = sent[0] as SendInput
		expect(mail.subject).toBe(
			'Putzen am Freitag, 21.08. — Probst/Vogel und Sonnenschein',
		)
		expect(mail.text).toContain('    Familie Probst/Vogel')
		expect(mail.text).toContain('    Familie Sonnenschein')
		expect(mail.text).toContain('am kommenden Freitag, dem 21. August')
	})

	test('davor nicht — weder samstags noch um 16:59 Uhr', async () => {
		expect(await nachsehen(SAMSTAG_DAVOR)).toEqual({
			kind: 'not_due',
			terminDate: '2026-08-21',
		})
		expect(await nachsehen(SONNTAG_16_59_UHR)).toEqual({
			kind: 'not_due',
			terminDate: '2026-08-21',
		})
		expect(sent).toHaveLength(0)
		expect(erinnerungZuTermin('2026-08-21', db)).toBeUndefined()
	})

	test('genau einmal, auch wenn zehnmal nachgesehen wird', async () => {
		await nachsehen(SONNTAG_17_UHR)
		for (let i = 1; i <= 9; i++) {
			const ergebnis = await nachsehen(
				new Date(SONNTAG_17_UHR.getTime() + i * 10 * 60_000),
			)
			expect(ergebnis).toEqual({
				kind: 'already_sent',
				terminDate: '2026-08-21',
			})
		}
		expect(anFamilien()).toHaveLength(3)
		expect(erinnerungZuTermin('2026-08-21', db)?.recipient_count).toBe(3)
	})

	test('nach einem Neustart nicht noch einmal', async () => {
		await nachsehen(SONNTAG_17_UHR)
		expect(await nachsehen(DIENSTAG_DANACH)).toEqual({
			kind: 'already_sent',
			terminDate: '2026-08-21',
		})
		expect(anFamilien()).toHaveLength(3)
	})

	test('holt einen verpassten Sonntag nach', async () => {
		const ergebnis = await nachsehen(DIENSTAG_DANACH)
		expect(ergebnis).toMatchObject({ kind: 'sent', recipients: 3 })
		expect((sent[0] as SendInput).text).toContain('am kommenden Freitag')
	})

	test('am Termintag selbst nicht mehr', async () => {
		expect(await nachsehen(FREITAG_FRUEH)).toEqual({
			kind: 'not_due',
			terminDate: '2026-08-21',
		})
		expect(sent).toHaveLength(0)
	})

	test('kein Termin, kein Versand', async () => {
		termine = []
		expect(await nachsehen(SONNTAG_17_UHR)).toEqual({ kind: 'no_termin' })
		expect(sent).toHaveLength(0)
	})
})

describe('Familie ohne erreichbare Adresse', () => {
	test('wird gemeldet, statt übergangen zu werden', async () => {
		familien.sonnenschein = []

		const ergebnis = await nachsehen(SONNTAG_17_UHR)

		expect(ergebnis).toMatchObject({
			kind: 'sent',
			recipients: 2,
			unreached: ['sonnenschein'],
		})

		expect(anFamilien().sort()).toEqual([
			'anke@example.org',
			'jens@example.org',
		])

		const meldung = anBetrieb()
		expect(meldung).toHaveLength(1)
		const text = (meldung[0] as SendInput).text
		expect(text).toContain('Familie Sonnenschein')
		expect(text).toContain('sonnenschein')
		expect(text).toContain('keine Adresse hinterlegt')
		expect((meldung[0] as SendInput).to).toBe(KLASSE.contactMail)
	})

	test('auch dann, wenn keine einzige Familie erreichbar ist', async () => {
		familien = {}

		const ergebnis = await nachsehen(SONNTAG_17_UHR)

		expect(ergebnis).toMatchObject({
			kind: 'sent',
			recipients: 0,
			unreached: ['probst-vogel', 'sonnenschein'],
		})
		expect(anFamilien()).toHaveLength(0)
		expect(anBetrieb()).toHaveLength(1)
	})

	test('ist alles in Ordnung, geht KEINE Meldung an den Betrieb', async () => {
		for (const [id, email] of [
			['anke', 'anke@example.org'],
			['jens', 'jens@example.org'],
			['mira', 'mira@example.org'],
		] as const) {
			upsertMitglied({ id, first_name: id, last_name: 'Beispiel', email }, db)
		}
		process.env.LIST_ACCOUNT_CHECK = 'report'
		process.env.ZITADEL_ISSUER = 'https://id.example.org'
		process.env.ZITADEL_ORG_ID = 'org-1'
		process.env.ZITADEL_PROJECT_ID = 'proj-1'
		process.env.ZITADEL_SERVICE_TOKEN = 'tok'
		resetGrantsConfig()
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							result: [
								'anke@example.org',
								'jens@example.org',
								'mira@example.org',
							].map((email, i) => ({
								userId: `u-${i}`,
								email,
								roleKeys: ['mitglied'],
								state: 'USER_GRANT_STATE_ACTIVE',
							})),
						}),
						{ status: 200 },
					),
			),
		)

		const ergebnis = await nachsehen(SONNTAG_17_UHR)

		expect(ergebnis).toMatchObject({ kind: 'sent', recipients: 3 })
		expect(anFamilien()).toHaveLength(3)
		expect(anBetrieb()).toHaveLength(0)
	})

	test('eine gesperrte Adresse zählt nicht als erreicht', async () => {
		suppressAddress(
			{ email: 'mira@example.org', reason: 'bounce', list_address: '*' },
			db,
		)

		const ergebnis = await nachsehen(SONNTAG_17_UHR)

		expect(ergebnis).toMatchObject({ unreached: ['sonnenschein'] })
		expect(anFamilien()).not.toContain('mira@example.org')
		expect((anBetrieb()[0] as SendInput).text).toContain('gesperrt')
	})
})

describe('Störungen beim Versand', () => {
	test('gescheiterte Einzeladressen werden gemeldet, der Rest geht raus', async () => {
		scheitert.add('jens@example.org')

		const ergebnis = await nachsehen(SONNTAG_17_UHR)

		expect(ergebnis).toMatchObject({
			kind: 'sent',
			recipients: 2,
			failed: ['jens@example.org'],
		})
		expect((anBetrieb()[0] as SendInput).text).toContain('jens@example.org')
	})

	test('kommt keine einzige Mail durch, wird der Termin zurückgestellt', async () => {
		scheitert = new Set([
			'anke@example.org',
			'jens@example.org',
			'mira@example.org',
		])

		expect(await nachsehen(SONNTAG_17_UHR)).toMatchObject({
			kind: 'retry_later',
			terminDate: '2026-08-21',
		})
		expect(erinnerungZuTermin('2026-08-21', db)).toBeUndefined()

		scheitert = new Set()
		expect(
			await nachsehen(new Date(SONNTAG_17_UHR.getTime() + 10 * 60_000)),
		).toMatchObject({ kind: 'sent', recipients: 3 })
	})
})

describe('Wortlaut', () => {
	test('Betreff und Rumpf nennen Termin, Familien, Wege und Zuständigkeit', () => {
		const { subject, text } = baueErinnerungstext(FREITAG, [
			'Probst/Vogel',
			'Sonnenschein',
		])

		expect(subject).toBe(
			'Putzen am Freitag, 21.08. — Probst/Vogel und Sonnenschein',
		)
		expect(text).toContain('Hallo,')
		expect(text).toContain(
			'am kommenden Freitag, dem 21. August, seid ihr mit dem Putzen dran:',
		)
		expect(text).toContain(`${KLASSE.siteUrl}/docs/putzen/checkliste`)
		expect(text).toContain(`${KLASSE.siteUrl}/docs/putzen/vorbereitung`)
		expect(text).toContain(`${KLASSE.siteUrl}/docs/putzen/putzplan`)
		expect(text).toContain(
			'sagt Ludwig Muster Bescheid (verwaltung@example.org)',
		)
	})

	test('ohne hinterlegten Namen bleibt die Adresse allein stehen', () => {
		setKlassenConfig(TESTKLASSE)
		const { text } = baueErinnerungstext(FREITAG, ['Sonnenschein'])
		expect(text).toContain('sagt unter verwaltung@example.org Bescheid')
		expect(text).not.toContain('undefined')
	})

	test('drei Familien werden mit Komma und „und" verbunden', () => {
		const { subject, text } = baueErinnerungstext(FREITAG, ['A', 'B/C', 'D'])
		expect(subject).toContain('A, B/C und D')
		expect(subject).not.toContain('A und B/C und D')
		for (const name of ['A', 'B/C', 'D']) {
			expect(text).toContain(`    Familie ${name}`)
		}
	})

	test('trägt Auto-Submitted, damit keine Abwesenheitsnotiz antwortet', async () => {
		await nachsehen(SONNTAG_17_UHR)
		for (const mail of sent) {
			expect(mail.headers?.['Auto-Submitted']).toBe('auto-generated')
		}
		expect((sent[0] as SendInput).replyTo).toBe(KLASSE.contactMail)
	})
})

describe('Quittung an den Betreiber', () => {
	const QUITTUNG_AN = 'betreiber@example.org'
	const quittungen = () => sent.filter((m) => m.to === QUITTUNG_AN)

	test('nach einem echten Versand kommt sie — mit Klasse, Termin und Familien', async () => {
		process.env.REMINDER_RECEIPT_TO = QUITTUNG_AN
		const ergebnis = await nachsehen(SONNTAG_17_UHR)

		expect(ergebnis.kind).toBe('sent')
		expect(quittungen()).toHaveLength(1)
		const quittung = quittungen()[0] as SendInput
		expect(quittung.subject).toContain(KLASSE.label)
		expect(quittung.subject).toContain('Probst/Vogel und Sonnenschein')
		expect(quittung.subject).toContain('21.08.')
		expect(quittung.text).toContain('Zugestellt: 3 Adresse(n)')
		expect(quittung.headers?.['Auto-Submitted']).toBe('auto-generated')

		expect(anFamilien().sort()).toEqual([
			'anke@example.org',
			'jens@example.org',
			'mira@example.org',
		])
	})

	test('ohne gesetzte Adresse gibt es keine', async () => {
		delete process.env.REMINDER_RECEIPT_TO
		await nachsehen(SONNTAG_17_UHR)
		expect(quittungen()).toHaveLength(0)
	})

	test('eine leere Adresse zaehlt wie keine', async () => {
		process.env.REMINDER_RECEIPT_TO = '   '
		await nachsehen(SONNTAG_17_UHR)
		expect(quittungen()).toHaveLength(0)
	})

	test('kein Termin faellig -> keine Quittung', async () => {
		process.env.REMINDER_RECEIPT_TO = QUITTUNG_AN
		const ergebnis = await nachsehen(SONNTAG_16_59_UHR)
		expect(ergebnis.kind).toBe('not_due')
		expect(sent).toHaveLength(0)
	})

	test('ein zweiter Tick quittiert nicht noch einmal', async () => {
		process.env.REMINDER_RECEIPT_TO = QUITTUNG_AN
		await nachsehen(SONNTAG_17_UHR)
		sent = []
		const zweiter = await nachsehen(DIENSTAG_DANACH)
		expect(zweiter.kind).toBe('already_sent')
		expect(sent).toHaveLength(0)
	})

	test('eine gescheiterte Quittung macht den Versand nicht kaputt', async () => {
		process.env.REMINDER_RECEIPT_TO = QUITTUNG_AN
		scheitert.add(QUITTUNG_AN)
		const protokoll = vi.spyOn(console, 'log').mockImplementation(() => {})

		const ergebnis = await nachsehen(SONNTAG_17_UHR)

		expect(ergebnis.kind).toBe('sent')
		if (ergebnis.kind !== 'sent') throw new Error('nicht verschickt')
		expect(ergebnis.recipients).toBe(3)
		expect(anFamilien()).toHaveLength(3)
		expect(
			protokoll.mock.calls.some((c) =>
				String(c[0]).includes('QUITTUNG NICHT ZUGESTELLT'),
			),
		).toBe(true)
	})

	test('sie nennt, was schiefging — sonst muesste man zweimal nachsehen', async () => {
		process.env.REMINDER_RECEIPT_TO = QUITTUNG_AN
		familien.sonnenschein = []
		scheitert.add('jens@example.org')

		await nachsehen(SONNTAG_17_UHR)

		const quittung = quittungen()[0] as SendInput
		expect(quittung.text).toContain('NICHT erreicht')
		expect(quittung.text).toContain('sonnenschein')
		expect(quittung.text).toContain('Versand gescheitert an')
		expect(quittung.text).toContain('jens@example.org')
	})
})

describe('Konten-Prüfung: Meldung nur bei Befund', () => {
	const original = { ...process.env }

	const zitadelAntwortet = (
		grants: { userId: string; email: string }[],
	): void => {
		process.env.ZITADEL_ISSUER = 'https://id.example.org'
		process.env.ZITADEL_ORG_ID = 'org-1'
		process.env.ZITADEL_PROJECT_ID = 'proj-1'
		process.env.ZITADEL_SERVICE_TOKEN = 'tok'
		resetGrantsConfig()
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							result: grants.map((g) => ({
								userId: g.userId,
								email: g.email,
								roleKeys: ['mitglied'],
								state: 'USER_GRANT_STATE_ACTIVE',
							})),
						}),
						{ status: 200 },
					),
			),
		)
	}

	const adressbuchFuellen = (): void => {
		for (const [id, email] of [
			['anke', 'anke@example.org'],
			['jens', 'jens@example.org'],
			['mira', 'mira@example.org'],
		] as const) {
			upsertMitglied({ id, first_name: id, last_name: 'Beispiel', email }, db)
		}
	}

	afterEach(() => {
		process.env = { ...original }
		resetGrantsConfig()
		vi.unstubAllGlobals()
	})

	test('saubere Lage: die Erinnerung geht raus, an den Betrieb geht NICHTS', async () => {
		adressbuchFuellen()
		zitadelAntwortet([
			{ userId: 'u-anke', email: 'anke@example.org' },
			{ userId: 'u-jens', email: 'jens@example.org' },
			{ userId: 'u-mira', email: 'mira@example.org' },
		])

		const ergebnis = await nachsehen(SONNTAG_17_UHR)

		expect(ergebnis.kind).toBe('sent')
		expect(anFamilien()).toHaveLength(3)
		expect(anBetrieb()).toHaveLength(0)
		if (ergebnis.kind !== 'sent') throw new Error('nicht verschickt')
		expect(ergebnis.account_check?.checked).toBe(3)
		expect(ergebnis.account_check?.cut).toEqual([])
	})

	test('eine Abweichung: dann geht der Bericht raus wie bisher', async () => {
		adressbuchFuellen()
		zitadelAntwortet([
			{ userId: 'u-anke', email: 'anke@example.org' },
			{ userId: 'u-jens', email: 'jens@example.org' },
		])

		await nachsehen(SONNTAG_17_UHR)

		expect(anFamilien()).toHaveLength(3)
		const meldung = anBetrieb()
		expect(meldung).toHaveLength(1)
		const text = (meldung[0] as SendInput).text as string
		expect(text).toContain('Konten-Pruefung')
		expect(text).not.toContain('mira@example.org')
		expect(text).toContain('***')
	})

	test('eine blinde Prüfung ist kein Befund — ZITADEL weg heisst nicht "melden"', async () => {
		adressbuchFuellen()
		process.env.ZITADEL_ISSUER = 'https://id.example.org'
		process.env.ZITADEL_ORG_ID = 'org-1'
		process.env.ZITADEL_PROJECT_ID = 'proj-1'
		process.env.ZITADEL_SERVICE_TOKEN = 'tok'
		resetGrantsConfig()
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('ECONNREFUSED')
			}),
		)

		const ergebnis = await nachsehen(SONNTAG_17_UHR)

		expect(ergebnis.kind).toBe('sent')
		expect(anFamilien()).toHaveLength(3)
		expect(anBetrieb()).toHaveLength(0)
	})
})
