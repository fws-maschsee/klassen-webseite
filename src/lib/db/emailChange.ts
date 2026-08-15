import { randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { dbTimestamp, openDb } from './index.ts'
import { normalizeEmail } from './mailingLists.ts'
import { getMitglied } from './members.ts'

/**
 * Die Zustelladresse aendern — aber erst nach Bestaetigung.
 *
 * DIE ZUSTELLADRESSE IST NICHT DIE ANMELDEADRESSE. Sie wird beim ersten
 * Anmelden von dort uebernommen und ist danach frei aenderbar. Das ist
 * ausdruecklich gewollt: Anmeldung und Information sind verschiedene Dinge. Wer
 * sich mit der Arbeitsadresse anmeldet, weil dort der Passwortspeicher liegt,
 * will die Elternpost trotzdem privat lesen. Und ein Elternpaar teilt sich oft
 * ein Postfach, meldet sich aber getrennt an.
 *
 * WARUM DIE BESTAETIGUNG: Wohin die Post geht, entscheidet diese eine Angabe.
 * Ohne Bestaetigung koennte jemand die Post einer anderen Familie auf die eigene
 * Adresse umleiten, und der Betroffene merkte es erst daran, dass nichts mehr
 * kommt — Wochen spaeter und ohne Anhaltspunkt, wo es abgeblieben ist. Die Mail
 * geht deshalb an die NEUE Adresse: Bestaetigen kann nur, wer sie wirklich
 * liest.
 *
 * Bis dahin steht die neue Adresse in `email_change_requests` und nirgends
 * sonst — nicht als zweites Feld am Mitglied, wo sie die naechste Abfrage
 * versehentlich mitliest.
 */

/**
 * Wie lange ein Bestaetigungslink gilt. Sieben Tage: lang genug fuer einen
 * Urlaub, kurz genug, dass ein abgefangener Link nicht monatelang scharf
 * bleibt.
 */
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

/**
 * Sieht das ueberhaupt nach einer Adresse aus?
 *
 * Bewusst grob. Eine strenge Pruefung nach RFC 5322 lehnt gueltige Adressen ab,
 * und die eigentliche Pruefung macht ohnehin der Postbote: Wer die
 * Bestaetigungsmail nicht bekommt, bestaetigt nicht, und die Adresse gilt nie.
 */
export const istAdresse = (wert: string): boolean =>
	/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(wert.trim())

const neuerToken = (): string => randomBytes(32).toString('base64url')

/**
 * Fordert eine neue Zustelladresse an. Aendert am Adressbuch NICHTS.
 *
 * Eine bestehende offene Anforderung derselben Person wird dabei verworfen.
 * Sonst waeren zwei Links gleichzeitig scharf, und der aeltere zeigte auf eine
 * Adresse, die sich die Person inzwischen anders ueberlegt hat — ein Klick auf
 * die alte Mail (oder ein Virenscanner, der sie spaet abarbeitet) haette die
 * verworfene Adresse gesetzt.
 */
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

/** Die offene, noch gueltige Anforderung dieser Person — oder `null`. */
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

/** Was zu einem Token gehoert, ohne ihn einzuloesen. Fuer die Anzeige. */
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

/**
 * Loest den Link ein: ab jetzt gilt die neue Adresse.
 *
 * EINMAL BENUTZBAR, und zwar durch den `UPDATE ... WHERE confirmed_at IS NULL`
 * — wer damit eine Zeile aendert, hat den Zuschlag, alle anderen bekommen 0.
 * Eine Pruefung „ist `confirmed_at` gesetzt?" mit anschliessendem Schreiben
 * waere dasselbe mit einer Luecke dazwischen.
 *
 * Die Zeile bleibt danach stehen. Ein zweiter Klick bekommt damit „schon
 * eingeloest" statt „unbekannt" — der Unterschied zwischen „hat geklappt, du
 * hast nur zweimal geklickt" und „da stimmt etwas nicht".
 */
export const bestaetigeAdresswechsel = (
	token: string,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Bestaetigung => {
	const lauf = db.transaction((): Bestaetigung => {
		const zeile = anforderungZuToken(token, db)
		if (!zeile) return { ok: false, grund: 'unknown' }
		if (zeile.confirmed_at) return { ok: false, grund: 'used' }
		// Zeichenvergleich auf dem EINEN Zeitformat dieser Datenbank, siehe
		// `dbTimestamp`. Ein `datetime('now')` gegen eine mit `strftime`
		// geschriebene Spalte hat hier schon einmal 250 Mails aufgehalten.
		if (zeile.expires_at <= dbTimestamp(jetzt)) {
			return { ok: false, grund: 'expired' }
		}

		const zuschlag = db
			.prepare<[string, string]>(
				'UPDATE email_change_requests SET confirmed_at = ? WHERE token = ? AND confirmed_at IS NULL',
			)
			.run(dbTimestamp(jetzt), token)
		if (zuschlag.changes !== 1) return { ok: false, grund: 'used' }

		const mitglied = getMitglied(zeile.mitglied_id, db)
		// Der Eintrag kann in der Zwischenzeit geloescht worden sein (Konto weg,
		// Umzug, Aufraeumen). Dann gibt es nichts zu aendern — und zwar ohne
		// Fehler: Der Mensch am Bildschirm hat nichts falsch gemacht.
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

/**
 * Nimmt die Verteiler-Einstellungen mit zur neuen Adresse.
 *
 * `list_recipient_settings` haengt an der ADRESSE und nicht am Eintrag. Ohne
 * diesen Schritt verlore jeder Adresswechsel still alle Abmeldungen: Wer die
 * Elterndiskussion abbestellt hat, staende am naechsten Tag wieder darin, weil
 * fuer die neue Adresse nichts hinterlegt ist und dann die Vorgabe („dabei")
 * gilt. Das ist genau der Fall, der niemandem auffaellt, bis die Post wieder da
 * ist.
 *
 * `INSERT OR IGNORE` und danach loeschen: Steht fuer die neue Adresse schon
 * etwas, gewinnt das — es ist die juengere, bewusstere Angabe.
 */
const uebertrageEinstellungen = (
	alt: string,
	neu: string,
	db: Database,
): void => {
	if (alt === neu) return
	db.prepare<[string, string]>(
		`INSERT OR IGNORE INTO list_recipient_settings (list_address, email, subscribed, own_mail, updated_at)
       SELECT list_address, ?, subscribed, own_mail, updated_at
         FROM list_recipient_settings WHERE email = ?`,
	).run(neu, alt)
	db.prepare<[string]>(
		'DELETE FROM list_recipient_settings WHERE email = ?',
	).run(alt)
}
