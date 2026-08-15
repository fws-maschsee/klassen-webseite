import { z } from 'astro/zod'

/**
 * Der Stundenplan einer Klasse: Schema der YAML-Datei und die Umrechnung in ein
 * Raster, das Seite und PDF gemeinsam benutzen.
 *
 * Der Plan ist DATEN und keine Prosa — eine Einteilung mit Uhrzeit und
 * Zuordnung. Er steht deshalb in genau einer YAML-Datei der Klasse, und Seite
 * wie PDF werden daraus erzeugt. Eine zweite, von Hand gepflegte Tabelle
 * daneben wiche beim ersten Wechsel ab, und danach könnte niemand mehr sagen,
 * welche der beiden gilt. Dieselbe Begründung steht ausführlich in der README
 * unter „Strukturierte Daten".
 *
 * Reines TypeScript ohne `astro:content`: `astro:content` ist ein virtuelles
 * Modul und existiert nur innerhalb einer Astro-Kompilierung, `astro/zod` ist
 * ein echtes Modul. Deshalb lassen sich Schema und Rasteraufbau in
 * `tests/klasse/stundenplan.test.ts` ohne Astro-Build prüfen — und deshalb kann
 * das PDF dasselbe Modul benutzen, ohne durch Astro zu laufen.
 */

/**
 * Pfad der Datei im Klassen-Repo, relativ zur Projektwurzel der KLASSE — wie
 * schon bei `createDocsCollection('./src/content/docs')`.
 *
 * Eine Konstante und kein Literal an der Aufrufstelle, weil drei Stellen
 * denselben Pfad meinen müssen: der Loader, seine Prüfung auf Vorhandensein und
 * die Meldung im Build-Log, mit der jemand die Datei anlegt.
 */
export const STUNDENPLAN_DATEI = 'src/content/stundenplan.yaml'

/**
 * Die Schultage, in der Reihenfolge, in der sie in der Tabelle stehen.
 *
 * Fest und nicht aus der Datei abgeleitet: Ein Plan, dessen Spalten davon
 * abhängen, an welchen Tagen zufällig Unterricht eingetragen ist, verschiebt
 * beim Streichen einer einzelnen Stunde die ganze Tabelle. Samstag steht nicht
 * dabei, weil es in dieser Schule keinen Samstagsunterricht gibt; ihn
 * nachzutragen ist eine Zeile hier und keine Änderung an der Datei einer
 * Klasse.
 */
export const TAGE = ['mo', 'di', 'mi', 'do', 'fr'] as const

export type Tag = (typeof TAGE)[number]

/** Was in der Kopfzeile über der Spalte steht. */
export const TAG_NAMEN: Record<Tag, string> = {
	mo: 'Montag',
	di: 'Dienstag',
	mi: 'Mittwoch',
	do: 'Donnerstag',
	fr: 'Freitag',
}

/** Kurzform für schmale Darstellungen — Handy und PDF-Kopfzeile. */
export const TAG_KUERZEL: Record<Tag, string> = {
	mo: 'Mo',
	di: 'Di',
	mi: 'Mi',
	do: 'Do',
	fr: 'Fr',
}

/**
 * Was an einem Tag in einem Zeitfenster stattfindet.
 *
 * Zwei Formen, und die kürzere ist die häufigere:
 *
 * - **Ein String** — alle haben dasselbe (`mi: Sport`).
 * - **Eine Zuordnung** — die Klasse ist geteilt (`do: {A: Englisch, B:
 *   Handarbeit}`). Die Schlüssel sind die Gruppennamen und stehen frei in der
 *   Datei; welche es gibt, ergibt sich aus der Datei selbst
 *   (siehe `gruppenAus`).
 *
 * Fehlt der Tag ganz, ist frei. Das ist der Grund für die Union statt eines
 * Objekts mit `alle`/`gruppen`: Der häufigste Fall soll in der YAML eine Zeile
 * sein und nicht drei, sonst pflegt ihn irgendwann niemand mehr.
 */
export const belegungSchema = z.union([
	z.string().min(1),
	z.record(z.string().min(1), z.string().min(1)),
])

export type Belegung = z.infer<typeof belegungSchema>

/** `08:15` — vierundzwanzigstündig und zweistellig, damit Sortieren geht. */
const uhrzeit = z
	.string()
	.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit als HH:MM, z.B. 08:15')

/**
 * Ein Zeitfenster des Tagesrasters — eine Zeile der Tabelle.
 *
 * **Der Hauptunterricht steht als ZWEI Zeitfenster in der Datei** (8:15–9:10
 * und 9:10–10:00) und nicht als eines von 8:15 bis 10:00. Das ist keine
 * Förmlichkeit, sondern der Grund, warum das Raster überhaupt aufgeht: Am
 * Donnerstag liegt in genau diesen beiden Fenstern für die eine Gruppe
 * Englisch und danach Französisch, für die andere durchgehend Handarbeit. Mit
 * einem einzigen Fenster von 8:15 bis 10:00 ließe sich das nicht hinschreiben,
 * und der offizielle Plan der Schule führt die beiden Stunden aus demselben
 * Grund getrennt auf. Zusammengefasst wird beim Anzeigen (`planFuerGruppe`),
 * nicht in der Datei.
 *
 * `id` steht nicht im Schema: Der `file()`-Loader zieht sie aus dem Feld `id`
 * der YAML und reicht den Rest hier durch. Sie ist trotzdem Pflicht — ohne sie
 * lehnt der Loader den Eintrag ab.
 */
export const stundenplanSchema = z.object({
	von: uhrzeit,
	bis: uhrzeit,
	/** `1. Stunde`, `2. Fachstunde` — was links neben der Uhrzeit steht. */
	bezeichnung: z.string().min(1),
	/**
	 * Die Pause NACH diesem Fenster, wenn es eine nennenswerte ist.
	 *
	 * Sie trennt zugleich die Blöcke: Über eine Pause hinweg werden gleiche
	 * Fächer NICHT zu einer Zelle zusammengefasst. Zwei Stunden Handarbeit mit
	 * der Mittagspause dazwischen sind für ein Kind zwei Stunden, und ein Block,
	 * der quer über die Mittagspause geht, behauptet das Gegenteil. Die fünf
	 * Minuten zwischen zwei Fachstunden stehen deshalb bewusst NICHT hier.
	 */
	pauseDanach: z.string().min(1).optional(),
	mo: belegungSchema.optional(),
	di: belegungSchema.optional(),
	mi: belegungSchema.optional(),
	do: belegungSchema.optional(),
	fr: belegungSchema.optional(),
})

/** Die geprüften Daten eines Zeitfensters, ohne die vom Loader verwaltete `id`. */
export type StundenplanDaten = z.infer<typeof stundenplanSchema>

/**
 * Ein Eintrag der Sammlung, so wie ihn `getCollection` liefert.
 *
 * Eigener Typ statt `CollectionEntry<'stundenplan'>`, damit dieses Modul ohne
 * `astro:content` auskommt — und Tests damit an schlichten Objekten prüfen
 * können, ohne Astros Sammlungstypen nachzubauen.
 */
export type StundenplanEintrag = {
	id: string
	data: StundenplanDaten
}

/**
 * Aufsteigend nach Beginn.
 *
 * Auf die Reihenfolge in der Datei darf sich niemand verlassen: Sie ist beim
 * Schreiben chronologisch, aber ein nachgetragenes Fenster landet dort, wo
 * gerade Platz war. `HH:MM` ist zweistellig und lässt sich deshalb als Text
 * vergleichen — ein Datum daraus zu bauen wäre eine Zeitzone, die hier niemand
 * braucht.
 */
export const nachBeginn = <T extends { data: { von: string } }>(
	eintraege: readonly T[],
): T[] => [...eintraege].sort((a, b) => a.data.von.localeCompare(b.data.von))

/**
 * Welche Gruppen es gibt — abgeleitet aus der Datei, nicht daneben gepflegt.
 *
 * Alphabetisch, damit die Reihenfolge nicht davon abhängt, in welcher Zeile die
 * Teilung zum ersten Mal vorkommt. Eine ungeteilte Klasse liefert eine leere
 * Liste; die Aufrufer machen daraus einen einzigen Plan ohne Gruppenüberschrift
 * (siehe `plaene`).
 *
 * Bewusst KEIN eigenes Feld in der YAML: Eine Gruppe, die oben deklariert ist
 * und unten in keiner Zeile vorkommt, ergäbe einen leeren Plan, und eine
 * Gruppe, die unten vorkommt und oben fehlt, ein stilles Loch. Beides kann
 * nicht passieren, wenn es die Liste gar nicht erst gibt.
 */
export const gruppenAus = (
	eintraege: readonly StundenplanEintrag[],
): string[] => {
	const gefunden = new Set<string>()
	for (const eintrag of eintraege) {
		for (const tag of TAGE) {
			const belegung = eintrag.data[tag]
			if (belegung && typeof belegung !== 'string') {
				for (const gruppe of Object.keys(belegung)) gefunden.add(gruppe)
			}
		}
	}
	return [...gefunden].sort((a, b) => a.localeCompare(b, 'de'))
}

/**
 * Das Fach, das eine bestimmte Gruppe in diesem Fenster an diesem Tag hat —
 * oder `null` für frei.
 *
 * Ein String gilt für alle, auch wenn die Klasse anderswo geteilt ist: Sport am
 * Mittwoch steht einmal da und gilt für A wie für B.
 */
export const fachFuer = (
	daten: StundenplanDaten,
	tag: Tag,
	gruppe: string,
): string | null => {
	const belegung = daten[tag]
	if (!belegung) return null
	if (typeof belegung === 'string') return belegung
	return belegung[gruppe] ?? null
}

/**
 * Eine Zelle der fertigen Tabelle.
 *
 * `ueberdeckt` ist kein Inhalt, sondern eine Lücke: Die Zelle darüber reicht
 * mit `zeilen > 1` bis hierher, und diese Position darf deshalb nichts eigenes
 * ausgeben. HTML braucht dafür genau diese Unterscheidung (`rowspan` plus
 * fehlendes `<td>`), Typst ebenso (`table.cell(rowspan: …)` plus fehlender
 * Eintrag) — deshalb steht sie hier einmal und nicht zweimal in den beiden
 * Vorlagen.
 */
export type Planzelle =
	| { art: 'fach'; fach: string; zeilen: number }
	| { art: 'frei'; zeilen: number }
	| { art: 'ueberdeckt' }

/** Eine Zeile der fertigen Tabelle: ein Zeitfenster quer über alle Tage. */
export type Planzeile = {
	id: string
	von: string
	bis: string
	bezeichnung: string
	/** Der Text der Pause danach, oder `null`. */
	pauseDanach: string | null
	/** Je ein Eintrag pro Tag, in der Reihenfolge von `TAGE`. */
	zellen: Planzelle[]
}

/** Der fertige Plan einer Gruppe. */
export type Gruppenplan = {
	/** Gruppenname, oder `''` für eine ungeteilte Klasse. */
	gruppe: string
	zeilen: Planzeile[]
}

/**
 * Das Raster einer Gruppe, mit zusammengefassten Doppelstunden.
 *
 * Zusammengefasst wird nur, was unmittelbar aufeinander folgt, dasselbe Fach
 * trägt UND nicht durch eine Pause getrennt ist. Der Hauptunterricht wird damit
 * wieder zu einem Block über beide Morgenstunden — dort steht er in der Datei
 * absichtlich als zwei Fenster, weil der Donnerstag anders nicht abzubilden
 * wäre.
 *
 * Freie Stunden werden genauso zusammengefasst. Ein Nachmittag, an dem zweimal
 * „frei" untereinander steht, liest sich wie zwei Termine, an denen etwas
 * ausfällt; ein durchgehendes Feld liest sich wie das, was es ist.
 */
export const planFuerGruppe = (
	eintraege: readonly StundenplanEintrag[],
	gruppe: string,
): Planzeile[] => {
	const sortiert = nachBeginn(eintraege)

	const zeilen: Planzeile[] = sortiert.map((eintrag) => ({
		id: eintrag.id,
		von: eintrag.data.von,
		bis: eintrag.data.bis,
		bezeichnung: eintrag.data.bezeichnung,
		pauseDanach: eintrag.data.pauseDanach ?? null,
		zellen: TAGE.map((tag): Planzelle => {
			const fach = fachFuer(eintrag.data, tag, gruppe)
			return fach === null
				? { art: 'frei', zeilen: 1 }
				: { art: 'fach', fach, zeilen: 1 }
		}),
	}))

	// Von unten nach oben, damit eine bereits gewachsene Zelle beim nächsten
	// Schritt mit ihrer vollen Höhe weiterwandert: Drei gleiche Stunden am Stück
	// ergeben so eine Zelle mit `zeilen: 3` und nicht zwei mit `2` und `1`.
	for (let i = zeilen.length - 2; i >= 0; i--) {
		const oben = zeilen[i]
		const unten = zeilen[i + 1]
		if (!oben || !unten) continue
		// Über eine Pause hinweg wird nicht zusammengefasst — siehe `pauseDanach`.
		if (oben.pauseDanach !== null) continue
		TAGE.forEach((_, spalte) => {
			const a = oben.zellen[spalte]
			const b = unten.zellen[spalte]
			// Beide sind hier nie `ueberdeckt` — von unten nach oben gelesen ist die
			// Zeile darunter noch unberührt. Die Abfrage steht trotzdem da, weil sie
			// zugleich den Typ verengt: `ueberdeckt` hat kein `zeilen`.
			if (!a || !b || a.art === 'ueberdeckt' || b.art === 'ueberdeckt') return
			const gleich =
				a.art === 'frei'
					? b.art === 'frei'
					: b.art === 'fach' && a.fach === b.fach
			if (!gleich) return
			a.zeilen += b.zeilen
			unten.zellen[spalte] = { art: 'ueberdeckt' }
		})
	}

	return zeilen
}

/**
 * Alle Pläne, die diese Klasse hat: einer je Gruppe, oder ein einziger ohne
 * Gruppennamen, wenn nirgends geteilt wird.
 *
 * Ein Plan JE GRUPPE und nicht ein Plan mit „A: … / B: …" in jeder Zelle: Ein
 * Kind gehört zu einer Gruppe, und der Zettel, den es sucht, ist der seiner
 * Gruppe. Die gemischte Darstellung muss bei jeder Stunde neu entschieden
 * werden, welche Hälfte einen angeht — genau der Fehler, der auf dem
 * handschriftlichen Zettel steckte, von dem dieser Plan abgeschrieben ist.
 */
export const plaene = (
	eintraege: readonly StundenplanEintrag[],
): Gruppenplan[] => {
	if (eintraege.length === 0) return []
	const gruppen = gruppenAus(eintraege)
	if (gruppen.length === 0) {
		return [{ gruppe: '', zeilen: planFuerGruppe(eintraege, '') }]
	}
	return gruppen.map((gruppe) => ({
		gruppe,
		zeilen: planFuerGruppe(eintraege, gruppe),
	}))
}

/** `08:15 – 09:10`, mit Halbgeviertstrich wie überall sonst auf der Seite. */
export const zeitspanne = (von: string, bis: string): string =>
	`${von} – ${bis}`
