import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import { upsertGroup } from '../../src/lib/db/groups.ts'
import {
	getMitglied,
	getMitgliedGroups,
	listMitglieder,
	upsertMitglied,
} from '../../src/lib/db/members.ts'
import {
	getUser,
	merkeAnmeldung,
	mitgliedFuerKonto,
	nameZerlegen,
	ohneGruppe,
} from '../../src/lib/db/users.ts'
import { createTestDb } from '../helpers/db.ts'

let db: Database

beforeEach(() => {
	db = createTestDb()
	upsertGroup({ key: 'eltern', label: 'Elternschaft' }, db)
})

const anna = {
	sub: '299834712',
	email: 'anna@example.org',
	name: 'Anna Beispiel',
}

describe('Der Bezug entsteht bei der Anmeldung', () => {
	test('ein Konto ohne passenden Eintrag bekommt einen — und der Bezug steht', () => {
		const bezug = merkeAnmeldung(anna, db)

		expect(bezug.art).toBe('created')
		const user = getUser(anna.sub, db)
		expect(user?.login_email).toBe('anna@example.org')
		expect(user?.name).toBe('Anna Beispiel')
		expect(user?.first_seen_at).toBeTruthy()
		expect(user?.last_seen_at).toBeTruthy()

		expect(mitgliedFuerKonto(anna.sub, db)?.id).toBe(bezug.mitglied.id)
		expect(bezug.mitglied.first_name).toBe('Anna')
		expect(bezug.mitglied.last_name).toBe('Beispiel')
		expect(bezug.mitglied.email).toBe('anna@example.org')
	})

	test('der neue Eintrag landet in KEINER Gruppe', () => {
		const bezug = merkeAnmeldung(anna, db)

		expect(getMitgliedGroups(bezug.mitglied.id, db)).toEqual([])
		expect(ohneGruppe(bezug.mitglied.id, db)).toBe(true)
		expect(
			db
				.prepare<[], { anzahl: number }>(
					'SELECT COUNT(*) AS anzahl FROM group_memberships',
				)
				.get()?.anzahl,
		).toBe(0)
	})

	test('ein vorhandener Eintrag mit derselben Adresse wird uebernommen, nicht verdoppelt', () => {
		upsertMitglied(
			{
				id: 'anna-beispiel',
				first_name: 'Anna',
				last_name: 'Beispiel',
				email: 'Anna@Example.org',
				groups: ['eltern'],
			},
			db,
		)

		const bezug = merkeAnmeldung(anna, db)

		expect(bezug.art).toBe('linked')
		expect(bezug.mitglied.id).toBe('anna-beispiel')
		expect(listMitglieder(db)).toHaveLength(1)
		expect(getMitgliedGroups('anna-beispiel', db)).toEqual(['eltern'])
	})

	test('ein Eintrag, der schon einem anderen Konto gehoert, wird nicht weggenommen', () => {
		merkeAnmeldung(anna, db)
		const zweiter = merkeAnmeldung(
			{ sub: '400000001', email: 'anna@example.org', name: 'Bernd Beispiel' },
			db,
		)

		expect(zweiter.art).toBe('created')
		expect(zweiter.mitglied.id).not.toBe('anna-beispiel')
		expect(mitgliedFuerKonto(anna.sub, db)?.id).toBe('anna-beispiel')
		expect(listMitglieder(db)).toHaveLength(2)
	})

	test('die zweite Anmeldung aendert nichts und zieht nur „zuletzt gesehen" nach', () => {
		const erst = new Date('2026-08-01T08:00:00.000Z')
		const spaet = new Date('2026-08-15T09:00:00.000Z')
		merkeAnmeldung(anna, db, erst)
		upsertMitglied(
			{ id: 'anna-beispiel', first_name: 'Anna', last_name: 'Beispiel-Neu' },
			db,
		)

		const zweite = merkeAnmeldung(anna, db, spaet)

		expect(zweite.art).toBe('kept')
		expect(getMitglied('anna-beispiel', db)?.last_name).toBe('Beispiel-Neu')
		const user = getUser(anna.sub, db)
		expect(user?.first_seen_at).toBe(erst.toISOString())
		expect(user?.last_seen_at).toBe(spaet.toISOString())
	})

	test('Namensgleichheit gibt einen freien Schluessel statt eines Fehlers', () => {
		upsertMitglied(
			{
				first_name: 'Anna',
				last_name: 'Beispiel',
				email: 'andere@example.org',
			},
			db,
		)
		const bezug = merkeAnmeldung(anna, db)
		expect(bezug.mitglied.id).toBe('anna-beispiel-2')
	})
})

describe('Namen zerlegen', () => {
	test('am letzten Leerzeichen, und ohne Namen bleibt der Localpart', () => {
		expect(nameZerlegen('Anna Maria Beispiel', 'a@example.org')).toEqual({
			first_name: 'Anna Maria',
			last_name: 'Beispiel',
		})
		expect(nameZerlegen('', 'vera@example.org')).toEqual({
			first_name: 'vera',
			last_name: '',
		})
	})
})

describe('Die Seite sagt es der Person', () => {
	test('/einstellungen erklaert, dass ohne Gruppe keine Post kommt', () => {
		const seite = fs.readFileSync(
			fileURLToPath(
				new URL('../../astro/pages/einstellungen/index.astro', import.meta.url),
			),
			'utf-8',
		)
		expect(seite).toContain('ohneGruppe')
		expect(seite).toMatch(/keiner Gruppe/)
		expect(seite).toMatch(/noch keine Post/)
	})
})
