import { describe, expect, it } from 'vitest'
import { listChildGroups, listGroups } from '../../src/lib/db/groups.ts'
import { listMailingLists } from '../../src/lib/db/mailingLists.ts'
import { listMitglieder } from '../../src/lib/db/members.ts'
import { planLesen } from '../../src/lib/db/putzplan.ts'
import {
	abweichungGegenFrisch,
	seedDemoData,
} from '../../src/lib/db/saatdaten.ts'
import { createTestDb } from '../helpers/db.ts'

describe('Saatdaten fuer die Vorschau', () => {
	it('befuellt eine frisch migrierte Datenbank', () => {
		const db = createTestDb()

		const ergebnis = seedDemoData(db)

		expect(ergebnis.gesaet).toBe(true)
		expect(ergebnis.familien).toBe(10)
		expect(listMitglieder(db).length).toBe(ergebnis.mitglieder)
		expect(listMailingLists(db).length).toBe(2)
	})

	it('erkennt eine frisch migrierte Datenbank trotz der Systemgruppe `eltern`', () => {
		const db = createTestDb()

		expect(abweichungGegenFrisch(db)).toBeNull()
	})

	it('laesst eine Datenbank mit einer einzigen Person unberuehrt', () => {
		const db = createTestDb()
		db.prepare(
			"INSERT INTO mitglieder (id, first_name, last_name, email) VALUES ('echt-person', 'Echte', 'Person', 'echt@example.org')",
		).run()

		const ergebnis = seedDemoData(db)

		expect(ergebnis.gesaet).toBe(false)
		expect(ergebnis.grund?.tabelle).toBe('mitglieder')
		expect(listMitglieder(db).map((m) => m.id)).toEqual(['echt-person'])
	})

	it('laesst eine Datenbank unberuehrt, die schon eine Instanz kennt', () => {
		const db = createTestDb()
		db.prepare(
			"INSERT INTO app_meta (key, value) VALUES ('instance', 'klasse-wiesen')",
		).run()

		const ergebnis = seedDemoData(db)

		expect(ergebnis.gesaet).toBe(false)
		expect(ergebnis.grund?.tabelle).toBe('app_meta')
		expect(listMitglieder(db)).toEqual([])
	})

	it('saet kein zweites Mal — der zweite Lauf findet Inhalt vor', () => {
		const db = createTestDb()

		expect(seedDemoData(db).gesaet).toBe(true)
		const nachher = listMitglieder(db).length

		expect(seedDemoData(db).gesaet).toBe(false)
		expect(listMitglieder(db).length).toBe(nachher)
	})

	it('erzeugt einen vollstaendigen Putzplan', () => {
		const db = createTestDb()

		seedDemoData(db)

		const plan = planLesen(db)
		expect(plan.length).toBe(12)
		for (const termin of plan) {
			expect(termin.groups.length).toBeGreaterThan(0)
		}
	})

	it('benutzt ausschliesslich erfundene Adressen auf example.org', () => {
		const db = createTestDb()

		seedDemoData(db)

		const adressen = listMitglieder(db)
			.map((m) => m.email)
			.filter((mail): mail is string => mail !== null)
		expect(adressen.length).toBeGreaterThan(0)
		for (const adresse of adressen) {
			expect(adresse.endsWith('@example.org')).toBe(true)
		}
	})

	it('haengt jede Familiengruppe unter `eltern`', () => {
		const db = createTestDb()

		seedDemoData(db)

		const familien = listGroups(db)
			.map((g) => g.key)
			.filter((key) => key.startsWith('familie-'))
		expect(familien.length).toBe(10)
		expect(listChildGroups('eltern', db).sort()).toEqual(familien.sort())
	})

	it('legt die Putztermine in die Zukunft', () => {
		const db = createTestDb()
		const jetzt = new Date('2026-08-16T12:00:00.000Z')

		seedDemoData(db, jetzt)

		const termine = planLesen(db)
		expect(termine[0]?.date).toBe('2026-08-21')
		for (const termin of termine) {
			expect(termin.date > '2026-08-16').toBe(true)
		}
	})
})
