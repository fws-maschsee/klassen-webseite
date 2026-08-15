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

/**
 * Der Bezug zwischen Anmeldekonto und Adressbuch-Eintrag.
 *
 * Er sagt „dieses Konto verwaltet diesen Eintrag" — und ausdruecklich NICHT,
 * wer Post bekommt. Das entscheidet die Gruppenzugehoerigkeit, und die setzt
 * ein Mensch. Der wichtigste Test dieser Datei ist deshalb der zweite: Ein bei
 * der Anmeldung entstandener Eintrag steht in KEINER Gruppe.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

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
		// Das Konto ist festgehalten, mit Anmeldeadresse und beiden Zeitpunkten.
		const user = getUser(anna.sub, db)
		expect(user?.login_email).toBe('anna@example.org')
		expect(user?.name).toBe('Anna Beispiel')
		expect(user?.first_seen_at).toBeTruthy()
		expect(user?.last_seen_at).toBeTruthy()

		// Und der Eintrag haengt daran, in beide Richtungen auffindbar.
		expect(mitgliedFuerKonto(anna.sub, db)?.id).toBe(bezug.mitglied.id)
		expect(bezug.mitglied.first_name).toBe('Anna')
		expect(bezug.mitglied.last_name).toBe('Beispiel')
		expect(bezug.mitglied.email).toBe('anna@example.org')
	})

	test('der neue Eintrag landet in KEINER Gruppe', () => {
		// DER Punkt des ganzen Entwurfs. Ein Zugang ist keine
		// Verteilerzugehoerigkeit: Wer Post bekommen soll, wird von einem
		// Menschen in eine Gruppe gesetzt. Waere es anders, haette die Anmeldung
		// eine Nebenwirkung, die niemand bestellt hat — und genau daran ist die
		// alte Spiegelung gescheitert.
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
		// Der haeufige Fall: Die Klassenliste war zuerst da, die Anmeldung kam
		// spaeter. Ein zweiter Eintrag waere eine stille Dublette — und die
		// Gruppen haengen am ersten.
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
		// Die Zugehoerigkeit, die ein Mensch gesetzt hat, bleibt unangetastet.
		expect(getMitgliedGroups('anna-beispiel', db)).toEqual(['eltern'])
	})

	test('ein Eintrag, der schon einem anderen Konto gehoert, wird nicht weggenommen', () => {
		// Zwei Menschen koennen sich ein Postfach teilen. Der Eintrag des einen
		// darf nicht dem anderen zufallen, nur weil er dieselbe Adresse angibt.
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
		// Zwischendurch hat ein Mensch den Eintrag gepflegt. Die Anmeldung darf
		// das nicht ueberschreiben — sie weiss es nicht besser.
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
		// Um drei Uhr nachts entscheidet niemand, ob das dieselbe Person ist. Die
		// Anmeldung darf daran nicht scheitern; entscheiden muss es ein Mensch.
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
		// Ohne diesen Hinweis wartet jemand auf Mail, die nie kommt — er hat sich
		// ja erfolgreich angemeldet und sieht die Seite. Der Hinweis ist damit
		// kein Beiwerk, sondern die Haelfte der Entscheidung, Eintraege ohne
		// Gruppe anzulegen.
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
