import { existsSync } from 'node:fs'
import type { Loader } from 'astro/loaders'
import { file } from 'astro/loaders'
import { z } from 'astro/zod'

/**
 * Der Putzplan einer Klasse: Schema, Loader und die Umrechnung in Tabellen-
 * zeilen.
 *
 * Die EINTEILUNG liegt im Klassen-Repo, als eine einzige YAML-Datei unter
 * `src/content/putzplan.yaml`. Hier stehen Schema und Darstellung. Diese
 * Aufteilung ist dieselbe wie bei `docs` und `blog` und hat denselben Grund:
 * wer in der Einteilung steht, sind Familiennamen einer bestimmten Klasse und
 * gehören in kein geteiltes Repository.
 *
 * Es gibt bewusst KEINE zweite Darstellung. Vorher stand die Tabelle als
 * Markdown in `src/content/docs/putzen/putzplan.md`; ein Tausch zwischen zwei
 * Familien musste dort von Hand nachgezogen werden, und der Erinnerungsdienst
 * hätte sie aus einer Markdown-Tabelle zurücklesen müssen. Eine gepflegte
 * Tabelle neben den Daten läuft irgendwann auseinander, und dann weiß niemand,
 * welche der beiden gilt.
 *
 * Dieses Modul ist reines TypeScript ohne `astro:content`: `astro:content` ist
 * ein virtuelles Modul und existiert nur innerhalb einer Astro-Kompilierung,
 * `astro/zod` und `astro/loaders` sind echte Module. Deshalb lassen sich Schema
 * und Zeilenaufbau in `tests/klasse/putzplan.test.ts` ohne einen Astro-Build
 * prüfen — und deshalb kann der Erinnerungsdienst später dasselbe Schema
 * benutzen, ohne durch Astro zu laufen.
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
