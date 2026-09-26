import SQLite, { type Database } from 'better-sqlite3'
import { runMigrations } from '../../migrations.ts'
import { addSubgroup, upsertGroup } from './groups.ts'
import { openDb } from './index.ts'
import { upsertMailingList } from './mailingLists.ts'
import { GROUP_ELTERN, upsertMitglied } from './members.ts'
import { ersetzePlan } from './putzplan.ts'

const FAMILIEN = [
	{ nachname: 'Ahorn', erwachsene: ['Anna', 'Arne'] },
	{ nachname: 'Birke', erwachsene: ['Bente'] },
	{ nachname: 'Eiche', erwachsene: ['Elif', 'Emil'] },
	{ nachname: 'Erle', erwachsene: ['Enno'] },
	{ nachname: 'Esche', erwachsene: ['Frieda'] },
	{ nachname: 'Fichte', erwachsene: ['Greta', 'Gregor'] },
	{ nachname: 'Kiefer', erwachsene: ['Hanna'] },
	{ nachname: 'Linde', erwachsene: ['Ida', 'Ilja'] },
	{ nachname: 'Pappel', erwachsene: ['Jonas'] },
	{ nachname: 'Ulme', erwachsene: ['Karla', 'Kolja'] },
] as const

const familienKey = (nachname: string): string =>
	`familie-${nachname.toLowerCase()}`

const PUTZPAARE: readonly (readonly [number, number])[] = [
	[0, 1],
	[2, 3],
	[4, 5],
	[6, 7],
	[8, 9],
	[0, 2],
	[1, 3],
	[4, 6],
	[5, 8],
	[7, 9],
	[0, 3],
	[1, 2],
]

const naechsterFreitag = (ab: Date): Date => {
	const tag = new Date(
		Date.UTC(ab.getUTCFullYear(), ab.getUTCMonth(), ab.getUTCDate()),
	)
	const bisFreitag = (5 - tag.getUTCDay() + 7) % 7 || 7
	tag.setUTCDate(tag.getUTCDate() + bisFreitag)
	return tag
}

const alsDatum = (d: Date): string => d.toISOString().slice(0, 10)

const BUCHHALTUNG = new Set(['schema_migrations'])

const tabellen = (db: Database): string[] =>
	db
		.prepare<[], { name: string }>(
			`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
		)
		.all()
		.map((zeile) => zeile.name)
		.filter((name) => !BUCHHALTUNG.has(name))

const anzahl = (db: Database, tabelle: string): number =>
	db
		.prepare<[], { anzahl: number }>(
			`SELECT COUNT(*) AS anzahl FROM "${tabelle}"`,
		)
		.get()?.anzahl ?? 0

export type Abweichung = { tabelle: string; ist: number; soll: number }

export const abweichungGegenFrisch = (
	db: Database = openDb(),
	klassenVerzeichnisse: readonly string[] = [],
): Abweichung | null => {
	const frisch = new SQLite(':memory:')
	try {
		frisch.pragma('foreign_keys = ON')
		runMigrations(frisch, klassenVerzeichnisse)
		const bekannt = new Set(tabellen(frisch))
		for (const name of tabellen(db)) {
			const ist = anzahl(db, name)
			const soll = bekannt.has(name) ? anzahl(frisch, name) : 0
			if (ist !== soll) return { tabelle: name, ist, soll }
		}
	} finally {
		frisch.close()
	}
	return null
}

export type SaatErgebnis = {
	gesaet: boolean
	grund?: Abweichung
	familien: number
	mitglieder: number
	termine: number
	verteiler: number
}

export const seedDemoData = (
	db: Database = openDb(),
	jetzt: Date = new Date(),
	klassenVerzeichnisse: readonly string[] = [],
): SaatErgebnis => {
	const abweichung = abweichungGegenFrisch(db, klassenVerzeichnisse)
	if (abweichung !== null) {
		return {
			gesaet: false,
			grund: abweichung,
			familien: 0,
			mitglieder: 0,
			termine: 0,
			verteiler: 0,
		}
	}

	const tx = db.transaction(() => {
		upsertGroup({ key: GROUP_ELTERN, label: 'Alle Eltern' }, db)
		upsertGroup(
			{ key: 'elternvertretung', label: 'Elternvertretung (Vorschau)' },
			db,
		)

		let mitglieder = 0
		for (const familie of FAMILIEN) {
			const key = familienKey(familie.nachname)
			upsertGroup({ key, label: `Familie ${familie.nachname}` }, db)
			addSubgroup(GROUP_ELTERN, key, db)
			for (const vorname of familie.erwachsene) {
				upsertMitglied(
					{
						first_name: vorname,
						last_name: familie.nachname,
						email: `${vorname.toLowerCase()}.${familie.nachname.toLowerCase()}@example.org`,
						groups: [key],
					},
					db,
				)
				mitglieder += 1
			}
		}

		for (const [vorname, nachname] of [
			['Anna', 'Ahorn'],
			['Jonas', 'Pappel'],
		] as const) {
			upsertMitglied(
				{
					first_name: vorname,
					last_name: nachname,
					groups: [familienKey(nachname), 'elternvertretung'],
				},
				db,
			)
		}

		const start = naechsterFreitag(jetzt)
		const termine = PUTZPAARE.map((paar, i) => {
			const datum = new Date(start)
			datum.setUTCDate(datum.getUTCDate() + i * 7)
			return {
				date: alsDatum(datum),
				groups: paar.map((index) =>
					familienKey(FAMILIEN[index]?.nachname ?? ''),
				),
				note: i === 3 ? 'Erfundener Termin — nur zur Ansicht' : null,
			}
		})
		ersetzePlan(termine, db)

		upsertMailingList(
			{
				address: 'eltern',
				label: 'Alle Eltern (Vorschau)',
				recipient_groups: [GROUP_ELTERN],
				reply_mode: 'list',
				subject_prefix: '[Vorschau]',
				broadcast: true,
			},
			db,
		)
		upsertMailingList(
			{
				address: 'elternvertretung',
				label: 'Elternvertretung (Vorschau)',
				recipient_groups: ['elternvertretung'],
				poster_policy: 'eingeschraenkt',
				poster_groups: ['elternvertretung'],
				reply_mode: 'list',
				subject_prefix: '[Vorschau]',
			},
			db,
		)

		return {
			gesaet: true as const,
			familien: FAMILIEN.length,
			mitglieder,
			termine: termine.length,
			verteiler: 2,
		}
	})

	return tx()
}
