import { existsSync } from 'node:fs'
import type { Loader } from 'astro/loaders'
import { file } from 'astro/loaders'
import { z } from 'astro/zod'
import type { Database } from 'better-sqlite3'
import { getGroup } from '../lib/db/groups.ts'
import { openDb } from '../lib/db/index.ts'
import { listMitgliederByGroupEffective } from '../lib/db/members.ts'
import {
	naechsterTerminAb,
	planMitNamen,
	type TerminEingabe,
} from '../lib/db/putzplan.ts'

/**
 * Der Putzplan einer Klasse: Schema der abzuloesenden YAML-Datei, die
 * Umrechnung in Tabellenzeilen — und die Schnittstelle, an der der
 * Erinnerungsdienst haengt.
 *
 * Die EINTEILUNG steht seit dem Umzug in der DATENBANK (`src/lib/db/putzplan.ts`)
 * und nicht mehr in `src/content/putzplan.yaml`. Der Grund ist nicht Bequemlich-
 * keit: Die YAML kannte nur Familiennamen (`morzynski`), die Menschen stehen im
 * Adressbuch, und zwischen beidem gab es keine Verbindung — der Plan konnte
 * niemanden anschreiben. Ausserdem war jeder Tausch zwischen zwei Familien ein
 * Commit plus Deploy, und ein Name, der einmal in git steht, bleibt in der
 * Historie.
 *
 * Schema und Loader der YAML bleiben, bis der Import in jeder Klasse gelaufen
 * und geprueft ist; danach koennen sie samt Sammlung entfallen. Die Reihenfolge
 * steht in der README unter „Vom YAML-Putzplan in die Datenbank".
 *
 * Es gibt weiterhin bewusst KEINE zweite Darstellung. Vorher stand die Tabelle
 * als Markdown in `src/content/docs/putzen/putzplan.md`; ein Tausch musste dort
 * von Hand nachgezogen werden. Eine gepflegte Tabelle neben den Daten läuft
 * irgendwann auseinander, und dann weiß niemand, welche der beiden gilt.
 *
 * Dieses Modul ist reines TypeScript ohne `astro:content`: `astro:content` ist
 * ein virtuelles Modul und existiert nur innerhalb einer Astro-Kompilierung,
 * `astro/zod` und `astro/loaders` sind echte Module. Deshalb lassen sich Schema
 * und Zeilenaufbau in `tests/klasse/putzplan.test.ts` ohne einen Astro-Build
 * prüfen — und deshalb kann der Erinnerungsdienst dasselbe Modul benutzen, ohne
 * durch Astro zu laufen.
 */

/**
 * Pfad der Datei im Klassen-Repo, relativ zur Projektwurzel der KLASSE — wie
 * schon bei `createDocsCollection('./src/content/docs')`.
 *
 * Eine Konstante und kein Literal an der Aufrufstelle, weil drei Stellen
 * denselben Pfad meinen müssen: der Loader, seine Prüfung auf Vorhandensein und
 * die Meldung im Build-Log, mit der jemand die Datei anlegt.
 */
export const PUTZPLAN_DATEI = 'src/content/putzplan.yaml'

/**
 * Ein Termin des Putzplans.
 *
 * Drei Entscheidungen darin sind Absicht:
 *
 * - **`z.coerce.date()`, nicht `z.date()`.** `datum` steht in der YAML als
 *   nacktes `2026-08-21`; js-yaml liefert dafür bereits ein `Date`, `new Date()`
 *   in einer anderen Umgebung einen String. `coerce` nimmt beides, `z.date()`
 *   lehnt den String ab.
 * - **`id` steht nicht im Schema.** Der `file()`-Loader zieht sie aus dem Feld
 *   `id` jedes Eintrags und verwaltet sie selbst; sie kommt als
 *   `entry.id` heraus, nicht als `entry.data.id`.
 * - **`familien` ist `.min(1)` und nicht `.length(2)`.** Zwei Familien pro
 *   Termin ist die Regel, aber keine Eigenschaft der Daten: bei einer ungeraden
 *   Zahl von Familien bleibt der letzte Termin mit einer übrig, und ein Tausch
 *   soll kein Schema-Fehler sein.
 */
export const putzplanSchema = z.object({
	datum: z.coerce.date(),
	familien: z
		.array(
			z.object({
				/** Wie der Familienname den Eltern angezeigt wird. */
				name: z.string().min(1),
				/**
				 * Stabiler Schlüssel für den Erinnerungsdienst. Er bleibt gleich, auch
				 * wenn sich der Anzeigename ändert, und wird auf der Seite NICHT
				 * angezeigt.
				 */
				slug: z.string().min(1),
			}),
		)
		.min(1),
	/** Freitext für die Spalte „Anmerkungen", z.B. ein vorgezogener Termin. */
	anmerkung: z.string().optional(),
})

/** Die geprüften Daten eines Termins, ohne die vom Loader verwaltete `id`. */
export type PutzplanDaten = z.infer<typeof putzplanSchema>

/**
 * Ein Eintrag der Sammlung, wie `getCollection('putzplan')` ihn liefert.
 *
 * Absichtlich nur die Felder, die die Darstellung braucht — kein Abbild von
 * Astros `CollectionEntry`. Dadurch lässt sich `putzplanZeilen` mit einfachen
 * Objekten testen, ohne Astros Sammlungstypen nachzubauen.
 */
export type PutzplanEintrag = {
	id: string
	data: PutzplanDaten
}

/**
 * Loader für eine Datei, die es in einer Klasse geben KANN.
 *
 * Astros `file()` ist für Pflichtdateien gebaut: fehlt die Datei, schreibt es
 * `File not found: …` als FEHLER ins Build-Log. Eine Klasse ohne Putzplan-Daten
 * ist aber kein Fehlerfall, sondern der Normalfall — `klasse-christophers` hat
 * heute keine solche Datei. Ein roter Eintrag im Build-Log, den niemand beheben
 * kann und der bei jedem Build wiederkommt, ist genau die Art Rauschen, nach
 * der niemand mehr auf echte Fehler schaut.
 *
 * Deshalb dieser Vorschalter: er prüft die Datei und übergibt nur dann an
 * `file()`. Fehlt sie, bleibt die Sammlung leer und im Log steht eine
 * Information — adressiert an die Person, die die Datei anlegen würde, nicht an
 * die Eltern.
 *
 * Der Pfad wird gegen `context.config.root` aufgelöst und nicht gegen
 * `process.cwd()`, weil `file()` selbst es so macht. Ein `cwd` ist beim Build
 * meistens dasselbe Verzeichnis, aber nicht verlässlich — beim Test der
 * Integration schon nicht mehr.
 */
export const optionaleDatei = (pfad: string): Loader => {
	const dateiLoader = file(pfad)
	return {
		name: 'optionale-datei',
		load: async (context) => {
			if (!existsSync(new URL(pfad, context.config.root))) {
				// Der Store muss geleert werden: Astro hält den Inhalt einer Sammlung
				// zwischen Builds vor. Ohne das Leeren überlebte eine gelöschte Datei
				// als Sammlungsinhalt aus dem Cache.
				context.store.clear()
				context.logger.info(
					`${pfad} gibt es in dieser Klasse nicht — die Sammlung "${context.collection}" bleibt leer.`,
				)
				return
			}
			await dateiLoader.load(context)
		},
	}
}

/**
 * Aufsteigend nach Datum.
 *
 * Auf die Reihenfolge in der Datei darf sich niemand verlassen: sie ist beim
 * Schreiben chronologisch, aber ein nachgetragener Termin landet dort, wo
 * gerade Platz war. Sortiert wird deshalb hier und nicht in der YAML.
 */
export const nachDatum = <T extends { data: { datum: Date } }>(
	eintraege: readonly T[],
): T[] =>
	[...eintraege].sort((a, b) => a.data.datum.getTime() - b.data.datum.getTime())

/**
 * Die Spalte „Familie": `Familie Aumüller/Huhn und Familie Bauer`.
 *
 * Das `Familie `-Präfix steht an JEDEM Namen, so wie es in der alten
 * Markdown-Tabelle stand.
 *
 * Ein Schrägstrich im Namen gehört zu EINER Familie, in der die Eltern
 * verschiedene Nachnamen tragen (`Schmidt/Weber`) — er trennt keine zwei
 * Familien. Zwei Familien sind zwei Einträge und werden mit „und" verbunden.
 * Wer hier mit `/` verbindet, macht die gewachsene Notation unlesbar: aus zwei
 * Familien würde eine mit Doppelnamen.
 *
 * Bei drei oder mehr Familien trennt ein Komma und nur das letzte Glied ein
 * „und". Heute kommt das nicht vor; die Regel steht hier, damit der Fall nicht
 * als `A und B und C` herauskommt, wenn er eintritt.
 */
export const familienSpalte = (
	familien: readonly { name: string }[],
): string => {
	const namen = familien.map(({ name }) => `Familie ${name}`)
	const letzte = namen.at(-1)
	if (namen.length <= 1 || letzte === undefined) return namen.join('')
	return `${namen.slice(0, -1).join(', ')} und ${letzte}`
}

/**
 * Die Spalte „Datum": `TT.MM.JJJJ`, wie die Eltern es gewohnt sind.
 *
 * UTC-Getter und nicht `toLocaleDateString`: `datum` ist ein reines Datum ohne
 * Uhrzeit, und beide Wege dorthin (js-yaml und `new Date('2026-08-21')`) legen
 * es auf Mitternacht UTC. In einer Zeitzone westlich von UTC — und die
 * Zeitzone eines Containers ist nicht verlässlich — läge lokal noch der Vortag,
 * und die Tabelle nennte jeden Termin einen Tag zu früh. Das ist kein
 * Schönheitsfehler: es wäre ein Termin, zu dem niemand kommt.
 */
export const datumDeutsch = (datum: Date): string => {
	const zweistellig = (zahl: number) => String(zahl).padStart(2, '0')
	return `${zweistellig(datum.getUTCDate())}.${zweistellig(datum.getUTCMonth() + 1)}.${datum.getUTCFullYear()}`
}

/** Das Datum als `JJJJ-MM-TT` für das `datetime`-Attribut von `<time>`. */
export const datumIso = (datum: Date): string => {
	const zweistellig = (zahl: number) => String(zahl).padStart(2, '0')
	return `${datum.getUTCFullYear()}-${zweistellig(datum.getUTCMonth() + 1)}-${zweistellig(datum.getUTCDate())}`
}

/** Eine Zeile der Tabelle, fertig zum Ausgeben. */
export type PutzplanZeile = {
	/** Die `id` des Eintrags. Trägt die Zeile als `<tr id>` und macht sie
	 * verlinkbar — und im gerenderten HTML zählbar. */
	id: string
	/** Spalte „Familie". */
	familie: string
	/** Spalte „Datum", deutsch. */
	datum: string
	/** Dasselbe Datum maschinenlesbar, für `<time datetime>`. */
	iso: string
	/** Spalte „Anmerkungen". Leer, wenn keine hinterlegt ist. */
	anmerkung: string
}

/**
 * Die Einträge der Sammlung als Tabellenzeilen — sortiert, vollständig,
 * eine Zeile je Eintrag.
 *
 * Hier wird NICHT gefiltert. Ein weggelassener Termin wäre eine Familie, die
 * nichts von ihrem Einsatz erfährt, und niemand würde es merken: die Seite sähe
 * vollständig aus. Deshalb ist „genau so viele Zeilen wie Einträge" die Aussage,
 * die `tests/klasse/putzplan.test.ts` bewacht — und deshalb steht die Umrechnung
 * hier als eine Funktion und nicht als Ausdruck in der `.astro`-Vorlage.
 */
export const putzplanZeilen = (
	eintraege: readonly PutzplanEintrag[],
): PutzplanZeile[] =>
	nachDatum(eintraege).map(({ id, data }) => ({
		id,
		familie: familienSpalte(data.familien),
		datum: datumDeutsch(data.datum),
		iso: datumIso(data.datum),
		anmerkung: data.anmerkung ?? '',
	}))

// ---------------------------------------------------------------------------
// Der Plan aus der Datenbank
// ---------------------------------------------------------------------------

/**
 * Praefix der Group-Keys, unter denen Familien stehen: `familie-<slug>`.
 *
 * Eine Familie ist eine GRUPPE im bestehenden Modell und kein eigenes
 * Personenmodell. Die Aufloesung Gruppe -> Personen -> Adressen gibt es
 * bereits, sie loest Untergruppen rekursiv mit auf, und sie ist getestet. Ein
 * zweites Modell danebenzustellen hiesse, ab dem naechsten Umzug zwei
 * Wahrheiten darueber zu haben, wer zu einer Familie gehoert.
 *
 * Das Praefix ist Konvention und nicht Zwang: Der Plan zeigt auf `groups.key`
 * und akzeptiert jeden gueltigen Key. Es macht in `list_groups` auf einen Blick
 * sichtbar, welche Gruppen Familien sind und welche Verteiler.
 */
export const FAMILIEN_PRAEFIX = 'familie-'

/** Group-Key einer Familie aus ihrem Slug. */
export const familienGruppenKey = (slug: string): string =>
	slug.startsWith(FAMILIEN_PRAEFIX) ? slug : `${FAMILIEN_PRAEFIX}${slug}`

/** Ein Datum als `JJJJ-MM-TT`, wie die Datenbank es speichert. */
const alsDatumsSchluessel = (datum: Date): string => datumIso(datum)

/**
 * Der Plan aus der Datenbank in der Form, die `putzplanZeilen` erwartet.
 *
 * Der Umweg ueber `PutzplanEintrag` ist Absicht: Die Umrechnung in Tabellen-
 * zeilen — „Familie " vor jedem Namen, „und" statt Schraegstrich, TT.MM.JJJJ in
 * UTC — ist gewachsen und in `tests/klasse/putzplan.test.ts` genau geprueft.
 * Sie ein zweites Mal fuer die Datenbank zu schreiben hiesse, dieselben
 * Sonderfaelle noch einmal zu treffen, und einer davon waere falsch.
 *
 * Der Anzeigename ist das `label` der Gruppe, der `slug` ihr `key`. Damit
 * bleibt die Zusicherung erhalten, dass der Schluessel NICHT auf der Seite
 * landet: `PutzplanZeile` gibt ihn gar nicht heraus.
 */
export const planAlsEintraege = (db: Database = openDb()): PutzplanEintrag[] =>
	planMitNamen(db).map((termin) => ({
		id: termin.date,
		data: {
			datum: new Date(`${termin.date}T00:00:00.000Z`),
			familien: termin.groups.map(({ key, label }) => ({
				name: label,
				slug: key,
			})),
			anmerkung: termin.note ?? undefined,
		},
	}))

/**
 * Der naechste Putztermin ab einem Zeitpunkt — die Frage des
 * Erinnerungsdienstes.
 *
 * `ab` wird auf den UTC-TAG heruntergerechnet und der Tag selbst zaehlt mit:
 * Ein Dienst, der am Morgen des Putztermins laeuft, meint diesen Termin und
 * nicht den in einer Woche.
 *
 * Liefert `null`, wenn kein Termin mehr kommt. Das ist der Normalfall am
 * Schuljahresende und kein Fehler — der Aufrufer schickt dann nichts.
 *
 * `gruppen` sind Group-KEYS und keine Namen. Sie gehen unveraendert in
 * `familienEmpfaenger` weiter; ein Anzeigename waere an dieser Stelle eine
 * Sackgasse, weil sich aus ihm keine Adresse aufloesen laesst.
 */
export const naechsterPutztermin = (
	ab: Date,
	db: Database = openDb(),
): { datum: Date; gruppen: string[] } | null => {
	const termin = naechsterTerminAb(alsDatumsSchluessel(ab), db)
	if (!termin) return null
	return {
		datum: new Date(`${termin.date}T00:00:00.000Z`),
		gruppen: termin.groups,
	}
}

/**
 * Die Mailadressen einer Familie, aufgeloest ueber das bestehende
 * Gruppenmodell — inklusive der Mitglieder etwaiger Untergruppen.
 *
 * Gibt eine LEERE Liste zurueck, wenn es die Gruppe nicht gibt oder kein
 * Mitglied eine Adresse hinterlegt hat. Das ist die wichtigste Zusage dieser
 * Funktion: Der Aufrufer bekommt in beiden Faellen NICHTS und kann den Fall
 * erkennen — statt eine erfundene oder geratene Adresse zu bekommen und eine
 * Erinnerung an jemanden zu schicken, den sie nichts angeht. Wer die
 * Unterscheidung "Gruppe fehlt" gegen "Gruppe ist leer" braucht, fragt
 * `list_groups`; fuer den Versand ist beides derselbe Fall: niemand zu
 * erreichen.
 */
export const familienEmpfaenger = (
	groupKey: string,
	db: Database = openDb(),
): { email: string; name: string | null }[] => {
	if (!getGroup(groupKey, db)) return []
	return listMitgliederByGroupEffective(groupKey, db).flatMap((mitglied) => {
		const email = mitglied.email?.trim()
		if (!email) return []
		const name = [mitglied.first_name, mitglied.last_name]
			.map((teil) => teil.trim())
			.filter((teil) => teil.length > 0)
			.join(' ')
		return [{ email, name: name.length > 0 ? name : null }]
	})
}

/**
 * Was der Import aus der YAML-Datei einer Klasse herausholt: die Familien als
 * Gruppen und die Termine als Plan.
 *
 * BEIDES in dieser Reihenfolge, und deshalb in einem Rutsch: Erst muessen die
 * Familiengruppen existieren, sonst scheitert das Schreiben des Plans an
 * unbekannten Group-Keys. Zwei getrennte Leseläufe über dieselbe Datei wären
 * zwei Gelegenheiten, sie verschieden auszulegen.
 */
export type PutzplanAusDatei = {
	/** Familien als Gruppen: `key` aus dem `slug`, `label` aus dem `name`. */
	familien: { key: string; label: string }[]
	/** Die Termine, fertig fuer `ersetzePlan`. */
	termine: TerminEingabe[]
}

/**
 * Liest die YAML-Datei — die EINZIGE Aufgabe, die ihr nach dem Umzug bleibt:
 * einmal eingelesen zu werden.
 *
 * Laeuft durch denselben Loader und dasselbe Schema wie vorher der Build. Ein
 * zweiter YAML-Leser fuer den Import waere eine zweite Auslegung derselben
 * Datei, und beim ersten Sonderfall — ein `datum` ohne Anfuehrungszeichen, eine
 * Familie mit Schraegstrich im Namen — laesen die beiden verschieden.
 *
 * Fehlt die Datei, kommt eine LEERE Ausbeute zurueck und kein Fehler: Nicht
 * jede Klasse hat einen Putzplan als Daten. Ob daraus ein Fehler wird, ent-
 * scheidet der Aufrufer — das Werkzeug `import_putzplan` sagt es dann deutlich.
 *
 * Der `LoaderContext` ist eine Attrappe wie in `tests/klasse/putzplan.test.ts`
 * und deckt nur ab, was `file()` wirklich benutzt. Ein Vollausbau waere eine
 * zweite, mitzupflegende Fassung von Astro.
 */
export const putzplanAusDatei = async (
	/** Wurzel des Klassen-Repos, gegen die `pfad` aufgeloest wird. */
	wurzel: URL,
	pfad: string = PUTZPLAN_DATEI,
): Promise<PutzplanAusDatei> => {
	const eintraege: PutzplanDaten[] = []

	await optionaleDatei(pfad).load({
		collection: 'putzplan',
		store: {
			clear: () => {
				eintraege.length = 0
			},
			set: ({ data }: { id: string; data: unknown }) => {
				eintraege.push(data as PutzplanDaten)
				return true
			},
		},
		logger: {
			info: () => {},
			warn: () => {},
			error: () => {},
			debug: () => {},
		},
		config: { root: wurzel },
		parseData: async ({ data }: { data: unknown }) =>
			putzplanSchema.parseAsync(data),
		// biome-ignore lint/suspicious/noExplicitAny: Attrappe eines LoaderContext, siehe Kopfkommentar
	} as any)

	// Map und nicht Array: Dieselbe Familie steht in der Datei bei jedem ihrer
	// Termine, mit gleichem `slug` und gleichem `name`. Der letzte Eintrag
	// gewinnt — bei abweichender Schreibweise desselben Slugs ist das eine
	// Entscheidung und kein Zufall: Es gibt EINE Gruppe je Slug.
	const familien = new Map<string, string>()
	for (const daten of eintraege) {
		for (const { name, slug } of daten.familien) {
			familien.set(familienGruppenKey(slug), name)
		}
	}

	return {
		familien: [...familien].map(([key, label]) => ({ key, label })),
		termine: eintraege.map((daten) => ({
			date: datumIso(daten.datum),
			groups: daten.familien.map(({ slug }) => familienGruppenKey(slug)),
			note: daten.anmerkung ?? null,
		})),
	}
}
