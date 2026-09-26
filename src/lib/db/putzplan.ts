import type { Database } from 'better-sqlite3'
import { getGroup } from './groups.ts'
import { openDb } from './index.ts'

export type Termin = {
	date: string
	note: string | null
	groups: string[]
}

export type TerminMitNamen = Omit<Termin, 'groups'> & {
	groups: { key: string; label: string }[]
}

const nachDatum = (a: Termin, b: Termin): number =>
	a.date < b.date ? -1 : a.date > b.date ? 1 : 0

type PlanZeile = { date: string; note: string | null; group_key: string | null }

const zeilenZuTerminen = (zeilen: readonly PlanZeile[]): Termin[] => {
	const termine = new Map<string, Termin>()
	for (const zeile of zeilen) {
		const termin = termine.get(zeile.date) ?? {
			date: zeile.date,
			note: zeile.note,
			groups: [],
		}
		if (zeile.group_key !== null) termin.groups.push(zeile.group_key)
		termine.set(zeile.date, termin)
	}
	return [...termine.values()]
}

export const planLesen = (db: Database = openDb()): Termin[] =>
	zeilenZuTerminen(
		db
			.prepare<[], PlanZeile>(
				`SELECT d.date, d.note, a.group_key
           FROM cleaning_dates d
           LEFT JOIN cleaning_assignments a ON a.date = d.date
          ORDER BY d.date, a.group_key`,
			)
			.all(),
	)

export const planMitNamen = (db: Database = openDb()): TerminMitNamen[] => {
	const zeilen = db
		.prepare<
			[],
			{
				date: string
				note: string | null
				key: string | null
				label: string | null
			}
		>(
			`SELECT d.date, d.note, g.key, g.label
         FROM cleaning_dates d
         LEFT JOIN cleaning_assignments a ON a.date = d.date
         LEFT JOIN groups g ON g.key = a.group_key
        ORDER BY d.date, g.label, g.key`,
		)
		.all()

	const termine = new Map<string, TerminMitNamen>()
	for (const zeile of zeilen) {
		const termin = termine.get(zeile.date) ?? {
			date: zeile.date,
			note: zeile.note,
			groups: [],
		}
		if (zeile.key !== null) {
			termin.groups.push({ key: zeile.key, label: zeile.label ?? zeile.key })
		}
		termine.set(zeile.date, termin)
	}
	return [...termine.values()]
}

export const terminLesen = (
	date: string,
	db: Database = openDb(),
): Termin | null => planLesen(db).find((t) => t.date === date) ?? null

export const naechsterTerminAb = (
	date: string,
	db: Database = openDb(),
): Termin | null => {
	const zeile = db
		.prepare<[string], { date: string }>(
			'SELECT date FROM cleaning_dates WHERE date >= ? ORDER BY date LIMIT 1',
		)
		.get(date)
	return zeile ? terminLesen(zeile.date, db) : null
}

const pruefeGruppen = (plan: readonly Termin[], db: Database): void => {
	const keys = new Set(plan.flatMap((t) => t.groups))
	const unbekannt = [...keys].filter((key) => !getGroup(key, db))
	if (unbekannt.length > 0) {
		throw new Error(
			`Unbekannte Gruppe(n): ${unbekannt.join(', ')}. Familien sind Gruppen nach der Konvention "familie-<slug>"; list_groups zeigt die vorhandenen, upsert_putzfamilie legt eine an.`,
		)
	}
}

const schreibePlan = (plan: readonly Termin[], db: Database): void => {
	const behalten = new Set(plan.map((t) => t.date))
	const vorhanden = db
		.prepare<[], { date: string }>('SELECT date FROM cleaning_dates')
		.all()
	const loeschen = db.prepare<[string]>(
		'DELETE FROM cleaning_dates WHERE date = ?',
	)
	for (const { date } of vorhanden) {
		if (!behalten.has(date)) loeschen.run(date)
	}

	const terminSchreiben = db.prepare<[string, string | null]>(
		`INSERT INTO cleaning_dates (date, note) VALUES (?, ?)
       ON CONFLICT(date) DO UPDATE SET note = excluded.note
        WHERE cleaning_dates.note IS NOT excluded.note`,
	)
	const zuteilungenLoeschen = db.prepare<[string]>(
		'DELETE FROM cleaning_assignments WHERE date = ?',
	)
	const zuteilen = db.prepare<[string, string]>(
		'INSERT INTO cleaning_assignments (date, group_key) VALUES (?, ?)',
	)

	for (const termin of plan) {
		terminSchreiben.run(termin.date, termin.note)
		zuteilungenLoeschen.run(termin.date)
		for (const key of [...termin.groups].sort()) zuteilen.run(termin.date, key)
	}
}

const anwenden = (
	aenderung: (plan: Termin[]) => Termin[],
	db: Database,
): Termin[] => {
	const tx = db.transaction((): Termin[] => {
		const nachher = aenderung(planLesen(db)).sort(nachDatum)
		pruefeGruppen(nachher, db)
		schreibePlan(nachher, db)
		return planLesen(db)
	})
	return tx()
}

export type TerminEingabe = {
	date: string
	groups: string[]
	note?: string | null
}

export const setzeTermin = (
	eingabe: TerminEingabe,
	db: Database = openDb(),
): Termin[] =>
	anwenden((plan) => {
		const vorhanden = plan.find((t) => t.date === eingabe.date)
		const neu: Termin = {
			date: eingabe.date,
			note:
				eingabe.note === undefined ? (vorhanden?.note ?? null) : eingabe.note,
			groups: eingabe.groups,
		}
		return [...plan.filter((t) => t.date !== eingabe.date), neu]
	}, db)

export type TerminAenderung = {
	date?: string
	groups?: string[]
	note?: string | null
}

export const aendereTermin = (
	date: string,
	aenderung: TerminAenderung,
	db: Database = openDb(),
): Termin[] =>
	anwenden((plan) => {
		const vorhanden = plan.find((t) => t.date === date)
		if (!vorhanden) {
			throw new Error(
				`Kein Termin am ${date}. get_putzplan zeigt die vorhandenen Termine.`,
			)
		}
		const neuesDatum = aenderung.date ?? date
		if (neuesDatum !== date && plan.some((t) => t.date === neuesDatum)) {
			throw new Error(
				`Am ${neuesDatum} gibt es schon einen Termin. Verschiebe ihn zuerst oder loesche ihn mit delete_putztermine.`,
			)
		}
		const neu: Termin = {
			date: neuesDatum,
			note: aenderung.note === undefined ? vorhanden.note : aenderung.note,
			groups: aenderung.groups ?? vorhanden.groups,
		}
		return [...plan.filter((t) => t.date !== date), neu]
	}, db)

export const tauscheTermine = (
	dateA: string,
	dateB: string,
	db: Database = openDb(),
): Termin[] =>
	anwenden((plan) => {
		if (dateA === dateB) {
			throw new Error(
				`Tausch von ${dateA} mit sich selbst — das sind zwei verschiedene Termine oder gar keiner.`,
			)
		}
		const a = plan.find((t) => t.date === dateA)
		const b = plan.find((t) => t.date === dateB)
		const fehlend = [a ? null : dateA, b ? null : dateB].filter(
			(d): d is string => d !== null,
		)
		if (fehlend.length > 0) {
			throw new Error(
				`Kein Termin am ${fehlend.join(' und am ')}. get_putzplan zeigt die vorhandenen Termine.`,
			)
		}
		return plan.map((t) => {
			if (t.date === dateA) return { ...t, groups: b?.groups ?? [] }
			if (t.date === dateB) return { ...t, groups: a?.groups ?? [] }
			return t
		})
	}, db)

export const loescheTermin = (
	date: string,
	db: Database = openDb(),
): Termin[] => anwenden((plan) => plan.filter((t) => t.date !== date), db)

export type LoeschAuswahl = {
	dates?: readonly string[]
	from?: string
	to?: string
}

export type LoeschErgebnis = {
	deleted: { date: string; assignments: number }[]
	missing: string[]
}

export const loescheTermine = (
	auswahl: LoeschAuswahl,
	db: Database = openDb(),
): LoeschErgebnis => {
	if (db.pragma('foreign_keys', { simple: true }) !== 1) {
		throw new Error(
			'loescheTermine: PRAGMA foreign_keys ist aus — die Loesch-Kaskade wuerde nicht greifen',
		)
	}

	const { dates, from, to } = auswahl
	if ((dates === undefined || dates.length === 0) && !from && !to) {
		throw new Error(
			'Nichts ausgewaehlt: entweder `dates` (einzelne Daten) oder `from`/`to` (ein Zeitraum) angeben.',
		)
	}
	if (from && to && from > to) {
		throw new Error(
			`Der Zeitraum faengt nach seinem Ende an (${from} bis ${to}) — from und to vertauscht?`,
		)
	}

	const lauf = db.transaction((): LoeschErgebnis => {
		const vorhanden = new Set(
			db
				.prepare<[], { date: string }>('SELECT date FROM cleaning_dates')
				.all()
				.map((z) => z.date),
		)

		const treffer = new Set<string>()
		const missing: string[] = []
		for (const date of dates ?? []) {
			if (vorhanden.has(date)) treffer.add(date)
			else missing.push(date)
		}
		if (from || to) {
			for (const date of vorhanden) {
				if (from && date < from) continue
				if (to && date > to) continue
				treffer.add(date)
			}
		}

		const zaehleZuteilungen = db.prepare<[string], { n: number }>(
			'SELECT COUNT(*) AS n FROM cleaning_assignments WHERE date = ?',
		)
		const loeschen = db.prepare<[string]>(
			'DELETE FROM cleaning_dates WHERE date = ?',
		)

		const deleted: { date: string; assignments: number }[] = []
		for (const date of [...treffer].sort()) {
			const assignments = zaehleZuteilungen.get(date)?.n ?? 0
			loeschen.run(date)
			deleted.push({ date, assignments })
		}

		return { deleted, missing }
	})

	return lauf()
}

export type PlanAenderung = {
	added: string[]
	removed: string[]
	changed: string[]
	unchanged: number
}

const gleicherTermin = (a: Termin, b: Termin): boolean =>
	a.note === b.note &&
	a.groups.length === b.groups.length &&
	[...a.groups].sort().join(' ') === [...b.groups].sort().join(' ')

export const ersetzePlanMitBericht = (
	termine: readonly TerminEingabe[],
	db: Database = openDb(),
): { plan: Termin[]; aenderung: PlanAenderung } => {
	const lauf = db.transaction(() => {
		const vorher = new Map(planLesen(db).map((t) => [t.date, t]))
		const plan = anwenden(
			() =>
				termine.map(({ date, groups, note }) => ({
					date,
					groups,
					note: note ?? null,
				})),
			db,
		)

		const added: string[] = []
		const changed: string[] = []
		let unchanged = 0
		for (const termin of plan) {
			const alt = vorher.get(termin.date)
			if (!alt) added.push(termin.date)
			else if (gleicherTermin(alt, termin)) unchanged++
			else changed.push(termin.date)
		}
		const nachher = new Set(plan.map((t) => t.date))
		const removed = [...vorher.keys()].filter((d) => !nachher.has(d)).sort()

		return { plan, aenderung: { added, removed, changed, unchanged } }
	})
	return lauf()
}

export const ersetzePlan = (
	termine: readonly TerminEingabe[],
	db: Database = openDb(),
): Termin[] => ersetzePlanMitBericht(termine, db).plan
