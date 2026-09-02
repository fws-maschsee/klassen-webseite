import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import {
	aendereEintrag,
	aendereListe,
	berechneLoeschzeit,
	darfEintragAendern,
	eintraegeLesen,
	legeListeAn,
	listeLesen,
	listenLesen,
	loescheEintrag,
	loescheFaellige,
	loescheListe,
	offeneListen,
	standLesen,
	trageEin,
	VORGABE_AUFBEWAHRUNG_TAGE,
} from '../../src/lib/db/mitbringen.ts'
import { createTestDb } from '../helpers/db.ts'

/**
 * Mitbringlisten in der Datenbank: anlegen, eintragen, wer was aendern darf,
 * und wann eine Liste von selbst verschwindet.
 *
 * Alle Namen sind frei erfunden.
 */

const JETZT = new Date('2026-09-01T10:00:00.000Z')
const TAG = 24 * 60 * 60 * 1000

let db: Database
beforeEach(() => {
	db = createTestDb()
})

const grillfest = () =>
	legeListeAn(
		{
			title: 'Grillfest 2026',
			event_date: '2026-09-12',
			description: 'Ab 15 Uhr auf der Wiese',
			categories: ['Salat', 'Grillgut', 'Getränke'],
			created_by: 'admin-sub',
		},
		db,
		JETZT,
	)

describe('Listen', () => {
	test('anlegen: nicht erratbarer Schlüssel, Vorgabe-Aufbewahrung, Loeschzeit ab Datum', () => {
		const liste = grillfest()
		expect(liste.id).toMatch(/^[A-Za-z0-9_-]{16}$/)
		expect(liste.status).toBe('open')
		expect(liste.retention_days).toBe(VORGABE_AUFBEWAHRUNG_TAGE)
		expect(liste.categories).toEqual(['Salat', 'Grillgut', 'Getränke'])
		expect(liste.delete_at).toBe(
			berechneLoeschzeit('2026-09-12', VORGABE_AUFBEWAHRUNG_TAGE, JETZT),
		)
		expect(liste.delete_at).toBe('2027-03-11T00:00:00.000Z')
		expect(listeLesen(liste.id, db, JETZT)?.title).toBe('Grillfest 2026')
	})

	test('ohne Datum zaehlt die Aufbewahrung ab dem Anlegen', () => {
		const liste = legeListeAn(
			{ title: 'Spontan', retention_days: 10 },
			db,
			JETZT,
		)
		expect(liste.delete_at).toBe(
			new Date(JETZT.getTime() + 10 * TAG).toISOString(),
		)
	})

	test('Titel ist Pflicht, Datum muss JJJJ-MM-TT sein, Aufbewahrung mindestens ein Tag', () => {
		expect(() => legeListeAn({ title: '  ' }, db)).toThrow(/Titel/)
		expect(() =>
			legeListeAn({ title: 'x', event_date: '12.09.2026' }, db),
		).toThrow(/JJJJ-MM-TT/)
		expect(() => legeListeAn({ title: 'x', retention_days: 0 }, db)).toThrow(
			/mindestens 1/,
		)
	})

	test('ändern: Aufbewahrung einstellbar, neues Datum verschiebt die Loeschzeit, schliessen sperrt', () => {
		const liste = grillfest()
		const neu = aendereListe(
			liste.id,
			{ event_date: '2026-10-01', retention_days: 30, status: 'closed' },
			db,
			JETZT,
		)
		expect(neu.delete_at).toBe('2026-10-31T00:00:00.000Z')
		expect(neu.status).toBe('closed')
		expect(neu.revision).toBe(liste.revision + 1)
		expect(offeneListen(db, JETZT)).toHaveLength(0)
		expect(() =>
			trageEin(liste.id, { name: 'Muster', item: 'Brot' }, {}, db, JETZT),
		).toThrow(/geschlossen/)
		// ein admin darf trotzdem
		expect(
			trageEin(
				liste.id,
				{ name: 'Muster', item: 'Brot' },
				{ admin: true },
				db,
				JETZT,
			).item,
		).toBe('Brot')
	})

	test('faellige Listen sind sofort unsichtbar und werden mit Einträgen abgeraeumt', () => {
		const liste = legeListeAn(
			{ title: 'Alt', event_date: '2026-01-10', retention_days: 5 },
			db,
			JETZT,
		)
		trageEin(
			liste.id,
			{ name: 'Muster', item: 'Kuchen' },
			{},
			db,
			new Date('2026-01-01T00:00:00Z'),
		)
		expect(listeLesen(liste.id, db, JETZT)).toBeNull()
		expect(listenLesen(db, JETZT)).toHaveLength(0)
		expect(standLesen(liste.id, db, JETZT)).toBeNull()
		expect(loescheFaellige(db, JETZT)).toBe(1)
		expect(db.prepare('SELECT COUNT(*) AS n FROM bring_entries').get()).toEqual(
			{ n: 0 },
		)
		expect(loescheFaellige(db, JETZT)).toBe(0)
	})

	test('löschen nimmt die Einträge mit', () => {
		const liste = grillfest()
		trageEin(
			liste.id,
			{ name: 'Muster', item: 'Nudelsalat', category: 'Salat' },
			{},
			db,
			JETZT,
		)
		expect(loescheListe(liste.id, db)).toBe(true)
		expect(db.prepare('SELECT COUNT(*) AS n FROM bring_entries').get()).toEqual(
			{ n: 0 },
		)
	})
})

describe('Einträge', () => {
	test('eintragen: Zaehler steigt, Stand zaehlt je Kategorie — auch die Luecke', () => {
		const liste = grillfest()
		const e = trageEin(
			liste.id,
			{
				name: 'Familie Muster',
				item: 'Nudelsalat',
				category: 'Salat',
				amount: 'für 10',
			},
			{},
			db,
			JETZT,
		)
		expect(e.edit_token).toHaveLength(24)
		expect(e.owner_sub).toBeNull()
		const stand = standLesen(liste.id, db, JETZT)
		expect(stand?.list.revision).toBe(1)
		expect(stand?.counts).toEqual([
			{ category: 'Salat', count: 1 },
			{ category: 'Grillgut', count: 0 },
			{ category: 'Getränke', count: 0 },
		])
		// weder owner_sub noch edit_token gehen an die Seite
		expect(Object.keys(stand?.entries[0] ?? {})).not.toContain('owner_sub')
		expect(Object.keys(stand?.entries[0] ?? {})).not.toContain('edit_token')
	})

	test('Pflichtfelder und Kategorien werden geprueft', () => {
		const liste = grillfest()
		expect(() => trageEin(liste.id, { name: '', item: 'x' }, {}, db)).toThrow(
			/Namen/,
		)
		expect(() => trageEin(liste.id, { name: 'x', item: ' ' }, {}, db)).toThrow(
			/mitgebracht/,
		)
		expect(() =>
			trageEin(liste.id, { name: 'x', item: 'y', category: 'Kuchen' }, {}, db),
		).toThrow(/Unbekannte Kategorie/)
		expect(() =>
			trageEin('gibt-es-nicht', { name: 'x', item: 'y' }, {}, db),
		).toThrow(/gibt es nicht/)
	})

	test('wer ändern darf: Ersteller per Konto, Gast per Schlüssel, admin immer — sonst niemand', () => {
		const liste = grillfest()
		const gast = trageEin(
			liste.id,
			{ name: 'Gast', item: 'Brot' },
			{},
			db,
			JETZT,
		)
		const konto = trageEin(
			liste.id,
			{ name: 'Konto', item: 'Kaese' },
			{ sub: 'sub-a' },
			db,
			JETZT,
		)
		expect(konto.owner_sub).toBe('sub-a')

		expect(darfEintragAendern(gast, { editToken: gast.edit_token })).toBe(true)
		expect(darfEintragAendern(gast, { editToken: 'falsch' })).toBe(false)
		expect(darfEintragAendern(gast, { sub: 'sub-a' })).toBe(false)
		expect(darfEintragAendern(konto, { sub: 'sub-a' })).toBe(true)
		expect(darfEintragAendern(konto, { sub: 'sub-b' })).toBe(false)
		expect(darfEintragAendern(konto, { admin: true })).toBe(true)

		expect(() =>
			aendereEintrag(
				gast.id,
				{ item: 'Baguette' },
				{ sub: 'sub-a' },
				db,
				JETZT,
			),
		).toThrow(/nicht ändern/)
		expect(
			aendereEintrag(
				gast.id,
				{ item: 'Baguette' },
				{ editToken: gast.edit_token },
				db,
				JETZT,
			).item,
		).toBe('Baguette')
		expect(() => loescheEintrag(konto.id, { sub: 'sub-b' }, db, JETZT)).toThrow(
			/nicht löschen/,
		)
		expect(loescheEintrag(konto.id, { admin: true }, db, JETZT)).toBe(true)
		expect(eintraegeLesen(liste.id, db)).toHaveLength(1)
		expect(listeLesen(liste.id, db, JETZT)?.revision).toBe(4)
	})
})
