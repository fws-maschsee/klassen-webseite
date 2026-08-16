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

/** Was an einem Termin geaendert werden soll. Nicht genanntes bleibt stehen. */
export type TerminAenderung = {
	/** Neues Datum — der Termin wird verschoben. */
	date?: string
	/** Neue Einteilung. */
	groups?: string[]
	/** Neue Anmerkung; `null` loescht sie. */
	note?: string | null
}

/**
 * Aendert einen vorhandenen Termin — auch sein DATUM.
 *
 * Ein verschobener Termin ist eine Aenderung und kein Loeschen plus
 * Neuanlegen. Dass er intern als das zweite geschrieben wird (das Datum ist
 * der Schluessel der Zeile, und ein Schluessel laesst sich nicht in place
 * umbiegen, ohne die Einteilungen mitzunehmen), ist eine Eigenschaft der
 * Tabelle und geht den Aufrufer nichts an: Er sagt "der 21.8. wird der 22.8.",
 * und Einteilung und Anmerkung kommen mit.
 *
 * Was nicht genannt ist, bleibt, wie es war — auch hier JSON-Merge-Patch:
 * `note: undefined` laesst die Anmerkung stehen, `note: null` loescht sie.
 *
 * Der Unterschied zu `setzeTermin`: Das hier verlangt, dass es den Termin
 * GIBT, und kann ihn verschieben. `setzeTermin` legt an oder besetzt um und
 * laesst das Datum, wo es ist.
 */
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
			// Zwei Termine am selben Tag kann die Tabelle nicht — das Datum ist ihr
			// Schluessel. Der Satz sagt, was zu tun ist, statt den Aufrufer an einem
			// UNIQUE-Fehler raten zu lassen.
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
 * Welche Termine geloescht werden sollen: einzelne Daten, ein Zeitraum, oder
 * beides.
 */
export type LoeschAuswahl = {
	/** Einzelne Daten, `JJJJ-MM-TT`. */
	dates?: readonly string[]
	/** Erster Tag eines Zeitraums, einschliesslich. */
	from?: string
	/** Letzter Tag eines Zeitraums, einschliesslich. */
	to?: string
}

/** Was tatsaechlich passiert ist — Feldnamen englisch, weil es in JSON steht. */
export type LoeschErgebnis = {
	/** Je geloeschtem Termin: das Datum und wie viele Einteilungen mitgingen. */
	deleted: { date: string; assignments: number }[]
	/** Angefragte Daten, die es gar nicht gab. Kein Fehler. */
	missing: string[]
}

/**
 * Loescht Termine — einzeln oder als Zeitraum — samt ihren Einteilungen.
 *
 * Dass es dieses Werkzeug gibt, gehoert zur Abschaffung der Planregeln: Wenn
 * der Code die Einteilung nicht mehr beurteilt, muss ein Mensch den Plan von
 * Hand in Ordnung bringen koennen — und dazu gehoert, alte Termine wieder
 * loszuwerden. Der Anlass ist der Jahreswechsel: Ein neuer Plan wird
 * eingespielt, waehrend der alte noch dasteht, und die Datumsbereiche
 * ueberschneiden sich.
 *
 * Der ZEITRAUM ist der eigentliche Punkt. Ein Schuljahr hat ueber vierzig
 * Termine; ohne `from`/`to` waere das Abraeumen eines alten Plans vierzig
 * Aufrufe, und beim achten verliert man den Ueberblick, welche schon weg sind.
 *
 * IDEMPOTENT: Ein Datum, das es nicht gibt, ist kein Fehler, sondern steht in
 * `missing`. Zweimal dasselbe geloescht ergibt beim zweiten Mal eine leere
 * `deleted`-Liste — und keine Ausnahme, die den Aufrufer glauben laesst, es
 * sei etwas schiefgegangen.
 *
 * Nicht ueber `anwenden`: Dort wird der ganze Plan gelesen, umgeschrieben und
 * zurueckgeschrieben. Zum Loeschen ist das der Umweg, und vor allem verlöre es
 * die Auskunft, WIE VIELE Einteilungen mitgegangen sind — die steht nur vor
 * dem `DELETE` fest.
 */
export const loescheTermine = (
	auswahl: LoeschAuswahl,
	db: Database = openDb(),
): LoeschErgebnis => {
	// Die Einteilungen haengen per `ON DELETE CASCADE` am Datum. Ohne dieses
	// Pragma greift die Kaskade NICHT, und zurueck blieben Einteilungen, die auf
	// einen Termin zeigen, den es nicht mehr gibt — ein Plan, der beim naechsten
	// Lesen Zeilen zeigt, die niemand mehr erklaeren kann. `openDb()` setzt es;
	// eine fremde Verbindung vielleicht nicht.
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

		// Einzeln genannte Daten und der Zeitraum ergeben EINE Menge. Ein Datum,
		// das in beidem steht, wird einmal geloescht und einmal gemeldet.
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
			// Vor dem DELETE zaehlen — danach sind die Zeilen weg.
			const assignments = zaehleZuteilungen.get(date)?.n ?? 0
			loeschen.run(date)
			deleted.push({ date, assignments })
		}

		return { deleted, missing }
	})

	return lauf()
}

/** Was ein Massenschreiben am Plan veraendert hat. Englisch, es steht in JSON. */
export type PlanAenderung = {
	/** Daten, die es vorher nicht gab. */
	added: string[]
	/** Daten, die es vorher gab und jetzt nicht mehr. */
	removed: string[]
	/** Daten, die geblieben sind, aber andere Einteilung oder Anmerkung haben. */
	changed: string[]
	/** Wie viele Termine unveraendert geblieben sind. */
	unchanged: number
}

/** Zwei Termine sind gleich, wenn Einteilung und Anmerkung gleich sind. */
const gleicherTermin = (a: Termin, b: Termin): boolean =>
	a.note === b.note &&
	a.groups.length === b.groups.length &&
	[...a.groups].sort().join(' ') === [...b.groups].sort().join(' ')

/**
 * Ersetzt den GESAMTEN Plan und sagt, was sich dabei geaendert hat.
 *
 * ERSETZEN und nicht ergaenzen: Was im Dokument fehlt, ist danach weg. Genau
 * das braucht der Jahreswechsel — ein neuer Plan wird eingespielt, ohne dass
 * vorher jemand den alten von Hand abraeumt. Wuerde es ergaenzen, stuenden
 * danach beide Plaene ineinander und niemand saehe, welche Termine noch
 * gelten.
 *
 * Weil das viel auf einmal ist, kommt ein BERICHT zurueck. Ein Werkzeug, das
 * einen ganzen Jahresplan austauscht und "ok" sagt, ist gefaehrlich: Ein
 * Dokument, dem versehentlich die Haelfte fehlt, sieht im Erfolgsfall genauso
 * aus wie das richtige. Wer `removed: 42` liest, merkt es.
 *
 * IDEMPOTENT: Derselbe Inhalt zweimal eingespielt ergibt denselben Zustand —
 * beim zweiten Mal mit leeren Listen und `unchanged` gleich der Planlaenge.
 */
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

/**
 * Ersetzt den GESAMTEN Plan. Wie `ersetzePlanMitBericht`, nur ohne den
 * Bericht — fuer Aufrufer, die nur den neuen Stand brauchen.
 */
export const ersetzePlan = (
	termine: readonly TerminEingabe[],
	db: Database = openDb(),
): Termin[] => ersetzePlanMitBericht(termine, db).plan
