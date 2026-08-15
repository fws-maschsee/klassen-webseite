/**
 * Der Erinnerungsdienst des Putzplans.
 *
 * Geprüft wird mit GESTELLTER UHR und nicht mit Warten: Ein Test, der auf
 * Sonntag 17 Uhr wartet, läuft einmal pro Woche. `vi.setSystemTime` stellt die
 * Uhr, die der Produktivcode über `new Date()` liest — der Weg durch den Code
 * ist derselbe wie im Betrieb.
 *
 * Die Datenquelle ist eine Attrappe. `naechsterPutztermin` und
 * `familienEmpfaenger` entstehen gerade in `src/klasse/putzplan.ts`; der
 * Erinnerungsdienst hängt am Vertrag, nicht an dessen Implementierung. Was hier
 * geprüft wird, ist auch mit der echten Quelle dasselbe: WANN verschickt wird,
 * WIE OFT und was passiert, wenn niemand erreichbar ist.
 *
 * DATENSCHUTZ: alle Namen und Adressen sind erfunden. Eine echte Einteilung
 * nennt die Familien einer bestimmten Klasse und gehört in kein Repository.
 */
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
import { erinnerungZuTermin } from '../../src/lib/db/putzplanReminders.ts'
import { suppressAddress } from '../../src/lib/db/suppressions.ts'
import type { SendInput } from '../../src/lib/email/transport.ts'
import { createTestDb } from '../helpers/db.ts'
import { TESTKLASSE } from '../setup.ts'

/**
 * Die Testklasse mit hinterlegtem Kontaktnamen — der steht in der Mail
 * („sagt … Bescheid"), und `TESTKLASSE` hat keinen.
 */
const KLASSE = defineKlassenConfig({
	...TESTKLASSE,
	contactName: 'Ludwig Muster',
})

/**
 * Ein Termin am Freitag, 21.08.2026, und der Sonntag davor um 17 Uhr Berliner
 * Zeit — im Sommer sind das 15 Uhr UTC.
 *
 * Die Wochentage stehen nicht nur im Namen der Konstanten: Ein falsch
 * abgeschriebenes Datum würde jede Aussage dieser Datei unbemerkt entwerten.
 */
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
/** Adressen, bei denen der Versand scheitert. */
let scheitert: Set<string>
let termine: PutzTermin[]
let familien: Record<string, FamilienEmpfaenger[]>

/**
 * Die Attrappe ist ABSICHTLICH großzügig: Sie liefert einen Termin, solange
 * dessen Tag nicht vorbei ist — auch am Termintag selbst. Damit entscheidet
 * über „zu spät" der Produktivcode und nicht die Attrappe; wie eng die echte
 * `naechsterPutztermin` filtert, ist dann egal.
 */
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

/** Einmal nachsehen, mit der Uhr auf `jetzt`. */
const nachsehen = (jetzt: Date) => {
	vi.setSystemTime(jetzt)
	return sendeFaelligeErinnerung({ quelle, db, transport })
}

/** Die Mails an die Familien — die Meldung an den Betrieb gehört nicht dazu. */
const anFamilien = () =>
	sent.filter((m) => m.to !== KLASSE.contactMail).map((m) => m.to)

/** Die Meldungen an den Betrieb. */
const anBetrieb = () => sent.filter((m) => m.to === KLASSE.contactMail)

beforeEach(() => {
	setKlassenConfig(KLASSE)
	vi.useFakeTimers()
	db = createTestDb()
	sent = []
	scheitert = new Set()
	termine = [{ datum: FREITAG, gruppen: ['probst-vogel', 'sonnenschein'] }]
	familien = {
		'probst-vogel': [
			{ email: 'anke@example.org', name: 'Anke Probst' },
			{ email: 'jens@example.org', name: 'Jens Vogel' },
		],
		sonnenschein: [{ email: 'mira@example.org', name: 'Mira Sonnenschein' }],
	}
	// Der Anzeigename kommt aus dem Label der Gruppe. Einmal MIT und einmal OHNE
	// „Familie"-Präfix, weil beides vorkommt und in der Mail genau einmal
	// „Familie" stehen soll.
	upsertGroup({ key: 'probst-vogel', label: 'Familie Probst/Vogel' }, db)
	upsertGroup({ key: 'sonnenschein', label: 'Sonnenschein' }, db)
})

afterEach(() => {
	vi.useRealTimers()
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
		// Freitag, 04.12.2026 — Winterzeit. 17 Uhr Berlin sind dann 16 Uhr UTC.
		// Genau diese Zeile fällt um, wenn jemand mit einer festen
		// Stundenverschiebung rechnet: Im Sommer stimmte sie trotzdem, ein halbes
		// Jahr lang.
		const winter = sendezeitFuer(new Date('2026-12-04T00:00:00.000Z'))
		expect(winter.toISOString()).toBe('2026-11-29T16:00:00.000Z')
		expect(winter.getUTCHours()).not.toBe(sendezeitFuer(FREITAG).getUTCHours())
	})

	test('ein vorgezogener Donnerstagstermin nimmt denselben Sonntag', () => {
		// Kommt im Plan vor, wenn der Freitag ein Feiertag ist. „Der Sonntag
		// davor" gilt weiter; „minus fünf Tage" wäre hier ein Montag.
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
	test('sonntags nach 17 Uhr an alle Mitglieder beider Familien', async () => {
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
		// Beide Familien stehen in JEDER Mail: Wer liest, soll sehen, mit wem er
		// zusammen dran ist.
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
		// Und nichts gebucht: Ein Eintrag hier würde den echten Sendetermin
		// stillschweigend verschlucken.
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
		// Ein Neustart ist genau das: neuer Prozess, kein Modulzustand, dieselbe
		// Datenbank. Deshalb steht die Buchung dort und nicht in einer Variablen.
		expect(await nachsehen(DIENSTAG_DANACH)).toEqual({
			kind: 'already_sent',
			terminDate: '2026-08-21',
		})
		expect(anFamilien()).toHaveLength(3)
	})

	test('holt einen verpassten Sonntag nach', async () => {
		// Der Prozess lag sonntagabends im Deploy. Dienstagmorgen kommt er hoch.
		const ergebnis = await nachsehen(DIENSTAG_DANACH)
		expect(ergebnis).toMatchObject({ kind: 'sent', recipients: 3 })
		expect((sent[0] as SendInput).text).toContain('am kommenden Freitag')
	})

	test('am Termintag selbst nicht mehr', async () => {
		// „Am kommenden Freitag" wäre am Freitag falsch, und eine Mail mit dem
		// falschen Tag ist schlimmer als keine.
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

		// Die erreichbare Familie bekommt ihre Erinnerung trotzdem: Eine fehlende
		// Adresse ist kein Grund, auch noch die anderen im Dunkeln zu lassen.
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
		// Die Meldung geht an den Betrieb und NICHT an den Verteiler.
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
		// Kein stiller Versand an niemanden — eine Meldung.
		expect(anFamilien()).toHaveLength(0)
		expect(anBetrieb()).toHaveLength(1)
	})

	test('eine gesperrte Adresse zählt nicht als erreicht', async () => {
		// Harter Bounce oder Beschwerde: Die Adresse steht in der Sperrliste, die
		// Mail käme dort nie an. Für die Familie ist das dasselbe wie „keine
		// Adresse" — also dieselbe Meldung.
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
		// Nichts gebucht: sonst hätte eine halbe Stunde SMTP-Ausfall die
		// Erinnerung dieser Woche für immer verschluckt.
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
		// Name UND Adresse: Der Name allein ist kein Weg, die Adresse allein
		// nennt niemanden.
		expect(text).toContain(
			'sagt Ludwig Muster Bescheid (verwaltung@example.org)',
		)
	})

	test('ohne hinterlegten Namen bleibt die Adresse allein stehen', () => {
		// `contactName` ist optional. Einen Namen zu erfinden hieße, in der einen
		// Klasse den Namen der anderen zu nennen.
		setKlassenConfig(TESTKLASSE)
		const { text } = baueErinnerungstext(FREITAG, ['Sonnenschein'])
		expect(text).toContain('sagt unter verwaltung@example.org Bescheid')
		expect(text).not.toContain('undefined')
	})

	test('drei Familien werden mit Komma und „und" verbunden', () => {
		// Ein Schrägstrich gehört zu EINER Familie mit zwei Nachnamen und trennt
		// keine zwei — wer hier mit „/" verbindet, macht aus dreien eine.
		const { subject } = baueErinnerungstext(FREITAG, ['A', 'B/C', 'D'])
		expect(subject).toContain('A, B/C und D')
	})

	test('trägt Auto-Submitted, damit keine Abwesenheitsnotiz antwortet', async () => {
		await nachsehen(SONNTAG_17_UHR)
		for (const mail of sent) {
			expect(mail.headers?.['Auto-Submitted']).toBe('auto-generated')
		}
		// Antworten („wir können nicht") müssen bei einem Menschen landen.
		expect((sent[0] as SendInput).replyTo).toBe(KLASSE.contactMail)
	})
})
