import { randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { dbTimestamp, openDb } from './index.ts'

/**
 * Mitbringlisten als Daten: "Wer bringt was zum Grillfest mit?"
 *
 * Eine LISTE ist ein Anlass, den ein admin ueber MCP anlegt. EINTRAEGE machen
 * die Familien selbst auf der Seite — mit Konto oder ohne. Dieses Modul kennt
 * die Regeln, die daran haengen, und sonst nichts:
 *
 * - Wer einen Eintrag AENDERN darf: die Person, die ihn gemacht hat (ueber
 *   `owner_sub` bei Konto, ueber `edit_token` ohne), und ein admin. Das
 *   entscheidet `darfEintragAendern`; Seite und MCP fragen dieselbe Funktion.
 * - Wann eine Liste WEG ist: `delete_at`, aus Datum und Aufbewahrung
 *   berechnet. `loescheFaellige` raeumt ab, `listeLesen` liefert eine
 *   faellige Liste schon vorher nicht mehr aus.
 * - Woran die Seite MERKT, dass sich etwas getan hat: `revision`, ein Zaehler
 *   je Liste, der bei jeder Aenderung steigt.
 *
 * Feldnamen sind englisch (`title`, `event_date`, `entries`), weil sie in der
 * Datenbank und in den JSON-Antworten stehen. Was ein Mensch liest, ist
 * deutsch: die Fehlermeldungen und die Seite.
 */

export type ListenStatus = 'open' | 'closed'

export type Mitbringliste = {
	id: string
	title: string
	/** `JJJJ-MM-TT` oder `null`. */
	event_date: string | null
	description: string | null
	categories: string[]
	status: ListenStatus
	retention_days: number
	delete_at: string
	revision: number
	created_by: string | null
	created_at: string
	updated_at: string
}

export type Eintrag = {
	id: string
	list_id: string
	name: string
	category: string | null
	item: string
	amount: string | null
	owner_sub: string | null
	created_at: string
	updated_at: string
}

/** Ein Eintrag samt seinem Bearbeitungsschluessel — nur fuer die Person, die ihn gerade angelegt hat. */
export type EintragMitSchluessel = Eintrag & { edit_token: string }

/** Wer gerade handelt — die Seite baut das aus Sitzung bzw. Browser-Schluessel. */
export type Handelnde = {
	/** ZITADEL-`sub`, wenn angemeldet. */
	sub?: string | null
	/** Bearbeitungsschluessel eines Eintrags ohne Konto. */
	editToken?: string | null
	/** Darf alles: Rolle admin der Klasse. */
	admin?: boolean
}

export const VORGABE_AUFBEWAHRUNG_TAGE = 180

const TAG_MS = 24 * 60 * 60 * 1000

/** 16 Zeichen base64url — 96 Bit Zufall, nicht erratbar, URL-tauglich. */
export const neueListenId = (): string => randomBytes(12).toString('base64url')

const neuerSchluessel = (): string => randomBytes(18).toString('base64url')

const DATUM = /^\d{4}-\d{2}-\d{2}$/

/**
 * Ab wann die Liste geloescht wird: `retention_days` nach dem Datum des
 * Anlasses — oder, wenn es keines gibt, nach dem Anlegen.
 */
export const berechneLoeschzeit = (
	eventDate: string | null,
	retentionDays: number,
	jetzt: Date = new Date(),
): string => {
	const basis =
		eventDate && DATUM.test(eventDate)
			? new Date(`${eventDate}T00:00:00.000Z`)
			: jetzt
	return dbTimestamp(new Date(basis.getTime() + retentionDays * TAG_MS))
}

type ListenZeile = Omit<Mitbringliste, 'categories'> & { categories: string }

const zeileZuListe = (z: ListenZeile): Mitbringliste => {
	let categories: string[] = []
	try {
		const parsed = JSON.parse(z.categories) as unknown
		if (Array.isArray(parsed))
			categories = parsed.filter((c): c is string => typeof c === 'string')
	} catch {
		categories = []
	}
	return { ...z, categories, status: z.status as ListenStatus }
}

const pruefeKategorien = (categories: readonly string[]): string[] => {
	const bereinigt = [
		...new Set(categories.map((c) => c.trim()).filter(Boolean)),
	]
	if (bereinigt.length > 30)
		throw new Error('Hoechstens 30 Kategorien je Liste.')
	return bereinigt
}

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------

export type NeueListe = {
	title: string
	event_date?: string | null
	description?: string | null
	categories?: readonly string[]
	retention_days?: number
	created_by?: string | null
}

export const legeListeAn = (
	eingabe: NeueListe,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Mitbringliste => {
	const title = eingabe.title.trim()
	if (!title) throw new Error('Die Liste braucht einen Titel.')
	const eventDate = eingabe.event_date?.trim() || null
	if (eventDate && !DATUM.test(eventDate))
		throw new Error('Datum als JJJJ-MM-TT, z.B. 2026-09-12 — nicht 12.09.2026.')
	const retention = eingabe.retention_days ?? VORGABE_AUFBEWAHRUNG_TAGE
	if (!Number.isInteger(retention) || retention < 1)
		throw new Error(
			'Die Aufbewahrung ist eine ganze Zahl von Tagen, mindestens 1.',
		)
	const categories = pruefeKategorien(eingabe.categories ?? [])
	const id = neueListenId()
	const ts = dbTimestamp(jetzt)
	db.prepare(
		`INSERT INTO bring_lists (id, title, event_date, description, categories, status, retention_days, delete_at, revision, created_by, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 'open', ?, ?, 0, ?, ?, ?)`,
	).run(
		id,
		title,
		eventDate,
		eingabe.description?.trim() || null,
		JSON.stringify(categories),
		retention,
		berechneLoeschzeit(eventDate, retention, jetzt),
		eingabe.created_by ?? null,
		ts,
		ts,
	)
	const liste = zeileLesen(id, db)
	if (!liste) throw new Error('Liste konnte nicht angelegt werden.')
	return liste
}

/**
 * Eine Liste, oder `null`, wenn es sie nicht gibt — oder wenn sie FAELLIG ist.
 * Eine faellige Liste ist fuer alle Aufrufer schon weg, auch wenn der
 * Aufraeumlauf sie noch nicht geloescht hat.
 */
const zeileLesen = (id: string, db: Database): Mitbringliste | null => {
	const z = db
		.prepare<[string], ListenZeile>('SELECT * FROM bring_lists WHERE id = ?')
		.get(id)
	return z ? zeileZuListe(z) : null
}

export const listeLesen = (
	id: string,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Mitbringliste | null => {
	const z = db
		.prepare<[string], ListenZeile>('SELECT * FROM bring_lists WHERE id = ?')
		.get(id)
	if (!z) return null
	if (z.delete_at <= dbTimestamp(jetzt)) return null
	return zeileZuListe(z)
}

/** Alle nicht faelligen Listen, neueste zuerst. */
export const listenLesen = (
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Mitbringliste[] =>
	db
		.prepare<[string], ListenZeile>(
			'SELECT * FROM bring_lists WHERE delete_at > ? ORDER BY COALESCE(event_date, created_at) DESC, created_at DESC',
		)
		.all(dbTimestamp(jetzt))
		.map(zeileZuListe)

/** Die offenen Listen — fuer die Startseite der Angemeldeten. */
export const offeneListen = (
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Mitbringliste[] => listenLesen(db, jetzt).filter((l) => l.status === 'open')

export type ListenAenderung = {
	title?: string
	event_date?: string | null
	description?: string | null
	categories?: readonly string[]
	status?: ListenStatus
	retention_days?: number
}

const erhoeheRevision = (listId: string, db: Database, jetzt: Date): void => {
	db.prepare(
		'UPDATE bring_lists SET revision = revision + 1, updated_at = ? WHERE id = ?',
	).run(dbTimestamp(jetzt), listId)
}

export const aendereListe = (
	id: string,
	patch: ListenAenderung,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Mitbringliste => {
	const liste = listeLesen(id, db, jetzt)
	if (!liste) throw new Error('Diese Liste gibt es nicht.')
	const title = patch.title === undefined ? liste.title : patch.title.trim()
	if (!title) throw new Error('Die Liste braucht einen Titel.')
	const eventDate =
		patch.event_date === undefined
			? liste.event_date
			: patch.event_date?.trim() || null
	if (eventDate && !DATUM.test(eventDate))
		throw new Error('Datum als JJJJ-MM-TT, z.B. 2026-09-12 — nicht 12.09.2026.')
	const retention = patch.retention_days ?? liste.retention_days
	if (!Number.isInteger(retention) || retention < 1)
		throw new Error(
			'Die Aufbewahrung ist eine ganze Zahl von Tagen, mindestens 1.',
		)
	const categories =
		patch.categories === undefined
			? liste.categories
			: pruefeKategorien(patch.categories)
	const status = patch.status ?? liste.status
	const description =
		patch.description === undefined
			? liste.description
			: patch.description?.trim() || null
	db.prepare(
		`UPDATE bring_lists
		    SET title = ?, event_date = ?, description = ?, categories = ?, status = ?,
		        retention_days = ?, delete_at = ?, revision = revision + 1, updated_at = ?
		  WHERE id = ?`,
	).run(
		title,
		eventDate,
		description,
		JSON.stringify(categories),
		status,
		retention,
		berechneLoeschzeit(eventDate, retention, jetzt),
		dbTimestamp(jetzt),
		id,
	)
	const neu = zeileLesen(id, db)
	if (!neu) throw new Error('Liste konnte nicht gelesen werden.')
	return neu
}

export const loescheListe = (id: string, db: Database = openDb()): boolean =>
	db.prepare('DELETE FROM bring_lists WHERE id = ?').run(id).changes > 0

/** Raeumt faellige Listen samt Eintraegen ab. Gibt die Zahl der geloeschten Listen zurueck. */
export const loescheFaellige = (
	db: Database = openDb(),
	jetzt: Date = new Date(),
): number =>
	db
		.prepare('DELETE FROM bring_lists WHERE delete_at <= ?')
		.run(dbTimestamp(jetzt)).changes

// ---------------------------------------------------------------------------
// Eintraege
// ---------------------------------------------------------------------------

const EINTRAG_SPALTEN =
	'id, list_id, name, category, item, amount, owner_sub, created_at, updated_at'

export const eintraegeLesen = (
	listId: string,
	db: Database = openDb(),
): Eintrag[] =>
	db
		.prepare<[string], Eintrag>(
			`SELECT ${EINTRAG_SPALTEN} FROM bring_entries WHERE list_id = ? ORDER BY created_at, id`,
		)
		.all(listId)

const eintragLesenIntern = (
	id: string,
	db: Database,
): EintragMitSchluessel | undefined =>
	db
		.prepare<[string], EintragMitSchluessel>(
			`SELECT ${EINTRAG_SPALTEN}, edit_token FROM bring_entries WHERE id = ?`,
		)
		.get(id)

export const eintragLesen = (
	id: string,
	db: Database = openDb(),
): Eintrag | null => {
	const e = eintragLesenIntern(id, db)
	if (!e) return null
	const { edit_token: _weg, ...ohne } = e
	return ohne
}

export type NeuerEintrag = {
	name: string
	item: string
	category?: string | null
	amount?: string | null
	owner_sub?: string | null
}

const pruefeEintrag = (
	liste: Mitbringliste,
	e: {
		name: string
		item: string
		category?: string | null
		amount?: string | null
	},
) => {
	const name = e.name.trim()
	const item = e.item.trim()
	if (!name) throw new Error('Bitte einen Namen angeben.')
	if (!item) throw new Error('Bitte angeben, was mitgebracht wird.')
	if (name.length > 80 || item.length > 200 || (e.amount ?? '').length > 80)
		throw new Error('Das ist zu lang fuer einen Eintrag.')
	const category = e.category?.trim() || null
	if (
		liste.categories.length > 0 &&
		category &&
		!liste.categories.includes(category)
	)
		throw new Error(
			`Unbekannte Kategorie „${category}“. Moeglich: ${liste.categories.join(', ')}.`,
		)
	return { name, item, category, amount: e.amount?.trim() || null }
}

/**
 * Traegt ein. Liefert den Eintrag MIT Bearbeitungsschluessel — der geht
 * einmal an den Browser, der ihn angelegt hat, und sonst nirgendwohin.
 */
export const trageEin = (
	listId: string,
	eingabe: NeuerEintrag,
	handelnde: Handelnde = {},
	db: Database = openDb(),
	jetzt: Date = new Date(),
): EintragMitSchluessel => {
	const liste = listeLesen(listId, db, jetzt)
	if (!liste) throw new Error('Diese Liste gibt es nicht.')
	if (liste.status === 'closed' && !handelnde.admin)
		throw new Error('Diese Liste ist geschlossen.')
	const werte = pruefeEintrag(liste, eingabe)
	const id = randomBytes(9).toString('base64url')
	const token = neuerSchluessel()
	const ts = dbTimestamp(jetzt)
	const tx = db.transaction(() => {
		db.prepare(
			`INSERT INTO bring_entries (id, list_id, name, category, item, amount, owner_sub, edit_token, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			listId,
			werte.name,
			werte.category,
			werte.item,
			werte.amount,
			eingabe.owner_sub ?? handelnde.sub ?? null,
			token,
			ts,
			ts,
		)
		erhoeheRevision(listId, db, jetzt)
	})
	tx()
	const e = eintragLesenIntern(id, db)
	if (!e) throw new Error('Eintrag konnte nicht gespeichert werden.')
	return e
}

/**
 * Darf diese Person diesen Eintrag aendern oder loeschen?
 *
 * Ja fuer: admin; die angemeldete Person, die ihn gemacht hat; den Browser,
 * der den Bearbeitungsschluessel des Eintrags hat. Sonst nein — auch nicht
 * "ist doch nur eine Mitbringliste": Fremde Eintraege zu aendern, waere genau
 * der Streit, den die Liste vermeiden soll.
 */
export const darfEintragAendern = (
	eintrag: { owner_sub: string | null; edit_token: string },
	handelnde: Handelnde,
): boolean => {
	if (handelnde.admin) return true
	if (handelnde.sub && eintrag.owner_sub && handelnde.sub === eintrag.owner_sub)
		return true
	return Boolean(
		handelnde.editToken && handelnde.editToken === eintrag.edit_token,
	)
}

export type EintragAenderung = {
	name?: string
	item?: string
	category?: string | null
	amount?: string | null
}

export const aendereEintrag = (
	id: string,
	patch: EintragAenderung,
	handelnde: Handelnde,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Eintrag => {
	const e = eintragLesenIntern(id, db)
	if (!e) throw new Error('Diesen Eintrag gibt es nicht.')
	const liste = listeLesen(e.list_id, db, jetzt)
	if (!liste) throw new Error('Diese Liste gibt es nicht.')
	if (!darfEintragAendern(e, handelnde))
		throw new Error('Diesen Eintrag darfst du nicht aendern.')
	if (liste.status === 'closed' && !handelnde.admin)
		throw new Error('Diese Liste ist geschlossen.')
	const werte = pruefeEintrag(liste, {
		name: patch.name ?? e.name,
		item: patch.item ?? e.item,
		category: patch.category === undefined ? e.category : patch.category,
		amount: patch.amount === undefined ? e.amount : patch.amount,
	})
	const tx = db.transaction(() => {
		db.prepare(
			'UPDATE bring_entries SET name = ?, category = ?, item = ?, amount = ?, updated_at = ? WHERE id = ?',
		).run(
			werte.name,
			werte.category,
			werte.item,
			werte.amount,
			dbTimestamp(jetzt),
			id,
		)
		erhoeheRevision(e.list_id, db, jetzt)
	})
	tx()
	const neu = eintragLesen(id, db)
	if (!neu) throw new Error('Eintrag konnte nicht gelesen werden.')
	return neu
}

export const loescheEintrag = (
	id: string,
	handelnde: Handelnde,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): boolean => {
	const e = eintragLesenIntern(id, db)
	if (!e) return false
	if (!darfEintragAendern(e, handelnde))
		throw new Error('Diesen Eintrag darfst du nicht loeschen.')
	const liste = listeLesen(e.list_id, db, jetzt)
	if (liste && liste.status === 'closed' && !handelnde.admin)
		throw new Error('Diese Liste ist geschlossen.')
	const tx = db.transaction(() => {
		db.prepare('DELETE FROM bring_entries WHERE id = ?').run(id)
		erhoeheRevision(e.list_id, db, jetzt)
	})
	tx()
	return true
}

// ---------------------------------------------------------------------------
// Fuer die Seite
// ---------------------------------------------------------------------------

/** Der Stand einer Liste, wie die Seite ihn abfragt: Liste, Eintraege, Zaehler. */
export type Stand = {
	list: Pick<
		Mitbringliste,
		| 'id'
		| 'title'
		| 'event_date'
		| 'description'
		| 'categories'
		| 'status'
		| 'revision'
	>
	entries: Omit<Eintrag, 'owner_sub' | 'list_id'>[]
	/** Je Kategorie die Anzahl der Eintraege — auch 0, damit die Luecke sichtbar ist. */
	counts: { category: string; count: number }[]
}

export const standLesen = (
	listId: string,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Stand | null => {
	const liste = listeLesen(listId, db, jetzt)
	if (!liste) return null
	const entries = eintraegeLesen(listId, db)
	const counts = liste.categories.map((category) => ({
		category,
		count: entries.filter((e) => e.category === category).length,
	}))
	return {
		list: {
			id: liste.id,
			title: liste.title,
			event_date: liste.event_date,
			description: liste.description,
			categories: liste.categories,
			status: liste.status,
			revision: liste.revision,
		},
		entries: entries.map(({ owner_sub: _o, list_id: _l, ...rest }) => rest),
		counts,
	}
}

/** Absolute Adresse der Listenseite. */
export const listenUrl = (siteUrl: string, id: string): string =>
	`${siteUrl.replace(/\/$/, '')}/public/mitbringen/${id}`
