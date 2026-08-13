/**
 * Was jede Adresse von einer Liste bekommt — und die Quittung an die Absenderin.
 *
 * Vier Zustaende, die sich gegenseitig ausschliessen; geprueft wird hier vor
 * allem, was sie fuer die ZUSTELLUNG bedeuten. Ein Fehler an dieser Stelle ist
 * still: Wer faelschlich abgemeldet ist, bekommt keine Fehlermeldung, sondern
 * einfach nichts mehr — und merkt es erst, wenn etwas fehlt.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */
import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import { upsertGroup } from '../../src/lib/db/groups.ts'
import {
	listMailingLists,
	resolveListRecipients,
	upsertMailingList,
} from '../../src/lib/db/mailingLists.ts'
import { upsertMitglied } from '../../src/lib/db/members.ts'
import {
	adresseZuToken,
	einstellungenFuer,
	modusFuer,
	setzeModus,
	tokenFuer,
	VORGABE,
} from '../../src/lib/db/recipientSettings.ts'
import { suppressAddress } from '../../src/lib/db/suppressions.ts'
import { createTestDb } from '../helpers/db.ts'

let db: Database

const liste = () =>
	upsertMailingList(
		{
			address: 'eltern',
			label: 'Eltern',
			recipient_groups: ['eltern'],
			poster_policy: 'offen',
		},
		db,
	)

beforeEach(() => {
	db = createTestDb()
	upsertGroup({ key: 'eltern', label: 'Eltern' }, db)
	for (const [id, vorname, mail] of [
		['vera', 'Vera', 'vera@example.org'],
		['anna', 'Anna', 'anna@example.org'],
	] as const) {
		upsertMitglied(
			{
				id,
				first_name: vorname,
				last_name: 'Beispiel',
				email: mail,
				groups: ['eltern'],
			},
			db,
		)
	}
})

describe('Der Modus einer Adresse', () => {
	test('ohne Eintrag gilt die Vorgabe', () => {
		expect(modusFuer('eltern', 'vera@example.org', db)).toBe(VORGABE)
		expect(VORGABE).toBe('kopie')
	})

	test('wird je Liste gespeichert, nicht je Adresse', () => {
		upsertMailingList(
			{
				address: 'nureltern',
				label: 'Nur Eltern',
				recipient_groups: ['eltern'],
			},
			db,
		)
		liste()
		setzeModus('nureltern', 'vera@example.org', 'abgemeldet', db)

		expect(modusFuer('nureltern', 'vera@example.org', db)).toBe('abgemeldet')
		expect(modusFuer('eltern', 'vera@example.org', db)).toBe('kopie')
	})

	test('gilt unabhaengig von der Schreibweise der Adresse', () => {
		setzeModus('eltern', 'Vera@Example.ORG', 'nichts', db)
		expect(modusFuer('eltern', 'vera@example.org', db)).toBe('nichts')
	})
})

describe('Abgemeldete bekommen keine Post', () => {
	test('fallen aus den Empfaengern heraus', () => {
		const l = liste()
		expect(
			resolveListRecipients(l, db)
				.map((r) => r.email)
				.sort(),
		).toEqual(['anna@example.org', 'vera@example.org'])

		setzeModus('eltern', 'anna@example.org', 'abgemeldet', db)
		expect(resolveListRecipients(l, db).map((r) => r.email)).toEqual([
			'vera@example.org',
		])
	})

	test('die anderen drei Modi aendern an der Zustellung nichts', () => {
		const l = liste()
		for (const modus of ['kopie', 'bestaetigung', 'nichts'] as const) {
			setzeModus('eltern', 'anna@example.org', modus, db)
			expect(resolveListRecipients(l, db)).toHaveLength(2)
		}
	})

	test('eine Sperre bleibt eine Sperre — auch bei "kopie"', () => {
		// Die beiden Ebenen sind getrennt: Was das System festgestellt hat
		// (Bounce), hebt keine Einstellung auf. Sonst holte sich jemand mit einem
		// Klick eine tote Adresse zurueck in den Verteiler.
		const l = liste()
		suppressAddress(
			{ email: 'anna@example.org', list_address: 'eltern', source: 'bounce' },
			db,
		)
		setzeModus('eltern', 'anna@example.org', 'kopie', db)
		expect(resolveListRecipients(l, db).map((r) => r.email)).toEqual([
			'vera@example.org',
		])
	})
})

describe('Der Schluessel der Einstellungsseite', () => {
	test('wird beim ersten Mal gewuerfelt und bleibt danach gleich', () => {
		const erster = tokenFuer('vera@example.org', db)
		expect(erster).toHaveLength(43) // 32 Byte base64url
		expect(tokenFuer('vera@example.org', db)).toBe(erster)
	})

	test('gilt fuer die Adresse, unabhaengig von der Schreibweise', () => {
		const token = tokenFuer('vera@example.org', db)
		expect(tokenFuer('VERA@example.org', db)).toBe(token)
		expect(adresseZuToken(token, db)).toBe('vera@example.org')
	})

	test('zwei Adressen bekommen verschiedene Schluessel', () => {
		expect(tokenFuer('vera@example.org', db)).not.toBe(
			tokenFuer('anna@example.org', db),
		)
	})

	test('ein unbekannter Schluessel fuehrt nirgendwohin', () => {
		expect(adresseZuToken('gibtesnicht', db)).toBeNull()
	})
})

describe('Die Einstellungsseite zeigt alle aktiven Listen', () => {
	test('auch die, von denen jemand abgemeldet ist', () => {
		// Sonst verschwaende die Liste aus der Uebersicht, sobald jemand sie
		// abbestellt — und der Weg zurueck waere weg.
		liste()
		upsertMailingList(
			{
				address: 'nureltern',
				label: 'Nur Eltern',
				recipient_groups: ['eltern'],
			},
			db,
		)
		setzeModus('eltern', 'vera@example.org', 'abgemeldet', db)

		const zeilen = einstellungenFuer(
			'vera@example.org',
			listMailingLists(db),
			db,
		)
		expect(zeilen.map((z) => z.address).sort()).toEqual(['eltern', 'nureltern'])
		expect(zeilen.find((z) => z.address === 'eltern')?.mode).toBe('abgemeldet')
		expect(zeilen.find((z) => z.address === 'nureltern')?.mode).toBe('kopie')
	})

	test('inaktive Listen stehen nicht darauf', () => {
		upsertMailingList(
			{
				address: 'alt',
				label: 'Stillgelegt',
				recipient_groups: ['eltern'],
				aktiv: false,
			},
			db,
		)
		liste()
		const zeilen = einstellungenFuer(
			'vera@example.org',
			listMailingLists(db),
			db,
		)
		expect(zeilen.map((z) => z.address)).toEqual(['eltern'])
	})
})
