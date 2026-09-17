import { randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { dbTimestamp, openDb } from './index.ts'

/**
 * Schichtplaene: wer uebernimmt welche Schicht.
 *
 * Ein admin legt den Plan mit seinen Schichten ueber MCP an, die Familien
 * tragen sich selbst ein — mit Konto oder ohne. Wer aendern darf, entscheidet
 * `darfEintragAendern`; wann ein Plan verschwindet, `delete_at`.
 *
 * Feldnamen sind englisch, weil sie in Datenbank und JSON stehen; was ein
 * Mensch liest, ist deutsch.
 */

export type PlanStatus = 'open' | 'closed'

export type Schichtplan = {
	id: string
	title: string
	/** `JJJJ-MM-TT` oder `null`. */
	event_date: string | null
	description: string | null
	shifts: string[]
	/** Plaetze je Schicht, `null` = beliebig viele. */
	capacity: number | null
	status: PlanStatus
	retention_days: number
	delete_at: string
	revision: number
	created_by: string | null
	created_at: string
	updated_at: string
}

export type Schichteintrag = {
	id: string
	list_id: string
	name: string
	shift: string
	note: string | null
	owner_sub: string | null
	created_at: string
	updated_at: string
}

export type EintragMitSchluessel = Schichteintrag & { edit_token: string }

/** Wer gerade handelt — Sitzung, Browser-Schluessel oder admin. */
export type Handelnde = {
	sub?: string | null
	editToken?: string | null
	admin?: boolean
}

export const VORGABE_AUFBEWAHRUNG_TAGE = 180

const TAG_MS = 24 * 60 * 60 * 1000

/** 16 Zeichen base64url — nicht erratbar, denn der Link ist der Zugang. */
export const neuePlanId = (): string => randomBytes(12).toString('base64url')

const neuerSchluessel = (): string => randomBytes(18).toString('base64url')

const DATUM = /^\d{4}-\d{2}-\d{2}$/

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

type PlanZeile = Omit<Schichtplan, 'shifts'> & { shifts: string }

const zeileZuPlan = (z: PlanZeile): Schichtplan => {
	let shifts: string[] = []
	try {
		const parsed = JSON.parse(z.shifts) as unknown
		if (Array.isArray(parsed))
			shifts = parsed.filter((s): s is string => typeof s === 'string')
	} catch {
		shifts = []
	}
	return { ...z, shifts, status: z.status as PlanStatus }
}

const pruefeSchichten = (shifts: readonly string[]): string[] => {
	const bereinigt = [...new Set(shifts.map((s) => s.trim()).filter(Boolean))]
	if (bereinigt.length === 0)
		throw new Error(
			'Ein Schichtplan braucht Schichten, z.B. ["16:30 bis 17:30 Uhr", "17:30 bis 18:30 Uhr"].',
		)
	if (bereinigt.length > 30) throw new Error('Höchstens 30 Schichten je Plan.')
	return bereinigt
}

const pruefeDatum = (eventDate: string | null): void => {
	if (eventDate && !DATUM.test(eventDate))
		throw new Error('Datum als JJJJ-MM-TT, z.B. 2026-09-12 — nicht 12.09.2026.')
}

const pruefeAufbewahrung = (tage: number): void => {
	if (!Number.isInteger(tage) || tage < 1)
		throw new Error(
			'Die Aufbewahrung ist eine ganze Zahl von Tagen, mindestens 1.',
		)
}

const pruefeCapacity = (capacity: number | null): void => {
	if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1))
		throw new Error('Plätze je Schicht sind eine ganze Zahl, mindestens 1.')
}

// ---------------------------------------------------------------------------
// Plaene
// ---------------------------------------------------------------------------

export type NeuerPlan = {
	title: string
	shifts: readonly string[]
	event_date?: string | null
	description?: string | null
	capacity?: number | null
	retention_days?: number
	created_by?: string | null
}

export const legePlanAn = (
	eingabe: NeuerPlan,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Schichtplan => {
	const title = eingabe.title.trim()
	if (!title) throw new Error('Der Schichtplan braucht einen Titel.')
	const eventDate = eingabe.event_date?.trim() || null
	pruefeDatum(eventDate)
	const retention = eingabe.retention_days ?? VORGABE_AUFBEWAHRUNG_TAGE
	pruefeAufbewahrung(retention)
	const capacity = eingabe.capacity ?? null
	pruefeCapacity(capacity)
	const shifts = pruefeSchichten(eingabe.shifts)
	const id = neuePlanId()
	const ts = dbTimestamp(jetzt)
	db.prepare(
		`INSERT INTO shift_lists (id, title, event_date, description, shifts, capacity, status, retention_days, delete_at, revision, created_by, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, 0, ?, ?, ?)`,
	).run(
		id,
		title,
		eventDate,
		eingabe.description?.trim() || null,
		JSON.stringify(shifts),
		capacity,
		retention,
		berechneLoeschzeit(eventDate, retention, jetzt),
		eingabe.created_by ?? null,
		ts,
		ts,
	)
	const plan = zeileLesen(id, db)
	if (!plan) throw new Error('Schichtplan konnte nicht angelegt werden.')
	return plan
}

const zeileLesen = (id: string, db: Database): Schichtplan | null => {
	const z = db
		.prepare<[string], PlanZeile>('SELECT * FROM shift_lists WHERE id = ?')
		.get(id)
	return z ? zeileZuPlan(z) : null
}

/** Ein faelliger Plan ist fuer alle schon weg, auch vor dem Aufraeumlauf. */
export const planLesen = (
	id: string,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Schichtplan | null => {
	const z = db
		.prepare<[string], PlanZeile>('SELECT * FROM shift_lists WHERE id = ?')
		.get(id)
	if (!z) return null
	if (z.delete_at <= dbTimestamp(jetzt)) return null
	return zeileZuPlan(z)
}

export const plaeneLesen = (
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Schichtplan[] =>
	db
		.prepare<[string], PlanZeile>(
			'SELECT * FROM shift_lists WHERE delete_at > ? ORDER BY COALESCE(event_date, created_at) DESC, created_at DESC',
		)
		.all(dbTimestamp(jetzt))
		.map(zeileZuPlan)

export const offenePlaene = (
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Schichtplan[] => plaeneLesen(db, jetzt).filter((p) => p.status === 'open')

export type PlanAenderung = {
	title?: string
	event_date?: string | null
	description?: string | null
	shifts?: readonly string[]
	capacity?: number | null
	status?: PlanStatus
	retention_days?: number
}

const erhoeheRevision = (listId: string, db: Database, jetzt: Date): void => {
	db.prepare(
		'UPDATE shift_lists SET revision = revision + 1, updated_at = ? WHERE id = ?',
	).run(dbTimestamp(jetzt), listId)
}

export const aenderePlan = (
	id: string,
	patch: PlanAenderung,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Schichtplan => {
	const plan = planLesen(id, db, jetzt)
	if (!plan) throw new Error('Diesen Schichtplan gibt es nicht.')
	const title = patch.title === undefined ? plan.title : patch.title.trim()
	if (!title) throw new Error('Der Schichtplan braucht einen Titel.')
	const eventDate =
		patch.event_date === undefined
			? plan.event_date
			: patch.event_date?.trim() || null
	pruefeDatum(eventDate)
	const retention = patch.retention_days ?? plan.retention_days
	pruefeAufbewahrung(retention)
	const capacity = patch.capacity === undefined ? plan.capacity : patch.capacity
	pruefeCapacity(capacity)
	const shifts =
		patch.shifts === undefined ? plan.shifts : pruefeSchichten(patch.shifts)
	const description =
		patch.description === undefined
			? plan.description
			: patch.description?.trim() || null
	db.prepare(
		`UPDATE shift_lists
		    SET title = ?, event_date = ?, description = ?, shifts = ?, capacity = ?,
		        status = ?, retention_days = ?, delete_at = ?, revision = revision + 1, updated_at = ?
		  WHERE id = ?`,
	).run(
		title,
		eventDate,
		description,
		JSON.stringify(shifts),
		capacity,
		patch.status ?? plan.status,
		retention,
		berechneLoeschzeit(eventDate, retention, jetzt),
		dbTimestamp(jetzt),
		id,
	)
	const neu = zeileLesen(id, db)
	if (!neu) throw new Error('Schichtplan konnte nicht gelesen werden.')
	return neu
}

export const loeschePlan = (id: string, db: Database = openDb()): boolean =>
	db.prepare('DELETE FROM shift_lists WHERE id = ?').run(id).changes > 0

/** Raeumt faellige Plaene samt Eintraegen ab. */
export const loescheFaellige = (
	db: Database = openDb(),
	jetzt: Date = new Date(),
): number =>
	db
		.prepare('DELETE FROM shift_lists WHERE delete_at <= ?')
		.run(dbTimestamp(jetzt)).changes

// ---------------------------------------------------------------------------
// Eintraege
// ---------------------------------------------------------------------------

const EINTRAG_SPALTEN =
	'id, list_id, name, shift, note, owner_sub, created_at, updated_at'

export const eintraegeLesen = (
	listId: string,
	db: Database = openDb(),
): Schichteintrag[] =>
	db
		.prepare<[string], Schichteintrag>(
			`SELECT ${EINTRAG_SPALTEN} FROM shift_entries WHERE list_id = ? ORDER BY created_at, id`,
		)
		.all(listId)

const eintragLesenIntern = (
	id: string,
	db: Database,
): EintragMitSchluessel | undefined =>
	db
		.prepare<[string], EintragMitSchluessel>(
			`SELECT ${EINTRAG_SPALTEN}, edit_token FROM shift_entries WHERE id = ?`,
		)
		.get(id)

export const eintragLesen = (
	id: string,
	db: Database = openDb(),
): Schichteintrag | null => {
	const e = eintragLesenIntern(id, db)
	if (!e) return null
	const { edit_token: _weg, ...ohne } = e
	return ohne
}

export type NeuerEintrag = {
	name: string
	shift: string
	note?: string | null
	owner_sub?: string | null
}

const pruefeEintrag = (
	plan: Schichtplan,
	e: { name: string; shift: string; note?: string | null },
) => {
	const name = e.name.trim()
	if (!name) throw new Error('Bitte einen Namen angeben.')
	const shift = e.shift.trim()
	if (!shift) throw new Error('Bitte eine Schicht auswählen.')
	if (!plan.shifts.includes(shift))
		throw new Error(
			`Unbekannte Schicht „${shift}“. Möglich: ${plan.shifts.join(', ')}.`,
		)
	const note = e.note?.trim() || null
	if (name.length > 80 || (note ?? '').length > 120)
		throw new Error('Das ist zu lang für einen Eintrag.')
	return { name, shift, note }
}

/** Eine volle Schicht nimmt niemanden mehr — ein admin darf trotzdem. */
const pruefePlatz = (
	plan: Schichtplan,
	shift: string,
	ausser: string | null,
	handelnde: Handelnde,
	db: Database,
): void => {
	if (plan.capacity === null || handelnde.admin) return
	const belegt = eintraegeLesen(plan.id, db).filter(
		(e) => e.shift === shift && e.id !== ausser,
	).length
	if (belegt >= plan.capacity)
		throw new Error(
			`Die Schicht „${shift}“ ist voll (${plan.capacity} Plätze). Such dir bitte eine andere aus.`,
		)
}

export const trageEin = (
	listId: string,
	eingabe: NeuerEintrag,
	handelnde: Handelnde = {},
	db: Database = openDb(),
	jetzt: Date = new Date(),
): EintragMitSchluessel => {
	const plan = planLesen(listId, db, jetzt)
	if (!plan) throw new Error('Diesen Schichtplan gibt es nicht.')
	if (plan.status === 'closed' && !handelnde.admin)
		throw new Error('Dieser Schichtplan ist geschlossen.')
	const werte = pruefeEintrag(plan, eingabe)
	pruefePlatz(plan, werte.shift, null, handelnde, db)
	const id = randomBytes(9).toString('base64url')
	const token = neuerSchluessel()
	const ts = dbTimestamp(jetzt)
	const tx = db.transaction(() => {
		db.prepare(
			`INSERT INTO shift_entries (id, list_id, name, shift, note, owner_sub, edit_token, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			listId,
			werte.name,
			werte.shift,
			werte.note,
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

/** admin, die angemeldete Person selbst, oder der Browser mit dem Schluessel. */
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
	shift?: string
	note?: string | null
}

export const aendereEintrag = (
	id: string,
	patch: EintragAenderung,
	handelnde: Handelnde,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Schichteintrag => {
	const e = eintragLesenIntern(id, db)
	if (!e) throw new Error('Diesen Eintrag gibt es nicht.')
	const plan = planLesen(e.list_id, db, jetzt)
	if (!plan) throw new Error('Diesen Schichtplan gibt es nicht.')
	if (!darfEintragAendern(e, handelnde))
		throw new Error('Diesen Eintrag darfst du nicht ändern.')
	if (plan.status === 'closed' && !handelnde.admin)
		throw new Error('Dieser Schichtplan ist geschlossen.')
	const werte = pruefeEintrag(plan, {
		name: patch.name ?? e.name,
		shift: patch.shift ?? e.shift,
		note: patch.note === undefined ? e.note : patch.note,
	})
	if (werte.shift !== e.shift)
		pruefePlatz(plan, werte.shift, e.id, handelnde, db)
	const tx = db.transaction(() => {
		db.prepare(
			'UPDATE shift_entries SET name = ?, shift = ?, note = ?, updated_at = ? WHERE id = ?',
		).run(werte.name, werte.shift, werte.note, dbTimestamp(jetzt), id)
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
		throw new Error('Diesen Eintrag darfst du nicht löschen.')
	const plan = planLesen(e.list_id, db, jetzt)
	if (plan && plan.status === 'closed' && !handelnde.admin)
		throw new Error('Dieser Schichtplan ist geschlossen.')
	const tx = db.transaction(() => {
		db.prepare('DELETE FROM shift_entries WHERE id = ?').run(id)
		erhoeheRevision(e.list_id, db, jetzt)
	})
	tx()
	return true
}

// ---------------------------------------------------------------------------
// Fuer die Seite
// ---------------------------------------------------------------------------

export type Stand = {
	list: Pick<
		Schichtplan,
		| 'id'
		| 'title'
		| 'event_date'
		| 'description'
		| 'shifts'
		| 'capacity'
		| 'status'
		| 'revision'
	>
	entries: Omit<Schichteintrag, 'owner_sub' | 'list_id'>[]
	/** Je Schicht, wie viele eingeteilt sind und ob sie voll ist. */
	counts: { shift: string; count: number; full: boolean }[]
}

export const standLesen = (
	listId: string,
	db: Database = openDb(),
	jetzt: Date = new Date(),
): Stand | null => {
	const plan = planLesen(listId, db, jetzt)
	if (!plan) return null
	const entries = eintraegeLesen(listId, db)
	const counts = plan.shifts.map((shift) => {
		const count = entries.filter((e) => e.shift === shift).length
		return {
			shift,
			count,
			full: plan.capacity !== null && count >= plan.capacity,
		}
	})
	return {
		list: {
			id: plan.id,
			title: plan.title,
			event_date: plan.event_date,
			description: plan.description,
			shifts: plan.shifts,
			capacity: plan.capacity,
			status: plan.status,
			revision: plan.revision,
		},
		entries: entries.map(({ owner_sub: _o, list_id: _l, ...rest }) => rest),
		counts,
	}
}

/** Absolute Adresse der Planseite. */
export const planUrl = (siteUrl: string, id: string): string =>
	`${siteUrl.replace(/\/$/, '')}/public/schichten/${id}`
