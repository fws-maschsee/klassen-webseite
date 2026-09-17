import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import {
	aendereEintrag,
	aenderePlan,
	darfEintragAendern,
	eintraegeLesen,
	legePlanAn,
	loescheEintrag,
	loescheFaellige,
	loeschePlan,
	offenePlaene,
	planLesen,
	standLesen,
	trageEin,
	VORGABE_AUFBEWAHRUNG_TAGE,
} from '../../src/lib/db/schichten.ts'
import { createTestDb } from '../helpers/db.ts'

/**
 * Schichtplaene: anlegen, eintragen, volle Schichten, wer aendern darf und
 * wann ein Plan von selbst verschwindet. Alle Namen sind frei erfunden.
 */

const JETZT = new Date('2026-09-01T10:00:00.000Z')

let db: Database
beforeEach(() => {
	db = createTestDb()
})

const SCHICHTEN = [
	'16:30 bis 17:30 Uhr',
	'17:30 bis 18:30 Uhr',
	'18:30 bis 19:30 Uhr',
]

const grillschichten = (capacity: number | null = 2) =>
	legePlanAn(
		{
			title: 'Grillschichten',
			event_date: '2026-09-18',
			description: 'Zwei Leute je Schicht',
			shifts: SCHICHTEN,
			capacity,
			created_by: 'admin-sub',
		},
		db,
		JETZT,
	)

describe('Pläne', () => {
	test('anlegen: Schlüssel, Schichten, Vorgabe-Aufbewahrung', () => {
		const plan = grillschichten()
		expect(plan.id).toMatch(/^[A-Za-z0-9_-]{16}$/)
		expect(plan.shifts).toEqual(SCHICHTEN)
		expect(plan.capacity).toBe(2)
		expect(plan.status).toBe('open')
		expect(plan.retention_days).toBe(VORGABE_AUFBEWAHRUNG_TAGE)
		expect(plan.delete_at).toBe('2027-03-17T00:00:00.000Z')
	})

	test('ohne Schichten kein Plan', () => {
		expect(() =>
			legePlanAn({ title: 'Leer', shifts: [] }, db, JETZT),
		).toThrowError(/braucht Schichten/)
	})

	test('ändern: Schichten, Plätze, schliessen', () => {
		const plan = grillschichten()
		const neu = aenderePlan(
			plan.id,
			{ shifts: ['Aufbau', 'Abbau'], capacity: 3, status: 'closed' },
			db,
			JETZT,
		)
		expect(neu.shifts).toEqual(['Aufbau', 'Abbau'])
		expect(neu.capacity).toBe(3)
		expect(neu.status).toBe('closed')
		expect(offenePlaene(db, JETZT)).toEqual([])
	})

	test('fällige Pläne sind weg, auch vor dem Aufräumen', () => {
		const plan = grillschichten()
		const spaeter = new Date('2027-04-01T00:00:00.000Z')
		expect(planLesen(plan.id, db, spaeter)).toBeNull()
		expect(loescheFaellige(db, spaeter)).toBe(1)
		expect(loeschePlan(plan.id, db)).toBe(false)
	})
})

describe('Einträge', () => {
	test('eintragen: Schicht statt Gegenstand, Bemerkung optional', () => {
		const plan = grillschichten()
		const e = trageEin(
			plan.id,
			{
				name: 'Familie Muster',
				shift: SCHICHTEN[1] ?? '',
				note: 'kommt später',
			},
			{},
			db,
			JETZT,
		)
		expect(e.shift).toBe(SCHICHTEN[1])
		expect(e.note).toBe('kommt später')
		expect(e.edit_token).toHaveLength(24)
		expect(eintraegeLesen(plan.id, db)).toHaveLength(1)
	})

	test('ohne Schicht geht nichts, unbekannte Schicht auch nicht', () => {
		const plan = grillschichten()
		expect(() =>
			trageEin(plan.id, { name: 'A', shift: '' }, {}, db, JETZT),
		).toThrowError(/Schicht auswählen/)
		expect(() =>
			trageEin(plan.id, { name: 'A', shift: 'Mitternacht' }, {}, db, JETZT),
		).toThrowError(/Unbekannte Schicht/)
	})

	test('volle Schicht nimmt niemanden mehr — ein admin schon', () => {
		const plan = grillschichten(2)
		const schicht = SCHICHTEN[0] ?? ''
		trageEin(plan.id, { name: 'A', shift: schicht }, {}, db, JETZT)
		trageEin(plan.id, { name: 'B', shift: schicht }, {}, db, JETZT)
		expect(() =>
			trageEin(plan.id, { name: 'C', shift: schicht }, {}, db, JETZT),
		).toThrowError(/ist voll/)
		expect(
			trageEin(
				plan.id,
				{ name: 'C', shift: schicht },
				{ admin: true },
				db,
				JETZT,
			).name,
		).toBe('C')
	})

	test('ohne capacity passen beliebig viele hinein', () => {
		const plan = grillschichten(null)
		const schicht = SCHICHTEN[0] ?? ''
		for (const name of ['A', 'B', 'C', 'D'])
			trageEin(plan.id, { name, shift: schicht }, {}, db, JETZT)
		expect(eintraegeLesen(plan.id, db)).toHaveLength(4)
	})

	test('eigenen Eintrag ändern darf, wer den Schlüssel hat — sonst niemand', () => {
		const plan = grillschichten()
		const e = trageEin(
			plan.id,
			{ name: 'Familie Muster', shift: SCHICHTEN[0] ?? '' },
			{},
			db,
			JETZT,
		)
		expect(darfEintragAendern(e, { editToken: e.edit_token })).toBe(true)
		expect(darfEintragAendern(e, { editToken: 'falsch' })).toBe(false)
		expect(darfEintragAendern(e, { admin: true })).toBe(true)
		const geaendert = aendereEintrag(
			e.id,
			{ shift: SCHICHTEN[2] ?? '' },
			{ editToken: e.edit_token },
			db,
			JETZT,
		)
		expect(geaendert.shift).toBe(SCHICHTEN[2])
		expect(() =>
			aendereEintrag(e.id, { name: 'X' }, {}, db, JETZT),
		).toThrowError(/nicht ändern/)
		expect(loescheEintrag(e.id, { admin: true }, db, JETZT)).toBe(true)
	})

	test('geschlossener Plan nimmt nichts mehr an', () => {
		const plan = grillschichten()
		aenderePlan(plan.id, { status: 'closed' }, db, JETZT)
		expect(() =>
			trageEin(
				plan.id,
				{ name: 'A', shift: SCHICHTEN[0] ?? '' },
				{},
				db,
				JETZT,
			),
		).toThrowError(/geschlossen/)
	})
})

describe('Stand für die Seite', () => {
	test('zählt je Schicht und sagt, welche voll ist', () => {
		const plan = grillschichten(2)
		const schicht = SCHICHTEN[0] ?? ''
		trageEin(plan.id, { name: 'A', shift: schicht }, {}, db, JETZT)
		trageEin(plan.id, { name: 'B', shift: schicht }, {}, db, JETZT)
		const stand = standLesen(plan.id, db, JETZT)
		expect(stand?.counts).toEqual([
			{ shift: SCHICHTEN[0], count: 2, full: true },
			{ shift: SCHICHTEN[1], count: 0, full: false },
			{ shift: SCHICHTEN[2], count: 0, full: false },
		])
		// owner_sub verlaesst den Server nie.
		expect(stand?.entries[0]).not.toHaveProperty('owner_sub')
		expect(stand?.list.revision).toBe(2)
	})
})
