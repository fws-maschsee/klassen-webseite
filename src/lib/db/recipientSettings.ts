import { randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { openDb } from './index.ts'
import { normalizeEmail } from './mailingLists.ts'
import type { MailingListRow } from './types.ts'

export const EIGENE_POST = ['copy', 'confirmation', 'none'] as const
export type EigenePost = (typeof EIGENE_POST)[number]

export const VORGABE: Einstellung = { subscribed: true, ownMail: 'copy' }

export type Einstellung = {
	subscribed: boolean
	ownMail: EigenePost
}

export const istEigenePost = (wert: unknown): wert is EigenePost =>
	typeof wert === 'string' && (EIGENE_POST as readonly string[]).includes(wert)

type SettingsRow = { email: string; subscribed: number; own_mail: string }

const ausZeile = (row: SettingsRow): Einstellung => ({
	subscribed: row.subscribed === 1,
	ownMail: istEigenePost(row.own_mail) ? row.own_mail : VORGABE.ownMail,
})

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

const neuerToken = (): string => randomBytes(32).toString('base64url')

// Nie erneuert: ein neuer Token entwertete die Abmeldelinks in allen schon verschickten Mails.
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
	// Neu lesen statt den gewürfelten Wert zurückgeben: bei einem Wettlauf gewinnt der zuerst geschriebene.
	const zeile = db
		.prepare<[string], { token: string }>(
			'SELECT token FROM list_settings_tokens WHERE email = ?',
		)
		.get(normalisiert)
	if (!zeile) throw new Error(`Kein Token fuer ${normalisiert} anzulegen`)
	return zeile.token
}

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

// Listen als Argument statt listMailingLists(): mailingLists.ts importiert von hier, das wäre ein Importkreis.
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
