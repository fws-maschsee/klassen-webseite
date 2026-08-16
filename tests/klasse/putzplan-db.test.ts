import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import {
	familienEmpfaenger,
	familienGruppenKey,
	naechsterPutztermin,
	planAlsEintraege,
	putzplanAusDatei,
	putzplanZeilen,
} from '../../src/klasse/putzplan.ts'
import {
	addSubgroup,
	deleteGroup,
	upsertGroup,
} from '../../src/lib/db/groups.ts'
import { upsertMitglied } from '../../src/lib/db/members.ts'
import {
	ersetzePlan,
	loescheTermin,
	setzeTermin,
	tauscheTermine,
} from '../../src/lib/db/putzplan.ts'
import { createTestDb } from '../helpers/db.ts'

/**
 * Der Putzplan in der Datenbank: lesen, schreiben, und was das Schema erzwingt.
 *
 * Hier standen einmal Tests ueber vier Planregeln — Anzahl der Familien je
 * Termin, Mindestabstand, Paarungen. Die Regeln sind weg, und die Tests mit
 * ihnen: Was eine sinnvolle Einteilung ist, entscheidet die Klasse.
 *
 * Was geprueft wird, ist deshalb nur noch zweierlei: dass der Plan
 * unveraendert wieder herauskommt, wie er hineingegangen ist, und dass das
 * SCHEMA haelt, was kein Code mehr prueft — Fremdschluessel auf `groups`,
 * Primaerschluessel `(date, group_key)`, das Datumsformat.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

/** Zehn Familien — genug, dass ein Plan aus zehn Terminen sich nicht wiederholt. */
const FAMILIEN = [
	'musterfrau',
	'beispiel',
	'probst-vogel',
	'sonnenschein',
	'winter',
	'sommer',
	'herbst',
	'fruehling',
	'nordwind',
	'suedstern',
] as const

const key = (slug: string) => familienGruppenKey(slug)

/**
 * Ein Plan: zehn Termine im Wochenabstand, jede Familie zweimal.
 *
 * Derselbe Plan wie in `tests/fixtures/putzplan-import.yaml` — die Fixture
 * beschreibt ihn als Datei, hier steht er als Daten. Beide muessen dieselbe
 * Einteilung meinen, sonst prueft der Importtest etwas anderes als dieser hier.
 */
const PLAN = [
	{ date: '2026-08-21', groups: [key('musterfrau'), key('beispiel')] },
	{ date: '2026-08-28', groups: [key('probst-vogel'), key('sonnenschein')] },
	{ date: '2026-09-04', groups: [key('winter'), key('sommer')] },
	{ date: '2026-09-11', groups: [key('herbst'), key('fruehling')] },
	{ date: '2026-09-18', groups: [key('nordwind'), key('suedstern')] },
	{ date: '2026-09-25', groups: [key('musterfrau'), key('probst-vogel')] },
	{ date: '2026-10-02', groups: [key('beispiel'), key('winter')] },
	{ date: '2026-10-09', groups: [key('sonnenschein'), key('herbst')] },
	{ date: '2026-10-16', groups: [key('sommer'), key('nordwind')] },
	{ date: '2026-10-23', groups: [key('fruehling'), key('suedstern')] },
]

let db: Database

beforeEach(() => {
	db = createTestDb()
	for (const slug of FAMILIEN) {
		upsertGroup({ key: key(slug), label: slug }, db)
	}
})

/** Der Plan, eingespielt. */
const planEinspielen = () => ersetzePlan(PLAN, db)

describe('das Schema selbst', () => {
	test('haelt eine Zuteilung auf eine unbekannte Gruppe zurueck', () => {
		// Der Schreibpfad faengt das mit einer freundlichen Meldung ab. Der
		// Fremdschluessel ist die zweite Linie: Er gilt auch fuer den, der an
		// `setzeTermin` vorbei in die Tabelle schreibt.
		db.prepare("INSERT INTO cleaning_dates (date) VALUES ('2026-08-21')").run()
		expect(() =>
			db
				.prepare(
					"INSERT INTO cleaning_assignments (date, group_key) VALUES ('2026-08-21', 'familie-gibtesnicht')",
				)
				.run(),
		).toThrow(/FOREIGN KEY/)
	})

	test('laesst dieselbe Gruppe am selben Termin kein zweites Mal zu', () => {
		// Der Primaerschluessel (date, group_key). Dass eine Familie an einem
		// Termin nicht zweimal stehen kann, ist keine Regel, die jemand prueft —
		// es faellt strukturell weg, und deshalb steht der Test hier am Schema.
		db.prepare("INSERT INTO cleaning_dates (date) VALUES ('2026-08-21')").run()
		const zuteilen = db.prepare(
			'INSERT INTO cleaning_assignments (date, group_key) VALUES (?, ?)',
		)
		zuteilen.run('2026-08-21', key('musterfrau'))
		expect(() => zuteilen.run('2026-08-21', key('musterfrau'))).toThrow(
			/UNIQUE|PRIMARY/,
		)
	})

	test('lehnt ein Datum ab, das nicht JJJJ-MM-TT ist', () => {
		// `2026-8-1` sortierte sich als Zeichenkette falsch ein, und der Plan
		// wird ueberall nach dieser Zeichenkette sortiert.
		expect(() =>
			db.prepare("INSERT INTO cleaning_dates (date) VALUES ('2026-8-1')").run(),
		).toThrow(/CHECK/)
	})

	test('haelt das Loeschen einer Familie zurueck, die noch im Plan steht', () => {
		// ON DELETE RESTRICT und nicht CASCADE: Mit CASCADE bliebe der Termin mit
		// EINER Familie zurueck — ein Plan, der vollstaendig aussieht und an dem
		// eine Familie fehlt, ist genau der Ausfall, den niemand bemerkt.
		planEinspielen()
		expect(() => deleteGroup(key('musterfrau'), db)).toThrow(/FOREIGN KEY/)
	})
})

describe('ein Plan', () => {
	test('wird angenommen und kommt vollstaendig zurueck', () => {
		const plan = planEinspielen()
		expect(plan).toHaveLength(PLAN.length)
		expect(plan.map((t) => t.date)).toEqual([...PLAN.map((t) => t.date)].sort())
		// Gegen die EINGABE geprueft und nicht gegen eine feste Anzahl: Die
		// Zusicherung ist, dass der Plan unveraendert zurueckkommt, und die gilt
		// unabhaengig davon, wie viele Familien ein Termin hat.
		for (const erwartet of PLAN) {
			const termin = plan.find((t) => t.date === erwartet.date)
			expect(termin?.groups).toEqual([...erwartet.groups].sort())
		}
	})

	test('laesst sich zweimal einspielen, ohne sich zu aendern', () => {
		// Die Zusicherung des Imports: Ein zweiter Lauf darf den Plan nicht
		// verdoppeln.
		const erst = planEinspielen()
		const zweit = planEinspielen()
		expect(zweit).toEqual(erst)
	})
})

describe('unbekannte Gruppen', () => {
	test('werden mit Namen genannt statt als FK-Fehler', () => {
		planEinspielen()
		expect(() =>
			setzeTermin(
				{ date: '2026-11-06', groups: ['familie-gibtesnicht', key('winter')] },
				db,
			),
		).toThrow(/familie-gibtesnicht/)
	})
})

describe('Termine tauschen', () => {
	test('tauscht die Familien und laesst die Anmerkung beim Datum', () => {
		ersetzePlan(
			PLAN.map((t) =>
				t.date === '2026-08-28' ? { ...t, note: '(Do, da Fr Feiertag)' } : t,
			),
			db,
		)
		// Position 0 und 1 — der Tausch, um den es in der Praxis geht:
		// Beide Paare ruecken nur um eine Position, und ihr zweiter Einsatz liegt
		// weit genug entfernt.
		const plan = tauscheTermine('2026-08-21', '2026-08-28', db)
		const a = plan.find((t) => t.date === '2026-08-21')
		const b = plan.find((t) => t.date === '2026-08-28')

		expect(a?.groups).toEqual([key('probst-vogel'), key('sonnenschein')].sort())
		expect(b?.groups).toEqual([key('musterfrau'), key('beispiel')].sort())
		// Der Feiertag verschiebt sich nicht mit den Familien.
		expect(a?.note).toBeNull()
		expect(b?.note).toBe('(Do, da Fr Feiertag)')
	})

	test('nennt einen Termin, den es nicht gibt', () => {
		planEinspielen()
		expect(() => tauscheTermine('2026-08-21', '2027-01-01', db)).toThrow(
			/2027-01-01/,
		)
	})
})

describe('naechsterPutztermin', () => {
	test('liefert den naechsten Termin mit seinen Gruppen', () => {
		planEinspielen()
		const naechster = naechsterPutztermin(new Date('2026-09-05T10:00:00Z'), db)
		expect(naechster?.datum.toISOString()).toBe('2026-09-11T00:00:00.000Z')
		expect(naechster?.gruppen.sort()).toEqual(
			[key('herbst'), key('fruehling')].sort(),
		)
	})

	test('zaehlt den Tag selbst mit', () => {
		// Ein Erinnerungsdienst, der am Morgen des Putztermins laeuft, meint
		// diesen Termin — nicht den in einer Woche.
		planEinspielen()
		const naechster = naechsterPutztermin(new Date('2026-09-11T06:00:00Z'), db)
		expect(naechster?.datum.toISOString()).toBe('2026-09-11T00:00:00.000Z')
	})

	test('liefert null, wenn kein Termin mehr kommt', () => {
		planEinspielen()
		expect(naechsterPutztermin(new Date('2027-01-01T00:00:00Z'), db)).toBeNull()
	})

	test('liefert null bei leerem Plan', () => {
		expect(naechsterPutztermin(new Date('2026-08-01T00:00:00Z'), db)).toBeNull()
	})
})

describe('familienEmpfaenger', () => {
	beforeEach(() => {
		upsertMitglied(
			{
				first_name: 'Vera',
				last_name: 'Musterfrau',
				email: 'vera@example.org',
				groups: [key('musterfrau')],
			},
			db,
		)
		upsertMitglied(
			{
				first_name: 'Jan',
				last_name: 'Musterfrau',
				email: 'jan@example.org',
				groups: [key('musterfrau')],
			},
			db,
		)
	})

	test('loest ueber das Gruppenmodell zu Adressen auf', () => {
		const empfaenger = familienEmpfaenger(key('musterfrau'), db)
		expect(empfaenger.map((e) => e.email).sort()).toEqual([
			'jan@example.org',
			'vera@example.org',
		])
		expect(empfaenger.map((e) => e.name)).toContain('Vera Musterfrau')
	})

	test('nimmt die Mitglieder von Untergruppen mit', () => {
		// Das ist der Grund, ueberhaupt das bestehende Gruppenmodell zu benutzen
		// statt eines eigenen: Die rekursive Aufloesung gibt es schon.
		upsertGroup({ key: 'familie-beispiel-kinder', label: 'Kinder' }, db)
		addSubgroup(key('beispiel'), 'familie-beispiel-kinder', db)
		upsertMitglied(
			{
				first_name: 'Mia',
				last_name: 'Beispiel',
				email: 'mia@example.org',
				groups: ['familie-beispiel-kinder'],
			},
			db,
		)
		expect(familienEmpfaenger(key('beispiel'), db).map((e) => e.email)).toEqual(
			['mia@example.org'],
		)
	})

	test('gibt eine LEERE Liste zurueck, wenn es die Gruppe nicht gibt', () => {
		// Die wichtigste Zusage: Der Aufrufer bekommt NICHTS und kann den Fall
		// erkennen — statt einer erfundenen Adresse, an die eine Erinnerung ginge,
		// die den Empfaenger nichts angeht.
		expect(familienEmpfaenger('familie-gibtesnicht', db)).toEqual([])
	})

	test('gibt eine LEERE Liste zurueck, wenn niemand eine Adresse hat', () => {
		upsertGroup({ key: key('winter'), label: 'Winter' }, db)
		upsertMitglied(
			{
				first_name: 'Ohne',
				last_name: 'Adresse',
				email: null,
				groups: [key('winter')],
			},
			db,
		)
		expect(familienEmpfaenger(key('winter'), db)).toEqual([])
	})

	test('gibt eine LEERE Liste zurueck, wenn die Gruppe leer ist', () => {
		expect(familienEmpfaenger(key('sommer'), db)).toEqual([])
	})
})

describe('die Tabelle auf der Seite', () => {
	test('zeigt jeden Termin des Plans, mit Label statt Group-Key', () => {
		upsertGroup({ key: key('musterfrau'), label: 'Musterfrau' }, db)
		upsertGroup({ key: key('beispiel'), label: 'Beispiel' }, db)
		planEinspielen()

		const zeilen = putzplanZeilen(planAlsEintraege(db))
		expect(zeilen).toHaveLength(PLAN.length)
		expect(zeilen[0]?.familie).toBe('Familie Beispiel und Familie Musterfrau')
		expect(zeilen[0]?.datum).toBe('21.08.2026')
	})

	test('traegt keinen Group-Key in die Tabelle', () => {
		// Der Key ist der Schluessel, an dem der Erinnerungsdienst seine Zuordnung
		// aufhaengt. Auf der Seite hat er nichts zu suchen: Er sieht wie ein Name
		// aus, ist aber keiner.
		planEinspielen()
		const ausgabe = JSON.stringify(putzplanZeilen(planAlsEintraege(db)))
		for (const slug of FAMILIEN) expect(ausgabe).not.toContain(key(slug))
	})

	test('bleibt bei leerem Plan leer', () => {
		expect(putzplanZeilen(planAlsEintraege(db))).toEqual([])
	})
})

describe('Termin loeschen', () => {
	test('nimmt ihn aus dem Plan', () => {
		planEinspielen()
		const plan = loescheTermin('2026-08-21', db)
		expect(plan.map((t) => t.date)).not.toContain('2026-08-21')
		expect(plan).toHaveLength(PLAN.length - 1)
	})
})

describe('Import aus der YAML-Datei', () => {
	const FIXTURE = new URL('../fixtures/', import.meta.url)

	test('liest Familien und Termine aus der Datei', async () => {
		const { familien, termine } = await putzplanAusDatei(
			FIXTURE,
			'putzplan-import.yaml',
		)
		expect(familien).toHaveLength(FAMILIEN.length)
		expect(familien.map((f) => f.key).sort()).toEqual(
			FAMILIEN.map((slug) => key(slug)).sort(),
		)
		expect(familien.find((f) => f.key === key('probst-vogel'))?.label).toBe(
			'Probst/Vogel',
		)
		expect(termine).toHaveLength(PLAN.length)
	})

	test('ergibt eingespielt genau den erwarteten Plan', async () => {
		const { familien, termine } = await putzplanAusDatei(
			FIXTURE,
			'putzplan-import.yaml',
		)
		for (const { key: k, label } of familien) upsertGroup({ key: k, label }, db)
		const plan = ersetzePlan(termine, db)

		expect(plan.map(({ date, groups }) => ({ date, groups }))).toEqual(
			PLAN.map(({ date, groups }) => ({
				date,
				groups: [...groups].sort(),
			})),
		)
		expect(plan.find((t) => t.date === '2026-10-02')?.note).toBe(
			'(Do, da Fr Feiertag)',
		)
	})

	test('ist idempotent', async () => {
		const { familien, termine } = await putzplanAusDatei(
			FIXTURE,
			'putzplan-import.yaml',
		)
		for (const { key: k, label } of familien) upsertGroup({ key: k, label }, db)
		const erst = ersetzePlan(termine, db)
		const zweit = ersetzePlan(termine, db)
		expect(zweit).toEqual(erst)
	})

	test('liefert nichts, wenn es die Datei nicht gibt', async () => {
		const { familien, termine } = await putzplanAusDatei(
			FIXTURE,
			'gibtesnicht.yaml',
		)
		expect(familien).toEqual([])
		expect(termine).toEqual([])
	})
})
