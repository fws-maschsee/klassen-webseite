import type { Database } from 'better-sqlite3'
import { getGroup } from './groups.ts'
import { openDb } from './index.ts'

/**
 * Der Putzplan als Daten: lesen, schreiben, und die vier Regeln, die einen
 * gueltigen Plan von einem kaputten unterscheiden.
 *
 * Diese Regeln standen einmal als Test ueber einer YAML-Datei im Klassen-Repo.
 * Das hat funktioniert, solange die Datei die einzige Quelle war: Wer sie
 * aenderte, machte einen Commit, und die CI der Klasse sagte nein. Sobald der
 * Plan in der Datenbank steht und ueber MCP geaendert wird, gibt es keinen
 * Commit mehr, gegen den eine CI laufen koennte — ein Test ueber einer Datei,
 * die es nicht mehr gibt, bewacht nichts.
 *
 * Deshalb stehen sie hier, im SCHREIBPFAD, und zwar an genau einer Stelle:
 * `anwenden` unten. Jede aendernde Funktion dieses Moduls geht durch sie
 * hindurch, und keine kann sie versehentlich auslassen.
 *
 * Das Verfahren ist "vorschlagen, pruefen, festschreiben": Die Aenderung wird
 * erst auf dem gelesenen Plan IM SPEICHER ausgefuehrt, das Ergebnis geprueft
 * und nur ein fehlerfreies Ergebnis geschrieben. Der umgekehrte Weg — schreiben
 * und danach pruefen — braucht dieselbe Transaktion, liefert aber schlechtere
 * Meldungen: Ein Termin mit zweimal derselben Familie scheitert dann am
 * Primaerschluessel ("UNIQUE constraint failed") statt an einem Satz, der sagt,
 * welche Familie doppelt steht.
 *
 * Feldnamen sind englisch (`date`, `groups`, `note`), weil sie in der Datenbank
 * und in den JSON-Antworten der MCP-Werkzeuge stehen — dort liest ein Programm.
 * Was ein Mensch liest, ist deutsch: die Meldungen unten und die Tabelle auf
 * der Seite.
 */

/**
 * Wie viele Familien zusammen putzen: mindestens zwei, hoechstens drei.
 * Regel 1.
 *
 * Die Untergrenze ist die eigentliche Regel und aelter als die Obergrenze:
 * Eine Familie allein soll nicht putzen muessen. Die Obergrenze kam dazu,
 * damit ein Termin nicht als Sammelbecken fuer alle endet, die woanders nicht
 * konnten — zu dritt teilt man die Arbeit noch, zu sechst raeumt man
 * uebereinander.
 *
 * Ein Bereich und keine feste Zahl, weil eine ungerade Familienzahl sonst
 * keinen vollen Plan zulaesst: Bei 25 Familien bleibt bei lauter Zweiern eine
 * uebrig, und die stand bisher allein da — was Regel 1 gerade verbietet. Ein
 * Dreier loest genau das.
 */
export const GRUPPEN_JE_TERMIN_MIN = 2
export const GRUPPEN_JE_TERMIN_MAX = 3

/**
 * Wie viele Termine mindestens zwischen zwei Einsaetzen DERSELBEN Familie
 * liegen muessen. Regel 3.
 *
 * Gezaehlt wird in Positionen des Plans, nicht in Wochen: Steht eine Familie am
 * vierten und am achten Termin, ist der Abstand 4 und damit in Ordnung; am
 * vierten und siebten waere er 3 und damit zu klein. Positionen und nicht
 * Kalendertage, weil Ferien den Plan unterbrechen — nach sechs Wochen Sommer
 * waeren zwei aufeinanderfolgende Termine kalendarisch weit auseinander und
 * traefen doch dieselbe Familie zweimal hintereinander.
 */
export const MINDESTABSTAND = 4

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

/** Welche der vier Regeln verletzt ist. Englisch, weil es in JSON auftaucht. */
export type Regel =
	| 'group_count'
	| 'duplicate_group'
	| 'min_gap'
	| 'repeated_pair'

export type Verstoss = {
	rule: Regel
	/** Der Termin, an dem der Verstoss sichtbar wird. */
	date: string
	/** Was los ist, in einem Satz — fuer den Menschen vor dem MCP-Client. */
	text: string
}

/**
 * Der Plan waere nach dieser Aenderung ungueltig.
 *
 * Traegt die Verstoesse einzeln mit, damit ein Aufrufer sie ausgeben kann, ohne
 * die Meldung wieder auseinanderzunehmen.
 */
export class PutzplanVerstoss extends Error {
	readonly verstoesse: readonly Verstoss[]

	constructor(verstoesse: readonly Verstoss[]) {
		super(
			`Der Putzplan waere danach ungueltig:\n  - ${verstoesse
				.map((v) => v.text)
				.join('\n  - ')}`,
		)
		this.name = 'PutzplanVerstoss'
		this.verstoesse = verstoesse
	}
}

/** `JJJJ-MM-TT` als Zeichenkette sortiert sich chronologisch. */
const nachDatum = (a: Termin, b: Termin): number =>
	a.date < b.date ? -1 : a.date > b.date ? 1 : 0

/**
 * Alle vier Regeln auf einmal, als reine Funktion ueber den GESAMTEN Plan.
 *
 * Ueber den gesamten Plan und nicht nur ueber den geaenderten Termin, weil drei
 * der vier Regeln gar keine Eigenschaft eines einzelnen Termins sind: Abstand
 * und Paarung entstehen erst im Verhaeltnis zu den anderen. Wer nur den
 * geaenderten Termin prueft, uebersieht, dass er den Abstand seines NACHFOLGERS
 * kaputtmacht.
 *
 * Liefert eine Liste statt zu werfen, damit dieselbe Funktion auch zum blossen
 * Nachschauen taugt — und damit ein Aufrufer alle Probleme auf einmal sieht
 * statt eines nach dem anderen.
 */
export const planVerstoesse = (plan: readonly Termin[]): Verstoss[] => {
	const sortiert = [...plan].sort(nachDatum)
	const verstoesse: Verstoss[] = []

	// Regel 1 und 2: Eigenschaften eines einzelnen Termins.
	for (const termin of sortiert) {
		if (
			termin.groups.length < GRUPPEN_JE_TERMIN_MIN ||
			termin.groups.length > GRUPPEN_JE_TERMIN_MAX
		) {
			verstoesse.push({
				rule: 'group_count',
				date: termin.date,
				text: `Am ${termin.date} sind ${termin.groups.length} Familien eingeteilt, es muessen mindestens ${GRUPPEN_JE_TERMIN_MIN} und hoechstens ${GRUPPEN_JE_TERMIN_MAX} sein${
					termin.groups.length > 0 ? ` (${termin.groups.join(', ')})` : ''
				}.`,
			})
		}
		const doppelt = new Set(
			termin.groups.filter((key, i) => termin.groups.indexOf(key) !== i),
		)
		for (const key of doppelt) {
			verstoesse.push({
				rule: 'duplicate_group',
				date: termin.date,
				text: `"${key}" steht am ${termin.date} zweimal — eine Familie putzt nicht mit sich selbst.`,
			})
		}
	}

	// Regel 3: Abstand zum letzten Einsatz derselben Familie, in Positionen.
	const letzterEinsatz = new Map<string, number>()
	sortiert.forEach((termin, i) => {
		for (const key of new Set(termin.groups)) {
			const vorher = letzterEinsatz.get(key)
			if (vorher !== undefined && i - vorher < MINDESTABSTAND) {
				verstoesse.push({
					rule: 'min_gap',
					date: termin.date,
					text: `"${key}" putzt am ${sortiert[vorher]?.date} und schon am ${termin.date} wieder — das sind ${i - vorher} ${i - vorher === 1 ? 'Termin' : 'Termine'} Abstand, verlangt sind mindestens ${MINDESTABSTAND}.`,
				})
			}
			letzterEinsatz.set(key, i)
		}
	})

	// Regel 4: Jede Paarung hoechstens einmal im ganzen Plan. Wer schon einmal
	// zusammen geputzt hat, soll beim naechsten Mal jemand anderen kennenlernen
	// — das ist der Zweck der Einteilung und nicht bloss Buchhaltung.
	//
	// Seit ein Termin auch zu dritt besetzt sein darf, muss dastehen, was
	// "Paarung" dann heisst. Zwei Lesarten waeren moeglich:
	//
	// (a) Die BELEGUNG des Termins als Ganzes — `A + B + C` waere ein eigener
	//     Schluessel, der mit `A + B` nichts zu tun haette.
	// (b) Jedes PAAR, das sich an dem Termin begegnet — ein Dreier enthaelt
	//     drei davon: `A + B`, `A + C`, `B + C`.
	//
	// Es gilt (b), und zwar aus dem Zweck der Regel: Sie soll dafuer sorgen,
	// dass Familien einander kennenlernen. Ob A und B zu zweit oder zu dritt
	// zusammen geputzt haben, aendert nichts daran, DASS sie sich begegnet
	// sind. Nach (a) waere die Regel ausserdem still wirkungslos, sobald ein
	// Dreier im Plan steht: `A + B + C` und `A + B` kollidierten nie, und A und
	// B duerften beliebig oft wieder zusammen — eine Regel, die nicht mehr
	// ablehnt, ohne dass jemand sie abgeschafft haette.
	//
	// Der Preis ist ehrlich zu nennen: Ein Dreier verbraucht drei Paarungen
	// statt einer und schraenkt den restlichen Plan entsprechend staerker ein.
	// Das ist die richtige Seite, auf der man irrt — sie lehnt zu viel ab und
	// nicht zu wenig, und ein abgelehnter Termin sagt, warum.
	const paare = new Map<string, string>()
	for (const termin of sortiert) {
		const beteiligte = [...new Set(termin.groups)].sort()
		for (let i = 0; i < beteiligte.length; i++) {
			for (let j = i + 1; j < beteiligte.length; j++) {
				const paar = `${beteiligte[i]} + ${beteiligte[j]}`
				const frueher = paare.get(paar)
				if (frueher !== undefined) {
					verstoesse.push({
						rule: 'repeated_pair',
						date: termin.date,
						text: `${paar} sind am ${termin.date} eingeteilt und waren es schon am ${frueher} — jede Paarung kommt im Plan nur einmal vor.`,
					})
				} else {
					paare.set(paar, termin.date)
				}
			}
		}
	}

	return verstoesse
}

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
 * `LEFT JOIN`, damit ein Termin ohne Einteilung nicht verschwindet. Es darf ihn
 * nach Regel 1 nicht geben — aber wenn er da ist, muss man ihn SEHEN, sonst
 * meldet die Pruefung einen Verstoss an einem Termin, den die Liste gar nicht
 * zeigt.
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
 * DAS Tor zum Plan. Liest den Ist-Zustand, laesst die Aenderung darauf
 * rechnen, prueft das Ergebnis gegen alle vier Regeln und schreibt erst dann.
 *
 * Alles in EINER Transaktion: Wirft die Pruefung, ist nichts geschrieben.
 *
 * @returns den Plan, wie er danach in der Datenbank steht.
 */
const anwenden = (
	aenderung: (plan: Termin[]) => Termin[],
	db: Database,
): Termin[] => {
	const tx = db.transaction((): Termin[] => {
		const nachher = aenderung(planLesen(db)).sort(nachDatum)
		const verstoesse = planVerstoesse(nachher)
		if (verstoesse.length > 0) throw new PutzplanVerstoss(verstoesse)
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
 *
 * Die Pruefung laeuft trotzdem: Ein Tausch aendert keine Paarung, aber sehr
 * wohl die Abstaende — genau daran scheitert der gut gemeinte Tausch, der eine
 * Familie zweimal in drei Wochen einteilt.
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
