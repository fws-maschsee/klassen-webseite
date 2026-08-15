import type { Database } from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'
import {
	anforderungZuToken,
	beantrageAdresswechsel,
	bestaetigeAdresswechsel,
	GUELTIGKEIT_SEKUNDEN,
	offeneAnforderung,
} from '../../src/lib/db/emailChange.ts'
import { getMitglied, upsertMitglied } from '../../src/lib/db/members.ts'
import {
	einstellungFuer,
	setzeEinstellung,
} from '../../src/lib/db/recipientSettings.ts'
import { merkeAnmeldung } from '../../src/lib/db/users.ts'
import { buildBestaetigung } from '../../src/lib/email/adresswechsel.ts'
import { createTestDb } from '../helpers/db.ts'

/**
 * Die Zustelladresse aendert sich erst nach Bestaetigung — und die Mail dafuer
 * geht an die NEUE Adresse.
 *
 * Ohne diesen Schritt koennte jemand die Post einer anderen Familie auf die
 * eigene Adresse umleiten, und die Betroffenen merkten es erst daran, dass
 * nichts mehr kommt. Diese Datei prueft die drei Faelle, in denen ein Link
 * NICHT wirken darf: unbekannt, abgelaufen, schon benutzt.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

let db: Database
const JETZT = new Date('2026-08-15T10:00:00.000Z')
const spaeter = (sekunden: number): Date =>
	new Date(JETZT.getTime() + sekunden * 1000)

beforeEach(() => {
	db = createTestDb()
	upsertMitglied(
		{
			id: 'vera-beispiel',
			first_name: 'Vera',
			last_name: 'Beispiel',
			email: 'vera@example.org',
		},
		db,
	)
})

describe('Adressaenderung', () => {
	test('die Anforderung allein aendert am Adressbuch nichts', () => {
		const anforderung = beantrageAdresswechsel(
			'vera-beispiel',
			'Vera.Privat@Example.org',
			db,
			JETZT,
		)

		// Normalisiert gespeichert, aber eben NUR in der eigenen Tabelle.
		expect(anforderung.new_email).toBe('vera.privat@example.org')
		expect(getMitglied('vera-beispiel', db)?.email).toBe('vera@example.org')
		expect(offeneAnforderung('vera-beispiel', db, JETZT)?.token).toBe(
			anforderung.token,
		)
	})

	test('erst die Bestaetigung setzt die neue Adresse', () => {
		const { token } = beantrageAdresswechsel(
			'vera-beispiel',
			'vera.privat@example.org',
			db,
			JETZT,
		)

		const ergebnis = bestaetigeAdresswechsel(token, db, spaeter(60))

		expect(ergebnis).toEqual({
			ok: true,
			mitgliedId: 'vera-beispiel',
			email: 'vera.privat@example.org',
			vorher: 'vera@example.org',
		})
		expect(getMitglied('vera-beispiel', db)?.email).toBe(
			'vera.privat@example.org',
		)
	})

	test('ein abgelaufener Link wirkt nicht', () => {
		const { token } = beantrageAdresswechsel(
			'vera-beispiel',
			'vera.privat@example.org',
			db,
			JETZT,
		)

		// Eine Sekunde nach Ablauf. Die Grenze selbst ist kein Sonderfall, den man
		// erraten muesste: `expires_at <= jetzt` heisst vorbei.
		const ergebnis = bestaetigeAdresswechsel(
			token,
			db,
			spaeter(GUELTIGKEIT_SEKUNDEN + 1),
		)

		expect(ergebnis).toEqual({ ok: false, grund: 'expired' })
		expect(getMitglied('vera-beispiel', db)?.email).toBe('vera@example.org')
		// Und er bleibt tot, auch wenn jemand es sofort noch einmal versucht.
		expect(anforderungZuToken(token, db)?.confirmed_at).toBeNull()
	})

	test('ein zweites Mal wirkt derselbe Link nicht — auch nicht auf eine inzwischen andere Adresse', () => {
		const { token } = beantrageAdresswechsel(
			'vera-beispiel',
			'vera.privat@example.org',
			db,
			JETZT,
		)
		bestaetigeAdresswechsel(token, db, spaeter(60))

		// Zwischendurch zieht die Person weiter. Ein wiederverwendbarer Link waere
		// jetzt eine Zeitmaschine: Er setzte die Adresse auf einen Stand zurueck,
		// den niemand mehr will.
		const zweiter = beantrageAdresswechsel(
			'vera-beispiel',
			'vera@neu.example.org',
			db,
			spaeter(120),
		)
		bestaetigeAdresswechsel(zweiter.token, db, spaeter(180))

		expect(bestaetigeAdresswechsel(token, db, spaeter(240))).toEqual({
			ok: false,
			grund: 'used',
		})
		expect(getMitglied('vera-beispiel', db)?.email).toBe('vera@neu.example.org')
	})

	test('ein unbekannter Schluessel wirkt nicht', () => {
		expect(bestaetigeAdresswechsel('gibtsnicht', db, JETZT)).toEqual({
			ok: false,
			grund: 'unknown',
		})
		expect(getMitglied('vera-beispiel', db)?.email).toBe('vera@example.org')
	})

	test('eine neue Anforderung entwertet die alte', () => {
		// Sonst waeren zwei Links gleichzeitig scharf, und der aeltere zeigte auf
		// eine Adresse, die sich die Person anders ueberlegt hat.
		const alt = beantrageAdresswechsel(
			'vera-beispiel',
			'falsch@example.org',
			db,
			JETZT,
		)
		beantrageAdresswechsel('vera-beispiel', 'richtig@example.org', db, JETZT)

		expect(bestaetigeAdresswechsel(alt.token, db, spaeter(60))).toEqual({
			ok: false,
			grund: 'unknown',
		})
		expect(getMitglied('vera-beispiel', db)?.email).toBe('vera@example.org')
	})

	test('offensichtlicher Unsinn kommt gar nicht erst in die Tabelle', () => {
		expect(() =>
			beantrageAdresswechsel('vera-beispiel', 'kein-at-zeichen', db, JETZT),
		).toThrow(/Mailadresse/)
		expect(offeneAnforderung('vera-beispiel', db, JETZT)).toBeNull()
	})

	test('die Verteiler-Einstellungen ziehen mit zur neuen Adresse', () => {
		// Sie haengen an der ADRESSE. Ohne diesen Schritt staende, wer die
		// Elterndiskussion abbestellt hat, nach einem Umzug wieder darin — weil
		// fuer die neue Adresse nichts hinterlegt ist und dann die Vorgabe gilt.
		setzeEinstellung(
			'eltern',
			'vera@example.org',
			{ subscribed: false, ownMail: 'none' },
			db,
		)

		const { token } = beantrageAdresswechsel(
			'vera-beispiel',
			'vera.privat@example.org',
			db,
			JETZT,
		)
		bestaetigeAdresswechsel(token, db, spaeter(60))

		expect(einstellungFuer('eltern', 'vera.privat@example.org', db)).toEqual({
			subscribed: false,
			ownMail: 'none',
		})
		// Und an der alten Adresse haengt nichts mehr.
		expect(einstellungFuer('eltern', 'vera@example.org', db)).toEqual({
			subscribed: true,
			ownMail: 'copy',
		})
	})

	test('der Bezug zum Konto ueberlebt den Adresswechsel', () => {
		// Die Anmeldeadresse und die Zustelladresse duerfen auseinanderlaufen —
		// genau das ist der Zweck. Der Bezug haengt am `sub` und nicht an der
		// Adresse, sonst waere er nach dem ersten Wechsel weg.
		const bezug = merkeAnmeldung(
			{ sub: '299834712', email: 'vera@example.org', name: 'Vera Beispiel' },
			db,
		)
		expect(bezug.art).toBe('linked')

		const { token } = beantrageAdresswechsel(
			bezug.mitglied.id,
			'vera.privat@example.org',
			db,
			JETZT,
		)
		bestaetigeAdresswechsel(token, db, spaeter(60))

		const spaeterBezug = merkeAnmeldung(
			{ sub: '299834712', email: 'vera@example.org', name: 'Vera Beispiel' },
			db,
		)
		expect(spaeterBezug.art).toBe('kept')
		expect(spaeterBezug.mitglied.email).toBe('vera.privat@example.org')
	})
})

describe('Die Bestaetigungsmail', () => {
	test('nennt die neue Adresse, den Link und den Weg des Nichtstuns', () => {
		const { subject, text } = buildBestaetigung(
			'vera.privat@example.org',
			'abc123',
			7,
		)
		expect(subject).toContain('bestätigen')
		expect(text).toContain('vera.privat@example.org')
		expect(text).toContain('/public/adresse-bestaetigen/abc123')
		// Wer die Mail unerwartet bekommt, muss lesen koennen, dass Nichtstun
		// genuegt — sonst klickt er aus Unsicherheit.
		expect(text).toMatch(/nicht warst, brauchst du nichts zu tun/)
	})
})
