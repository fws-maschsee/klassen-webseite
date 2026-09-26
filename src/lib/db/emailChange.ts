import { randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { dbTimestamp, openDb } from './index.ts'
import { normalizeEmail } from './mailingLists.ts'
import { getMitglied } from './members.ts'

// Lang genug für einen Urlaub, kurz genug, dass ein abgefangener Link nicht monatelang gilt.
export const GUELTIGKEIT_SEKUNDEN = 7 * 24 * 60 * 60

export type EmailChangeRequestRow = {
	token: string
	mitglied_id: string
	new_email: string
	created_at: string
	expires_at: string
	confirmed_at: string | null
}

const SPALTEN =
	'token, mitglied_id, new_email, created_at, expires_at, confirmed_at'

// Bewusst grob: RFC-strenge Prüfung lehnt gültige Adressen ab, die Bestätigungsmail prüft ohnehin.
export const istAdresse = (wert: string): boolean =>
	/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(wert.trim())

const neuerToken = (): string => randomBytes(32).toString('base64url')

export const beantrageAdresswechsel = (
	mitgliedId: string,
	neueAdresse: string,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): EmailChangeRequestRow => {
	const mitglied = getMitglied(mitgliedId, db)
	if (!mitglied) {
		throw new Error(`Kein Eintrag im Adressbuch mit id="${mitgliedId}".`)
	}
	const email = normalizeEmail(neueAdresse)
	if (!istAdresse(email)) {
		throw new Error(`"${neueAdresse}" sieht nicht nach einer Mailadresse aus.`)
	}

	const token = neuerToken()
	const lauf = db.transaction((): EmailChangeRequestRow => {
		db.prepare<[string]>(
			// Ältere offene Links verwerfen, sonst setzt ein später Klick (oder Virenscanner) eine verworfene Adresse.
			'DELETE FROM email_change_requests WHERE mitglied_id = ? AND confirmed_at IS NULL',
		).run(mitgliedId)
		db.prepare<[string, string, string, string, string]>(
			`INSERT INTO email_change_requests (token, mitglied_id, new_email, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
		).run(
			token,
			mitgliedId,
			email,
			dbTimestamp(jetzt),
			dbTimestamp(new Date(jetzt.getTime() + GUELTIGKEIT_SEKUNDEN * 1000)),
		)
		const zeile = db
			.prepare<[string], EmailChangeRequestRow>(
				`SELECT ${SPALTEN} FROM email_change_requests WHERE token = ?`,
			)
			.get(token)
		if (!zeile) throw new Error('beantrageAdresswechsel: Zeile verschwunden')
		return zeile
	})
	return lauf()
}

export const offeneAnforderung = (
	mitgliedId: string,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): EmailChangeRequestRow | null =>
	db
		.prepare<[string, string], EmailChangeRequestRow>(
			`SELECT ${SPALTEN} FROM email_change_requests
        WHERE mitglied_id = ? AND confirmed_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`,
		)
		.get(mitgliedId, dbTimestamp(jetzt)) ?? null

export const anforderungZuToken = (
	token: string,
	db: Database = openDb(),
): EmailChangeRequestRow | null =>
	db
		.prepare<[string], EmailChangeRequestRow>(
			`SELECT ${SPALTEN} FROM email_change_requests WHERE token = ?`,
		)
		.get(token) ?? null

export type Bestaetigung =
	| { ok: true; mitgliedId: string; email: string; vorher: string | null }
	| { ok: false; grund: 'unknown' | 'expired' | 'used' }

export const bestaetigeAdresswechsel = (
	token: string,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Bestaetigung => {
	const lauf = db.transaction((): Bestaetigung => {
		const zeile = anforderungZuToken(token, db)
		if (!zeile) return { ok: false, grund: 'unknown' }
		if (zeile.confirmed_at) return { ok: false, grund: 'used' }
		// Zeichenvergleich: funktioniert nur, weil beide Seiten im dbTimestamp-Format stehen.
		if (zeile.expires_at <= dbTimestamp(jetzt)) {
			return { ok: false, grund: 'expired' }
		}

		// Das bedingte UPDATE ist die eigentliche Einmal-Sperre; die Prüfung oben allein hätte eine Lücke.
		const zuschlag = db
			.prepare<[string, string]>(
				'UPDATE email_change_requests SET confirmed_at = ? WHERE token = ? AND confirmed_at IS NULL',
			)
			.run(dbTimestamp(jetzt), token)
		if (zuschlag.changes !== 1) return { ok: false, grund: 'used' }

		const mitglied = getMitglied(zeile.mitglied_id, db)
		if (!mitglied) return { ok: false, grund: 'unknown' }
		const vorher = mitglied.email

		db.prepare<[string, string]>(
			'UPDATE mitglieder SET email = ? WHERE id = ?',
		).run(zeile.new_email, zeile.mitglied_id)

		if (vorher)
			uebertrageEinstellungen(normalizeEmail(vorher), zeile.new_email, db)

		return {
			ok: true,
			mitgliedId: zeile.mitglied_id,
			email: zeile.new_email,
			vorher,
		}
	})
	return lauf()
}

// Einstellungen hängen an der Adresse, ohne Umzug fiele jede Abmeldung still weg.
const uebertrageEinstellungen = (
	alt: string,
	neu: string,
	db: Database,
): void => {
	if (alt === neu) return
	db.prepare<[string, string]>(
		// OR IGNORE: schon vorhandene Angaben der neuen Adresse sind jünger und gewinnen.
		`INSERT OR IGNORE INTO list_recipient_settings (list_address, email, subscribed, own_mail, updated_at)
       SELECT list_address, ?, subscribed, own_mail, updated_at
         FROM list_recipient_settings WHERE email = ?`,
	).run(neu, alt)
	db.prepare<[string]>(
		'DELETE FROM list_recipient_settings WHERE email = ?',
	).run(alt)
}
