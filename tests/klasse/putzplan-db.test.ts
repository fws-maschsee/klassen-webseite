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
	MINDESTABSTAND,
	PutzplanVerstoss,
	planLesen,
	setzeTermin,
	tauscheTermine,
} from '../../src/lib/db/putzplan.ts'
import { createTestDb } from '../helpers/db.ts'

/**
 * Der Putzplan in der Datenbank.
 *
 * Der Schaden, gegen den diese Tests geschrieben sind, hat sich mit dem Umzug
 * verschoben. Vorher war es die Tabelle, die vollstaendig AUSSIEHT und einen
 * Termin nicht nennt. Jetzt ist es der stillschweigend gespeicherte Verstoss:
 * Ein Termin mit nur einer Familie, eine Familie zweimal in drei Wochen, eine
 * Paarung zum zweiten Mal — alles Dinge, die frueher die CI der Klasse an einer
 * YAML-Datei abgelehnt hat und die es nach dem Umzug nicht mehr gibt, wenn die
 * Regeln nicht im SCHREIBPFAD stehen.
 *
 * Deshalb prueft jeder der vier Regeltests, dass der Schreibvorgang WIRKLICH
 * abgelehnt wird und die Datenbank danach unveraendert ist — nicht bloss, dass
 * eine Prueffunktion etwas zurueckgibt.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

/** Zehn Familien, so viele wie die Abstands- und die Paarungsregel brauchen. */
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
 * Ein gueltiger Plan: zehn Termine im Wochenabstand, jede Familie zweimal,
 * jede Paarung einmal, kleinster Abstand genau `MINDESTABSTAND`.
 *
 * Derselbe Plan wie in `tests/fixtures/putzplan-import.yaml` — die Fixture
 * beschreibt ihn als Datei, hier steht er als Daten. Beide muessen dieselbe
 * Einteilung meinen, sonst prueft der Importtest etwas anderes als dieser hier.
 */
const GUELTIGER_PLAN = [
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

/** Der gueltige Plan, eingespielt. */
const planEinspielen = () => ersetzePlan(GUELTIGER_PLAN, db)

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
		// Regel 2 als Primaerschluessel. Dieselbe Aussage wie im Schreibpfad,
		// nur eine Ebene tiefer — und die einzige der vier, die sich in SQLite
		// ueberhaupt als Constraint ausdruecken laesst.
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
		// `2026-8-1` sortierte sich als Zeichenkette falsch ein — und die
		// Abstandsregel zaehlt in genau dieser Reihenfolge.
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

describe('ein gueltiger Plan', () => {
	test('wird angenommen und kommt vollstaendig zurueck', () => {
		const plan = planEinspielen()
		expect(plan).toHaveLength(GUELTIGER_PLAN.length)
		expect(plan.map((t) => t.date)).toEqual(
			[...GUELTIGER_PLAN.map((t) => t.date)].sort(),
		)
		for (const termin of plan) expect(termin.groups).toHaveLength(2)
	})

	test('laesst sich zweimal einspielen, ohne sich zu aendern', () => {
		// Die Zusicherung des Imports. Ohne sie waere ein zweiter Lauf entweder
		// ein Fehler (Paarung schon vergeben) oder ein doppelter Plan.
		const erst = planEinspielen()
		const zweit = planEinspielen()
		expect(zweit).toEqual(erst)
	})
})

describe('Regel 1: genau zwei Gruppen je Termin', () => {
	test('lehnt einen Termin mit nur EINER Familie ab', () => {
		planEinspielen()
		expect(() =>
			setzeTermin({ date: '2026-11-06', groups: [key('musterfrau')] }, db),
		).toThrow(PutzplanVerstoss)
	})

	test('lehnt einen Termin mit DREI Familien ab', () => {
		planEinspielen()
		expect(() =>
			setzeTermin(
				{
					date: '2026-11-06',
					groups: [key('musterfrau'), key('beispiel'), key('winter')],
				},
				db,
			),
		).toThrow(/genau 2/)
	})

	test('schreibt bei einem Verstoss NICHTS', () => {
		// Die eigentliche Aussage: Der abgelehnte Termin darf auch nicht halb in
		// der Datenbank stehen — sonst gaebe es ihn ohne Einteilung, und die
		// Seite zeigte eine leere Zeile.
		const vorher = planEinspielen()
		expect(() =>
			setzeTermin({ date: '2026-11-06', groups: [key('musterfrau')] }, db),
		).toThrow()
		expect(planLesen(db)).toEqual(vorher)
	})
})

describe('Regel 2: keine Familie zweimal am selben Termin', () => {
	test('lehnt dieselbe Familie zweimal ab', () => {
		planEinspielen()
		expect(() =>
			setzeTermin(
				{ date: '2026-11-06', groups: [key('musterfrau'), key('musterfrau')] },
				db,
			),
		).toThrow(/zweimal/)
	})

	test('schreibt bei einem Verstoss NICHTS', () => {
		const vorher = planEinspielen()
		expect(() =>
			setzeTermin(
				{ date: '2026-11-06', groups: [key('musterfrau'), key('musterfrau')] },
				db,
			),
		).toThrow()
		expect(planLesen(db)).toEqual(vorher)
	})
})

describe(`Regel 3: mindestens ${MINDESTABSTAND} Termine Abstand`, () => {
	test('lehnt eine Familie ab, die zu frueh wieder drankommt', () => {
		planEinspielen()
		// `musterfrau` putzt am 21.08. (Position 0). Position 3 waere Abstand 3.
		expect(() =>
			setzeTermin(
				{ date: '2026-09-11', groups: [key('musterfrau'), key('nordwind')] },
				db,
			),
		).toThrow(/Abstand/)
	})

	test('nimmt genau den Mindestabstand an und lehnt einen weniger ab', () => {
		// Die Grenze, von beiden Seiten. Ohne den ersten Fall bliebe ein "<="
		// statt "<" unbemerkt, und der Plan liesse sich nicht mehr voll besetzen;
		// ohne den zweiten waere die Regel wirkungslos.
		//
		// Ein eigener, kleiner Plan statt `GUELTIGER_PLAN`: Dort steht jede
		// Familie schon zweimal, und ein dritter Einsatz traefe immer auch einen
		// anderen Abstand — der Test wuerde dann etwas anderes zeigen, als er sagt.
		const kurz = [
			{ date: '2026-08-21', groups: [key('musterfrau'), key('beispiel')] },
			{
				date: '2026-08-28',
				groups: [key('probst-vogel'), key('sonnenschein')],
			},
			{ date: '2026-09-04', groups: [key('winter'), key('sommer')] },
			{ date: '2026-09-11', groups: [key('herbst'), key('fruehling')] },
		]

		// Position 0 und Position 4: Abstand 4, angenommen.
		expect(() =>
			ersetzePlan(
				[
					...kurz,
					{ date: '2026-09-18', groups: [key('musterfrau'), key('nordwind')] },
				],
				db,
			),
		).not.toThrow()

		// Dieselbe Familie eine Position frueher: Abstand 3, abgelehnt.
		expect(() =>
			ersetzePlan(
				[
					...kurz.slice(0, 3),
					{ date: '2026-09-11', groups: [key('musterfrau'), key('nordwind')] },
				],
				db,
			),
		).toThrow(/Abstand/)
	})

	test('sieht auch den Verstoss, den die Aenderung beim NACHFOLGER anrichtet', () => {
		planEinspielen()
		// `sommer` steht auf Position 2 und 8. Wer ihn zusaetzlich auf Position 5
		// setzt, verletzt den Abstand zu BEIDEN — der neue Termin selbst sieht
		// harmlos aus. Genau deshalb prueft der Schreibpfad den ganzen Plan.
		expect(() =>
			setzeTermin(
				{ date: '2026-09-25', groups: [key('sommer'), key('nordwind')] },
				db,
			),
		).toThrow(/Abstand/)
	})

	test('schreibt bei einem Verstoss NICHTS', () => {
		const vorher = planEinspielen()
		expect(() =>
			setzeTermin(
				{ date: '2026-09-11', groups: [key('musterfrau'), key('nordwind')] },
				db,
			),
		).toThrow()
		expect(planLesen(db)).toEqual(vorher)
	})
})

describe('Regel 4: keine Paarung zweimal im ganzen Plan', () => {
	test('lehnt eine schon vergebene Paarung ab', () => {
		planEinspielen()
		// musterfrau + beispiel stehen am 21.08. schon zusammen.
		expect(() =>
			setzeTermin(
				{ date: '2026-11-06', groups: [key('musterfrau'), key('beispiel')] },
				db,
			),
		).toThrow(/Paarung/)
	})

	test('erkennt die Paarung unabhaengig von der Reihenfolge', () => {
		planEinspielen()
		expect(() =>
			setzeTermin(
				{ date: '2026-11-06', groups: [key('beispiel'), key('musterfrau')] },
				db,
			),
		).toThrow(/Paarung/)
	})

	test('schreibt bei einem Verstoss NICHTS', () => {
		const vorher = planEinspielen()
		expect(() =>
			setzeTermin(
				{ date: '2026-11-06', groups: [key('musterfrau'), key('beispiel')] },
				db,
			),
		).toThrow()
		expect(planLesen(db)).toEqual(vorher)
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
			GUELTIGER_PLAN.map((t) =>
				t.date === '2026-08-28' ? { ...t, note: '(Do, da Fr Feiertag)' } : t,
			),
			db,
		)
		// Position 0 und 1 — der Tausch, der einen gueltigen Plan gueltig laesst:
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

	test('lehnt einen Tausch ab, der den Abstand kaputtmacht', () => {
		const vorher = planEinspielen()
		// Position 4 (nordwind+suedstern) gegen Position 8 (sommer+nordwind):
		// `sommer` stuende danach auf Position 2 und 4 — zwei Termine Abstand.
		// Der Tausch selbst sieht harmlos aus, er aendert keine Paarung; genau
		// deshalb muss die Pruefung auch hier laufen.
		expect(() => tauscheTermine('2026-09-18', '2026-10-16', db)).toThrow(
			PutzplanVerstoss,
		)
		expect(planLesen(db)).toEqual(vorher)
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
		expect(zeilen).toHaveLength(GUELTIGER_PLAN.length)
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
	test('nimmt ihn aus dem Plan und gibt die Paarung wieder frei', () => {
		planEinspielen()
		const plan = loescheTermin('2026-08-21', db)
		expect(plan.map((t) => t.date)).not.toContain('2026-08-21')
		expect(() =>
			setzeTermin(
				{ date: '2026-11-06', groups: [key('musterfrau'), key('beispiel')] },
				db,
			),
		).not.toThrow()
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
		expect(termine).toHaveLength(GUELTIGER_PLAN.length)
	})

	test('ergibt eingespielt genau den erwarteten Plan', async () => {
		const { familien, termine } = await putzplanAusDatei(
			FIXTURE,
			'putzplan-import.yaml',
		)
		for (const { key: k, label } of familien) upsertGroup({ key: k, label }, db)
		const plan = ersetzePlan(termine, db)

		expect(plan.map(({ date, groups }) => ({ date, groups }))).toEqual(
			GUELTIGER_PLAN.map(({ date, groups }) => ({
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

	test('lehnt eine Datei ab, die gegen die Planregeln verstoesst', async () => {
		// `putzplan.yaml` enthaelt einen Termin mit nur EINER Familie. Das ist im
		// Schema erlaubt und in der Datenbank nicht — der Import muss das sagen
		// und nicht die Haelfte schreiben.
		const { familien, termine } = await putzplanAusDatei(
			FIXTURE,
			'putzplan.yaml',
		)
		for (const { key: k, label } of familien) upsertGroup({ key: k, label }, db)
		expect(() => ersetzePlan(termine, db)).toThrow(PutzplanVerstoss)
		expect(planLesen(db)).toEqual([])
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
