import SQLite, { type Database } from 'better-sqlite3'
import { runMigrations } from '../../migrations.ts'
import { addSubgroup, upsertGroup } from './groups.ts'
import { openDb } from './index.ts'
import { upsertMailingList } from './mailingLists.ts'
import { GROUP_ELTERN, upsertMitglied } from './members.ts'
import { ersetzePlan } from './putzplan.ts'

/**
 * ERFUNDENE Saatdaten fuer eine Vorschau-Umgebung (PR-Preview).
 *
 * ============================================================================
 * WARUM HIER KEINE ECHTEN DATEN STEHEN — UND AUCH NIE STEHEN WERDEN
 * ============================================================================
 *
 * In der Produktionsdatenbank jeder Klasse stehen die Namen und Adressen von
 * rund hundert echten Familien. Eine Vorschau ist eine Umgebung, die aus einem
 * Pull Request entsteht: Sie laeuft unter einer wechselnden Adresse, sie
 * enthaelt den Code eines Zweigs, den noch niemand gelesen hat, und sie
 * verschwindet wieder, wenn der Pull Request zugeht. Genau deshalb gehoeren
 * dort keine echten Personendaten hin.
 *
 * Wer hier spaeter einmal "nur kurz mal mit echten Daten" testen will — sei es
 * ueber einen gemeinsamen PVC, ein `kubectl cp` der Produktionsdatei oder eine
 * Wiederherstellung aus einem Backup — moege bitte drei Dinge bedenken:
 *
 *  1. Es ist eine Weitergabe personenbezogener Daten an einen Zweck, dem
 *     niemand zugestimmt hat. Die Eltern haben ihre Adresse fuer den
 *     Klassenverteiler hinterlegt, nicht fuer die Fehlersuche.
 *  2. Eine Vorschau ist strukturell schlechter geschuetzt als die Produktion:
 *     Sie traegt Code, der noch nicht gereviewt ist, und ihr Login haengt an
 *     einem ZITADEL-Zugang mit `devMode` (wechselnde Ruecksprungadressen).
 *     Ein Fehler im Zweig, der die Anmeldung aushebelt, faellt hier per
 *     Definition zuerst auf — mit echten Daten dahinter.
 *  3. Vorschau-Datentraeger sind `emptyDir`. Sie sind fluechtig, es gibt kein
 *     Backup und niemanden, der eine Loeschanfrage darauf ausfuehren koennte.
 *
 * Deshalb: Eine Vorschau bekommt einen EIGENEN, LEEREN Datentraeger und wird
 * beim Start mit den erfundenen Daten aus dieser Datei befuellt. Es gibt keinen
 * Kopierschritt aus der Produktion, und es soll auch keinen geben.
 *
 * ============================================================================
 * DIE SICHERUNG
 * ============================================================================
 *
 * `seedDemoData()` schreibt NUR in eine FRISCH MIGRIERTE Datenbank. Geprueft
 * wird das nicht an einer Handvoll bekannter Tabellen, sondern an ALLEN
 * Tabellen des Schemas, und zwar gegen eine im Speicher frisch migrierte
 * Vergleichsdatenbank (`abweichungGegenFrisch` unten). Steht irgendwo auch nur
 * eine Zeile mehr, als die Migrationen selbst anlegen, passiert nichts ausser
 * einer Zeile im Protokoll.
 *
 * Das ist die Sicherung dafuer, dass der Schalter `SEED_DEMO_DATA` in der
 * Produktion NICHTS tut: Die Produktionsdatenbank ist nicht frisch — in
 * `app_meta` steht seit dem ersten Start die Instanz-Identitaet, in
 * `mitglieder` stehen die Familien. Selbst wenn jemand die Variable dort aus
 * Versehen setzt, wird kein Datensatz angefasst. Gepruefte Aussage, kein
 * Vorsatz: `tests/db/saatdaten.test.ts`.
 *
 * Die Saat liegt im GETEILTEN Code und nicht in den Klassen-Repos, damit beide
 * Klassen dieselben erfundenen Daten sehen: Eine Vorschau soll zeigen, wie der
 * Code sich verhaelt, und nicht, welche Klasse man gerade erwischt hat.
 */

/**
 * Erfundene Familien. Die Nachnamen sind Baumnamen — unverwechselbar erfunden
 * und damit garantiert nicht der Nachname einer echten Familie. Die Adressen
 * liegen auf `example.org`; die Domain ist nach RFC 2606 reserviert und kann
 * keine Mail annehmen, eine versehentlich abgeschickte Nachricht geht also
 * nirgendwohin.
 */
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

/** Group-Key einer erfundenen Familie — dieselbe Konvention wie im Echtbetrieb. */
const familienKey = (nachname: string): string =>
	`familie-${nachname.toLowerCase()}`

/**
 * Die Einteilung des Putzplans, als Paare von Familien-Indizes.
 *
 * Nicht frei zusammengewuerfelt: `ersetzePlan` prueft den Plan gegen die vier
 * Regeln aus `putzplan.ts`, und ein ungueltiger Plan wuerde den Start der
 * Vorschau abbrechen. Diese Folge haelt alle vier ein — genau zwei Familien je
 * Termin, keine Familie doppelt, mindestens vier Termine Abstand zwischen zwei
 * Einsaetzen derselben Familie, und jede Paarung genau einmal.
 *
 * Nebenbei ist sie der Grund, warum es zehn Familien sind und nicht acht: Bei
 * acht Familien und zwei je Termin muss jede Familie in JEDEM Fenster von vier
 * Terminen genau einmal vorkommen — der Plan hat dann zwangslaeufig die
 * Periode vier und wiederholt ab dem fuenften Termin seine Paarungen.
 */
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

/** Erster Putztermin: der naechste Freitag ab `ab` (00:00 UTC gerechnet). */
const naechsterFreitag = (ab: Date): Date => {
	const tag = new Date(
		Date.UTC(ab.getUTCFullYear(), ab.getUTCMonth(), ab.getUTCDate()),
	)
	// 5 = Freitag. `|| 7` schiebt auf den naechsten Freitag statt auf heute —
	// ein Termin heute waere in der Vorschau sofort "ueberfaellig".
	const bisFreitag = (5 - tag.getUTCDay() + 7) % 7 || 7
	tag.setUTCDate(tag.getUTCDate() + bisFreitag)
	return tag
}

/** `JJJJ-MM-TT` — das Format, das `cleaning_dates.date` per CHECK verlangt. */
const alsDatum = (d: Date): string => d.toISOString().slice(0, 10)

/**
 * Buchhaltung des Migrationslaufs — zaehlt bei der Pruefung nicht mit.
 *
 * `app_meta` steht bewusst NICHT hier: Dort schreibt der Server beim ersten
 * Start die Instanz-Identitaet hinein, und eine Datenbank, die das schon hinter
 * sich hat, ist keine frische mehr.
 */
const BUCHHALTUNG = new Set(['schema_migrations'])

/**
 * Namen aller Tabellen des Schemas — aus `sqlite_master` gelesen und nicht als
 * Liste gepflegt. Eine gepflegte Liste vergisst die naechste Migration, und
 * dann prueft die Sicherung eine Tabelle nicht, in der die echten Daten
 * stehen.
 */
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

/** Eine Tabelle, deren Inhalt nicht dem einer frisch migrierten Datei entspricht. */
export type Abweichung = { tabelle: string; ist: number; soll: number }

/**
 * Ist diese Datenbank frisch — also genau das, was die Migrationen erzeugen?
 *
 * "Leer" heisst hier ausdruecklich NICHT "null Zeilen ueberall": Die Migration
 * `create_groups` legt die Systemgruppe `eltern` an, und eine kuenftige
 * Migration wird weitere Zeilen mitbringen. Verglichen wird deshalb gegen eine
 * frisch migrierte Datenbank im Speicher — dieselben Migrationen, derselbe
 * Runner. Damit pflegt sich die Sicherung selbst: Was eine Migration anlegt,
 * gilt automatisch als Grundzustand; jede Zeile darueber hinaus ist Inhalt und
 * laesst die Saat abbrechen.
 *
 * Liefert die erste Tabelle, die abweicht, oder `null` fuer "frisch".
 */
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
	/** `false`, wenn die Datenbank nicht frisch war — dann wurde nichts geschrieben. */
	gesaet: boolean
	/** Die Tabelle, die den Abbruch ausgeloest hat. */
	grund?: Abweichung
	familien: number
	mitglieder: number
	termine: number
	verteiler: number
}

/**
 * Befuellt eine FRISCHE Datenbank mit den erfundenen Daten oben.
 *
 * Tut nichts, wenn irgendeine Tabelle mehr enthaelt, als die Migrationen
 * anlegen — siehe die Sicherung im Dateikopf. Der Rueckgabewert sagt, was
 * passiert ist; der Aufrufer protokolliert es.
 *
 * @param jetzt Bezugszeitpunkt fuer die Putztermine. Nur Tests setzen ihn;
 *   sonst wandert der Plan mit dem Kalender mit, statt in der Vergangenheit zu
 *   liegen.
 */
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
		// Die Dachgruppe. Denselben Key benutzt der Echtbetrieb (GROUP_ELTERN),
		// damit die Vorschau die Verteiler-Seite zeigt, die es wirklich gibt.
		upsertGroup({ key: GROUP_ELTERN, label: 'Alle Eltern' }, db)
		upsertGroup(
			{ key: 'elternvertretung', label: 'Elternvertretung (Vorschau)' },
			db,
		)

		let mitglieder = 0
		for (const familie of FAMILIEN) {
			const key = familienKey(familie.nachname)
			upsertGroup({ key, label: `Familie ${familie.nachname}` }, db)
			// Die Familiengruppe haengt unter `eltern`. Damit loest ein Verteiler
			// an `eltern` rekursiv auf alle Familien auf — dieselbe Mechanik wie
			// im Echtbetrieb, nur mit erfundenen Namen.
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

		// Zwei Personen zusaetzlich in die Elternvertretung — sonst ist die
		// zweite Gruppe leer und die Vorschau zeigt nicht, wie eine
		// Mehrfachzugehoerigkeit aussieht.
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
