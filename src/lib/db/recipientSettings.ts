import { randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { openDb } from './index.ts'
import { normalizeEmail } from './mailingLists.ts'
import type { MailingListRow } from './types.ts'

/**
 * Was eine Adresse von einer Liste bekommt — ZWEI voneinander unabhängige
 * Fragen, und genau deshalb zwei Felder:
 *
 *   subscribed   Bekomme ich die Post dieses Verteilers?     an / aus
 *   ownMail      Was passiert mit MEINER eigenen Nachricht,
 *                wenn ich an den Verteiler schreibe?         kopie /
 *                                                            bestaetigung /
 *                                                            nichts
 *
 * Anfangs war das EIN Feld mit vier Werten, `abgemeldet` als vierter. Das war
 * falsch, und zwar nicht bloß in der Darstellung: Wer abgemeldet ist, darf
 * weiter an den Verteiler SCHREIBEN — und gerade dann ist die Quittung
 * nützlich, weil er das Ergebnis sonst nirgends zu sehen bekommt. In einem Feld
 * hätte er sie nicht einstellen können. Außerdem verlor jede Abmeldung die
 * Versand-Einstellung, sodass ein Wiederanmelden bei der Vorgabe anfing.
 *
 * Diese Ebene ist NICHT dieselbe wie die Suppressions. Dort steht, was das
 * System festgestellt hat (Bounce, Beschwerde); hier, was ein Mensch will.
 * Beide gelten gleichzeitig: Wer gebounct ist, bekommt auch mit `subscribed`
 * nichts.
 */

/** Was mit der eigenen Nachricht passiert, wenn man an die Liste schreibt. */
export const EIGENE_POST = ['kopie', 'bestaetigung', 'nichts'] as const
export type EigenePost = (typeof EIGENE_POST)[number]

/** Was gilt, solange niemand etwas eingestellt hat. */
export const VORGABE: Einstellung = { subscribed: true, ownMail: 'kopie' }

export type Einstellung = {
	/** Bekommt diese Adresse die Post des Verteilers? */
	subscribed: boolean
	/** Was mit der eigenen Nachricht geschieht. */
	ownMail: EigenePost
}

export const istEigenePost = (wert: unknown): wert is EigenePost =>
	typeof wert === 'string' && (EIGENE_POST as readonly string[]).includes(wert)

type SettingsRow = { email: string; subscribed: number; own_mail: string }

const ausZeile = (row: SettingsRow): Einstellung => ({
	subscribed: row.subscribed === 1,
	ownMail: istEigenePost(row.own_mail) ? row.own_mail : VORGABE.ownMail,
})

/**
 * Die Einstellung EINER Adresse für EINE Liste. Ohne Eintrag gilt `VORGABE` —
 * die Tabelle enthält deshalb nur, was jemand bewusst geändert hat, und eine
 * neue Adresse braucht keinen Eintrag, um Post zu bekommen.
 */
export const einstellungFuer = (
	listAddress: string,
	email: string,
	db: Database = openDb(),
): Einstellung => {
	const row = db
		.prepare<[string, string], SettingsRow>(
			'SELECT email, subscribed, own_mail FROM list_recipient_settings WHERE list_address = ? AND email = ?',
		)
		.get(listAddress, normalizeEmail(email))
	return row ? ausZeile(row) : VORGABE
}

/** Alle Adressen einer Liste, die NICHT auf dem Vorgabewert stehen. */
export const einstellungenDerListe = (
	listAddress: string,
	db: Database = openDb(),
): Map<string, Einstellung> => {
	const rows = db
		.prepare<[string], SettingsRow>(
			'SELECT email, subscribed, own_mail FROM list_recipient_settings WHERE list_address = ?',
		)
		.all(listAddress)
	return new Map(rows.map((row) => [row.email, ausZeile(row)]))
}

/**
 * Schreibt die Einstellung. Beide Felder werden gesetzt — wer nur eines ändern
 * will, liest vorher `einstellungFuer`. Ein `UPDATE` nur einer Spalte hätte
 * denselben Effekt, aber diese Signatur macht sichtbar, dass hier ein
 * vollständiger Zustand steht und keine Teiländerung.
 */
export const setzeEinstellung = (
	listAddress: string,
	email: string,
	einstellung: Einstellung,
	db: Database = openDb(),
): void => {
	db.prepare(
		`INSERT INTO list_recipient_settings (list_address, email, subscribed, own_mail, updated_at)
     VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     ON CONFLICT (list_address, email) DO UPDATE SET
       subscribed = excluded.subscribed,
       own_mail   = excluded.own_mail,
       updated_at = excluded.updated_at`,
	).run(
		listAddress,
		normalizeEmail(email),
		einstellung.subscribed ? 1 : 0,
		einstellung.ownMail,
	)
}

/**
 * Der Schlüssel der Einstellungsseite.
 *
 * 32 Byte aus `randomBytes`, base64url — nicht zu erraten und kurz genug, dass
 * er in eine URL passt, ohne umgebrochen zu werden. Ein umgebrochener Link in
 * einer Textmail ist ein toter Link.
 */
const neuerToken = (): string => randomBytes(32).toString('base64url')

/**
 * Holt den Token einer Adresse und legt ihn an, wenn es noch keinen gibt.
 *
 * Er wird nie erneuert. Ein rotierender Token hätte jeden Link in jeder schon
 * verschickten Mail entwertet — und genau diese alten Mails sind der Weg, auf
 * dem jemand Monate später aus dem Verteiler herausfindet.
 */
export const tokenFuer = (email: string, db: Database = openDb()): string => {
	const normalisiert = normalizeEmail(email)
	const vorhanden = db
		.prepare<[string], { token: string }>(
			'SELECT token FROM list_settings_tokens WHERE email = ?',
		)
		.get(normalisiert)
	if (vorhanden) return vorhanden.token

	db.prepare(
		`INSERT INTO list_settings_tokens (email, token)
     VALUES (?, ?)
     ON CONFLICT (email) DO NOTHING`,
	).run(normalisiert, neuerToken())
	// Nach einem Wettlauf gewinnt der zuerst geschriebene Wert; deshalb erneut
	// lesen statt den gerade gewürfelten zurückgeben.
	const zeile = db
		.prepare<[string], { token: string }>(
			'SELECT token FROM list_settings_tokens WHERE email = ?',
		)
		.get(normalisiert)
	if (!zeile) throw new Error(`Kein Token fuer ${normalisiert} anzulegen`)
	return zeile.token
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

export type ListenEinstellung = Einstellung & {
	address: string
	label: string
}

/**
 * Was die Einstellungsseite zeigt: jede AKTIVE Liste der Klasse mit der
 * Einstellung dieser Adresse.
 *
 * Bewusst ALLE Listen und nicht nur die, auf denen die Adresse steht: Sonst
 * verschwände eine Liste aus der Übersicht, sobald jemand sie abbestellt — und
 * der Weg zurück wäre weg.
 *
 * Die Listen kommen als Argument und nicht aus `listMailingLists()`. Das ist
 * kein Geschmack: `mailingLists.ts` braucht `einstellungenDerListe` von hier,
 * um Abgemeldete aus den Empfängern zu nehmen. Ein gegenseitiger Import wäre
 * ein Kreis, und Kreise in ESM gehen so lange gut, bis eines der Module beim
 * Laden etwas aus dem anderen braucht.
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
			...einstellungFuer(list.address, normalisiert, db),
		}))
}
