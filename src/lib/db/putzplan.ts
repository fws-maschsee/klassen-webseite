import type { Database } from 'better-sqlite3'
import { getGroup } from './groups.ts'
import { openDb } from './index.ts'

/**
 * Der Putzplan als Daten: lesen und schreiben. Mehr nicht.
 *
 * Hier standen einmal vier Regeln — wie viele Familien ein Termin haben muss,
 * wie viel Abstand zwischen zwei Einsaetzen derselben Familie liegt, welche
 * Paarung schon vergeben ist. Sie sind absichtlich WEG.
 *
 * Der Grund ist nicht, dass sie falsch gerechnet haetten. Der Grund ist, dass
 * sie die falsche Frage beantwortet haben. Der Putzplan ist ein Dokument, das
 * ein Mensch einmal im Jahr eintraegt und danach hin und wieder anfasst. Was
 * eine sinnvolle Einteilung ist, weiss die Klasse — sie kennt die Familie mit
 * dem Neugeborenen, den Vater im Schichtdienst und die beiden, die ohnehin
 * immer zusammen kommen. Code, der ihr das ausredet, kennt nichts davon und
 * lehnt trotzdem ab.
 *
 * Was BLEIBT, ist Integritaet und keine Regel — der Unterschied ist der Test:
 * Eine Regel sagt, wie der Plan aussehen SOLL; Integritaet sagt, wann der
 * Datensatz KAPUTT waere. Geblieben sind deshalb genau zwei Dinge, und beide
 * stehen im Schema und nicht in einer Pruefung:
 *
 * - Ein `group_key` muss zu einer existierenden Gruppe gehoeren
 *   (Fremdschluessel). `pruefeGruppen` unten macht daraus nur einen lesbaren
 *   Satz statt "FOREIGN KEY constraint failed".
 * - Dieselbe Familie kann an einem Termin nicht zweimal stehen
 *   (Primaerschluessel `(date, group_key)`). Das faellt strukturell weg und
 *   braucht keine eigene Pruefung.
 *
 * Feldnamen sind englisch (`date`, `groups`, `note`), weil sie in der Datenbank
 * und in den JSON-Antworten der MCP-Werkzeuge stehen — dort liest ein Programm.
 * Was ein Mensch liest, ist deutsch: die Meldungen unten und die Tabelle auf
 * der Seite.
 */
/**
 * Ein Termin, wie der Plan ihn kennt: Datum, Anmerkung, die Gruppen-Keys der
 * eingeteilten Familien.
 */
export type Termin = {
	/** `JJJJ-MM-TT`. Zugleich der Schluessel des Termins. */
	date: string
	/** Freitext der Spalte "Anmerkungen", oder `null`. */
	note: string | null
	/** Group-Keys der eingeteilten Familien, alphabetisch. */
	groups: string[]
}

/** Derselbe Termin mit den Anzeigenamen der Gruppen — fuer die Seite. */
export type TerminMitNamen = Omit<Termin, 'groups'> & {
	groups: { key: string; label: string }[]
}

/** `JJJJ-MM-TT` als Zeichenkette sortiert sich chronologisch. */
const nachDatum = (a: Termin, b: Termin): number =>
	a.date < b.date ? -1 : a.date > b.date ? 1 : 0

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

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

/**
 * Der ganze Plan, aufsteigend nach Datum.
 *
 * `LEFT JOIN`, damit ein Termin ohne Einteilung nicht verschwindet. Ein Datum,
 * zu dem noch niemand eingetragen ist, ist ein voellig normaler Zwischenstand
 * — und wer den Plan fuellt, muss die Luecke SEHEN, sonst fuellt er sie nie.
 */
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

/**
 * Derselbe Plan mit den Anzeigenamen der Familien.
 *
 * Die Seite braucht "Familie Morzynski" und nicht `familie-morzynski`; der Key
 * ist ein technischer Schluessel, der wie ein Name aussieht, und wer ihn auf
 * der Seite liest, haelt ihn fuer die Schreibweise der Familie.
 */
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

/** Ein einzelner Termin, oder `null`. */
export const terminLesen = (
	date: string,
	db: Database = openDb(),
): Termin | null => planLesen(db).find((t) => t.date === date) ?? null

/**
 * Der naechste Termin ab einem Datum (einschliesslich dieses Tages).
 *
 * Einschliesslich, weil ein Erinnerungsdienst, der am Morgen des Putztermins
 * laeuft, genau diesen Termin meint — nicht den in einer Woche.
 */
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

// ---------------------------------------------------------------------------
// Schreiben — alles durch `anwenden`
// ---------------------------------------------------------------------------

/** Wirft, wenn ein Group-Key nicht in der Whitelist `groups` steht. */
const pruefeGruppen = (plan: readonly Termin[], db: Database): void => {
	const keys = new Set(plan.flatMap((t) => t.groups))
	const unbekannt = [...keys].filter((key) => !getGroup(key, db))
	if (unbekannt.length > 0) {
		throw new Error(
			`Unbekannte Gruppe(n): ${unbekannt.join(', ')}. Familien sind Gruppen nach der Konvention "familie-<slug>"; list_groups zeigt die vorhandenen, upsert_putzfamilie legt eine an.`,
		)
	}
}

/**
 * Schreibt den Plan als DIFF und nicht als "alles loeschen, alles neu".
 *
 * Ein unveraenderter Termin behaelt so sein `created_at` und sein `updated_at`
 * — und damit die Auskunft, wann zuletzt jemand an ihm gedreht hat. Bei einem
 * vollstaendigen Neuschreiben traegt nach jedem Tausch der ganze Plan dasselbe
 * Datum, und die Frage "seit wann steht das so?" ist nicht mehr zu beantworten.
 */
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
		// Die Zuteilung wird je Termin komplett ersetzt. Ein Diff auf dieser
		// Ebene waere zwei Zeilen mehr Code fuer zwei Zeilen weniger Schreibarbeit.
		zuteilungenLoeschen.run(termin.date)
		for (const key of [...termin.groups].sort()) zuteilen.run(termin.date, key)
	}
}

/**
 * DAS Tor zum Plan. Liest den Ist-Zustand, laesst die Aenderung darauf rechnen,
 * schreibt das Ergebnis.
 *
 * Hier stand die Pruefung gegen vier Planregeln. Es gibt sie nicht mehr, und
 * dieser Kommentar ist die Stelle, an der steht, warum: Der Plan ist ein
 * Dokument, das ein Mensch eintraegt. Was gilt, entscheidet die Klasse und
 * nicht der Code. Wer hier wieder eine Regel einbaut, nimmt ihr diese
 * Entscheidung ab, ohne zu wissen, was sie weiss.
 *
 * Alles in EINER Transaktion. Uebrig bleibt, was das SCHEMA ohnehin erzwingt:
 * ein unbekannter Gruppen-Key (Fremdschluessel, siehe `pruefeGruppen` fuer die
 * lesbare Fassung der Meldung) und dieselbe Familie zweimal an einem Termin
 * (Primaerschluessel). Schlaegt eines davon fehl, ist nichts geschrieben.
 *
 * @returns den Plan, wie er danach in der Datenbank steht.
 */
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

/** Eingabe fuer `setzeTermin` und `ersetzePlan`. */
export type TerminEingabe = {
	date: string
	groups: string[]
	note?: string | null
}

/**
 * Besetzt einen Termin — vorhandenen umbesetzen oder neuen anlegen.
 *
 * EINE Funktion fuer beides, weil der Unterschied den Aufrufer nichts angeht:
 * "am 21.8. putzen Morzynski und Bauer" ist dieselbe Ansage, ob der Termin
 * schon in der Liste stand oder nicht.
 *
 * `note: undefined` laesst eine vorhandene Anmerkung stehen, `note: null`
 * loescht sie (JSON-Merge-Patch, wie bei `upsertMitglied`).
 */
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

/**
 * Tauscht die Einteilung zweier Termine.
 *
 * Der Fall, um den es hier ueberhaupt geht: Zwei Familien koennen nicht und
 * machen es untereinander aus. Vorher war das ein Commit plus Deploy.
 *
 * Die ANMERKUNG bleibt beim Datum und wandert nicht mit. Sie sagt etwas ueber
 * den Tag ("(Do, da Fr Feiertag)"), nicht ueber die Familien.
 */
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

/** Nimmt einen Termin ganz aus dem Plan. */
export const loescheTermin = (
	date: string,
	db: Database = openDb(),
): Termin[] => anwenden((plan) => plan.filter((t) => t.date !== date), db)

/**
 * Ersetzt den GESAMTEN Plan — der Weg des Imports aus der YAML.
 *
 * Ersetzen und nicht ergaenzen, weil sonst ein zweiter Lauf mit geaenderter
 * Datei die alten Termine stehen liesse und niemand saehe, welche davon noch
 * gelten. Idempotent: Derselbe Inhalt zweimal eingespielt ergibt denselben
 * Zustand.
 */
export const ersetzePlan = (
	termine: readonly TerminEingabe[],
	db: Database = openDb(),
): Termin[] =>
	anwenden(
		() =>
			termine.map(({ date, groups, note }) => ({
				date,
				groups,
				note: note ?? null,
			})),
		db,
	)
