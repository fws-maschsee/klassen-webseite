import { randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { openDb } from './index.ts'
import { normalizeEmail } from './mailingLists.ts'
import type { MailingListRow } from './types.ts'

/**
 * Was jede Adresse von einer Liste bekommen moechte — und der Schluessel, mit
 * dem sie das selbst einstellen kann.
 *
 * Vier Zustaende, die sich gegenseitig ausschliessen. Sie sind entlang EINER
 * Frage geordnet: Wie viel will diese Adresse von dieser Liste?
 *
 *   kopie         alles, auch die eigene Mail zurueck. Der Vorgabewert, weil er
 *                 dem entspricht, was ein Verteiler ohne jede Einstellung tut —
 *                 und weil „ich sehe meine eigene Mail ankommen" fuer viele die
 *                 Bestaetigung IST, dass es geklappt hat.
 *   bestaetigung  alles ausser der eigenen Mail; stattdessen eine Quittung,
 *                 sobald die eigene Rundmail zugestellt ist.
 *   nichts        alles ausser der eigenen Mail, ohne Quittung.
 *   abgemeldet    gar keine Post von dieser Liste.
 *
 * Diese Ebene ist NICHT dieselbe wie die Suppressions. Dort steht, was das
 * System festgestellt hat (Bounce, Beschwerde); hier, was ein Mensch will.
 * Beide gelten gleichzeitig: Wer gebounct ist, bekommt auch mit `kopie` nichts.
 */

export const MODI = ['kopie', 'bestaetigung', 'nichts', 'abgemeldet'] as const
export type EmpfangsModus = (typeof MODI)[number]

/** Was gilt, solange niemand etwas eingestellt hat. */
export const VORGABE: EmpfangsModus = 'kopie'

export const istModus = (wert: unknown): wert is EmpfangsModus =>
	typeof wert === 'string' && (MODI as readonly string[]).includes(wert)

type SettingsRow = { list_address: string; email: string; mode: string }

/**
 * Der Modus EINER Adresse fuer EINE Liste. Ohne Eintrag gilt `VORGABE` — die
 * Tabelle enthaelt deshalb nur, was jemand bewusst geaendert hat, und eine neue
 * Adresse braucht keinen Eintrag, um Post zu bekommen.
 */
export const modusFuer = (
	listAddress: string,
	email: string,
	db: Database = openDb(),
): EmpfangsModus => {
	const row = db
		.prepare<[string, string], { mode: string }>(
			'SELECT mode FROM list_recipient_settings WHERE list_address = ? AND email = ?',
		)
		.get(listAddress, normalizeEmail(email))
	return row && istModus(row.mode) ? row.mode : VORGABE
}

/** Alle Adressen einer Liste, die NICHT auf dem Vorgabewert stehen. */
export const modiDerListe = (
	listAddress: string,
	db: Database = openDb(),
): Map<string, EmpfangsModus> => {
	const rows = db
		.prepare<[string], SettingsRow>(
			'SELECT list_address, email, mode FROM list_recipient_settings WHERE list_address = ?',
		)
		.all(listAddress)
	const map = new Map<string, EmpfangsModus>()
	for (const row of rows) {
		if (istModus(row.mode)) map.set(row.email, row.mode)
	}
	return map
}

export const setzeModus = (
	listAddress: string,
	email: string,
	mode: EmpfangsModus,
	db: Database = openDb(),
): void => {
	db.prepare(
		`INSERT INTO list_recipient_settings (list_address, email, mode, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (list_address, email) DO UPDATE SET
       mode       = excluded.mode,
       updated_at = excluded.updated_at`,
	).run(listAddress, normalizeEmail(email), mode)
}

/**
 * Der Schluessel der Einstellungsseite.
 *
 * 32 Byte aus `randomBytes`, base64url — nicht zu erraten und kurz genug, dass
 * er in eine URL passt, ohne umgebrochen zu werden. Ein umgebrochener Link in
 * einer Textmail ist ein toter Link.
 */
const neuerToken = (): string => randomBytes(32).toString('base64url')

/**
 * Holt den Token einer Adresse und legt ihn an, wenn es noch keinen gibt.
 *
 * Er wird nie erneuert. Ein rotierender Token haette jeden Link in jeder schon
 * verschickten Mail entwertet — und genau diese alten Mails sind der Weg, auf
 * dem jemand Monate spaeter aus dem Verteiler herausfindet.
 */
export const tokenFuer = (email: string, db: Database = openDb()): string => {
	const normalisiert = normalizeEmail(email)
	const vorhanden = db
		.prepare<[string], { token: string }>(
			'SELECT token FROM list_settings_tokens WHERE email = ?',
		)
		.get(normalisiert)
	if (vorhanden) return vorhanden.token

	const token = neuerToken()
	db.prepare(
		`INSERT INTO list_settings_tokens (email, token)
     VALUES (?, ?)
     ON CONFLICT (email) DO NOTHING`,
	).run(normalisiert, token)
	// Nach einem Wettlauf gewinnt der zuerst geschriebene Wert; erneut lesen
	// statt den gerade gewuerfelten zurueckgeben.
	return (
		db
			.prepare<[string], { token: string }>(
				'SELECT token FROM list_settings_tokens WHERE email = ?',
			)
			.get(normalisiert)?.token ?? token
	)
}

/** Die Adresse zu einem Token, oder `null`. */
export const adresseZuToken = (
	token: string,
	db: Database = openDb(),
): string | null =>
	db
		.prepare<[string], { email: string }>(
			'SELECT email FROM list_settings_tokens WHERE token = ?',
		)
		.get(token)?.email ?? null

export type ListenEinstellung = {
	address: string
	label: string
	mode: EmpfangsModus
}

/**
 * Was die Einstellungsseite zeigt: jede AKTIVE Liste der Klasse mit dem Modus
 * dieser Adresse.
 *
 * Bewusst ALLE Listen und nicht nur die, auf denen die Adresse steht: Sonst
 * verschwaende eine Liste aus der Uebersicht, sobald jemand sie abbestellt —
 * und der Weg zurueck waere weg.
 *
 * Die Listen kommen als Argument und nicht aus `listMailingLists()`. Das ist
 * kein Geschmack: `mailingLists.ts` braucht `modiDerListe` von hier, um
 * Abgemeldete aus den Empfaengern zu nehmen. Ein gegenseitiger Import waere ein
 * Kreis, und Kreise in ESM gehen so lange gut, bis eines der Module beim Laden
 * etwas aus dem anderen braucht.
 */
export const einstellungenFuer = (
	email: string,
	listen: readonly MailingListRow[],
	db: Database = openDb(),
): ListenEinstellung[] => {
	const normalisiert = normalizeEmail(email)
	return listen
		.filter((list) => list.aktiv === 1)
		.map((list) => ({
			address: list.address,
			label: list.label,
			mode: modusFuer(list.address, normalisiert, db),
		}))
}
