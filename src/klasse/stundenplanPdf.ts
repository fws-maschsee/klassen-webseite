import { typstPdf } from '../lib/pdf/typst.ts'
import type { KlassenConfig } from './config.ts'
import { klassenConfig } from './config.ts'
import {
	type Gruppenplan,
	plaene,
	type StundenplanEintrag,
	TAG_NAMEN,
	TAGE,
	zeitspanne,
} from './stundenplan.ts'
import { schuljahrAus, standDeutsch } from './zeitangaben.ts'

/**
 * Der Stundenplan als PDF — dieselben Daten wie auf der Seite, in einer Form,
 * die man ausdrucken und einem Kind in die Mappe legen kann.
 *
 * Eine Seite je Gruppe. Ein Kind gehört zu einer Gruppe, und der Zettel, den es
 * braucht, ist der seiner Gruppe; ein gemeinsames Blatt mit „A: … / B: …" in
 * jeder Zelle zwingt es dazu, bei jeder Stunde neu zu entscheiden, welche
 * Hälfte es angeht. Genau daran ist der handschriftliche Zettel gescheitert,
 * von dem dieser Plan abgeschrieben ist.
 *
 * Unten hängen an derselben Tabelle ein paar LEERE ZEILEN — fürs
 * Nachmittagsprogramm: Instrumentalunterricht, Orchester, AGs. Die Uhrzeit
 * links bleibt frei, weil sie von Kind zu Kind verschieden ist.
 *
 * Kein eigener Kasten darunter, sondern dieselbe Tabelle weitergeschrieben: Es
 * ist derselbe Tag und dieselbe Spalte wie am Vormittag, und ein zweiter Kasten
 * zwänge beim Lesen dazu, den Montag zweimal zu suchen.
 *
 * Als Daten in der YAML steht davon nichts, und das ist Absicht: Das
 * Nachmittagsprogramm ist für jedes Kind ein anderes, es ändert sich im
 * Schuljahr, und es geht die Klasse als Ganzes nichts an. Leere Zeilen sind
 * dafür das ehrlichere Werkzeug als eine Tabelle, die jemand für dreißig Kinder
 * pflegen müsste.
 *
 * Die Vorlage steht in DIESEM Repository und nicht in den Klassen: Beide
 * Klassen sollen dasselbe PDF bekommen. Klassenname und Schuljahr kommen aus
 * der `KlassenConfig`; wer hier einen Klassennamen fest verdrahtet, macht den
 * geteilten Code für die nächste Klasse wertlos.
 */

/**
 * Was die Vorlage als `daten.json` zu sehen bekommt.
 *
 * Englische Feldnamen, weil das eine Maschinenschnittstelle ist — der Vertrag
 * zwischen dieser Datei und der Vorlage unten. Die WERTE sind deutsche
 * Anzeigetexte: Sie werden hier gesetzt und nicht in der Vorlage, weil die
 * Seite sie schon so setzt und beide dasselbe Raster zeigen sollen. Zwei
 * Formatierungen wären zwei Gelegenheiten, denselben Sonderfall verschieden zu
 * treffen — und eine davon wäre falsch.
 */
export type StundenplanPdfDaten = {
	/** Anzeigename der Klasse, z.B. `Klasse Wiesen`. */
	class_label: string
	/** Schuljahr, z.B. `2026/2027`. */
	school_year: string
	/** Wann dieses PDF erzeugt wurde, deutsch: `15.08.2026, 18:20 Uhr`. */
	generated_at: string
	/** Die Kopfzeile der Tabelle: `Montag` … `Freitag`. */
	days: string[]
	/** Ein Plan je Gruppe, in derselben Reihenfolge wie auf der Seite. */
	plans: {
		/** Gruppenname, oder `''` bei einer ungeteilten Klasse. */
		group: string
		rows: {
			/** `1. Stunde`, `2. Fachstunde`. */
			label: string
			/** `08:15 – 09:10`. */
			time: string
			/**
			 * Je Tag ein Eintrag — ohne die überdeckten. `span` ist das `rowspan`.
			 *
			 * Die überdeckten Zellen sind hier bereits herausgefiltert, weil Typst
			 * sie genauso wenig ausgibt wie HTML: Beide setzen die folgenden Zellen
			 * automatisch in den nächsten freien Platz. Die Vorlage soll nicht noch
			 * einmal entscheiden müssen, was das Raster längst entschieden hat.
			 */
			cells: { text: string; span: number }[]
			/** Text der Pause danach, oder `''`. */
			break_after: string
		}[]
	}[]
	/** Wie viele leere Zeilen unten an der Tabelle hängen. */
	afternoon_lines: number
}

/**
 * Wie viele leere Zeilen unten an der Tabelle hängen.
 *
 * Drei, und nicht mehr: Ein Kind hat selten mehr als drei feste Termine am
 * Nachmittag, und jede weitere Zeile drückt das Raster darüber auf eine zweite
 * Seite — ein Stundenplan, der zwei Blätter braucht, hängt nirgends.
 */
const NACHMITTAGSZEILEN = 3

/** Die Daten für die Vorlage. Reine Funktion — deshalb ohne Astro. */
export const stundenplanPdfDaten = (
	config: KlassenConfig,
	gruppenplaene: readonly Gruppenplan[],
	jetzt: Date,
): StundenplanPdfDaten => ({
	class_label: config.label,
	// Truthiness und nicht `??`: `schuljahr` ist per Vorgabe die LEERE
	// Zeichenkette und nicht `undefined` (siehe `config.ts`) — `??` hätte sie
	// durchgereicht, und im PDF wie im Dateinamen stünde gar kein Schuljahr.
	//
	// Ohne gesetzten Wert kommt es aus der Uhr. Der Putzplan leitet es aus
	// seinem ersten Termin ab; ein Stundenplan hat kein Datum, aus dem sich
	// etwas ableiten ließe. Die Grenze davon ist bekannt: Wer die YAML im
	// August nicht anfasst, bekommt ab dem 1. August das neue Schuljahr über
	// dem alten Plan. Dann ist aber der PLAN veraltet und nicht seine
	// Überschrift — und `schuljahr` in der `KlassenConfig` setzt den Wert fest,
	// wenn eine Klasse ihn lieber selbst führt.
	school_year: config.schuljahr || schuljahrAus(jetzt),
	generated_at: standDeutsch(jetzt),
	days: TAGE.map((tag) => TAG_NAMEN[tag]),
	plans: gruppenplaene.map((plan) => ({
		group: plan.gruppe,
		rows: plan.zeilen.map((zeile) => ({
			label: zeile.bezeichnung,
			time: zeitspanne(zeile.von, zeile.bis),
			cells: zeile.zellen
				.filter((zelle) => zelle.art !== 'ueberdeckt')
				.map((zelle) => ({
					// `–` und nicht die leere Zeichenkette: Eine leere Zelle im Druck
					// sieht aus wie ein Fehler beim Setzen, ein Strich wie „hier ist
					// nichts". Auf der Seite steht aus demselben Grund derselbe Strich.
					text: zelle.art === 'frei' ? '–' : zelle.fach,
					span: zelle.zeilen,
				})),
			break_after: zeile.pauseDanach ?? '',
		})),
	})),
	afternoon_lines: NACHMITTAGSZEILEN,
})

/**
 * Der Dateiname, unter dem das PDF im Download-Ordner landet.
 *
 * Trägt Klasse und Schuljahr, weil dort schon der Plan des Vorjahres liegen
 * kann und weil Eltern zweier Klassen denselben Ordner benutzen.
 * `stundenplan.pdf` wäre nach dem zweiten Download `stundenplan (1).pdf` und
 * nach dem dritten nicht mehr zuzuordnen.
 *
 * Nur Kleinbuchstaben, Ziffern und Bindestriche: Der Name geht als
 * `Content-Disposition` über HTTP, und ein Header ist ASCII. Der Schrägstrich
 * des Schuljahres wäre dort ausserdem ein Pfadtrenner.
 */
export const stundenplanDateiname = (
	config: KlassenConfig,
	schuljahr: string,
): string =>
	`stundenplan-${config.slug}-${schuljahr}.pdf`
		.toLowerCase()
		.replaceAll(/[^a-z0-9.]+/g, '-')
		.replace(/-+\.pdf$/, '.pdf')

/** Das fertige PDF samt Dateiname. */
export type StundenplanPdf = {
	pdf: Buffer
	dateiname: string
}

/**
 * Setzt den Plan und gibt das PDF zurück.
 *
 * Nimmt die Einträge als Argument und liest sie nicht selbst: `getCollection`
 * gibt es nur innerhalb einer Astro-Kompilierung, und dieses Modul soll ohne
 * Astro prüfbar bleiben. Die Route reicht sie herein.
 */
export const stundenplanAlsPdf = async (
	eintraege: readonly StundenplanEintrag[],
	jetzt: Date = new Date(),
	config: KlassenConfig = klassenConfig(),
): Promise<StundenplanPdf> => {
	const daten = stundenplanPdfDaten(config, plaene(eintraege), jetzt)
	const pdf = await typstPdf({ vorlage: STUNDENPLAN_VORLAGE, daten })
	return {
		pdf,
		dateiname: stundenplanDateiname(config, daten.school_year),
	}
}

/**
 * Die Typst-Vorlage.
 *
 * Sie steht als Zeichenkette in einem Modul und nicht als `.typ`-Datei daneben,
 * aus demselben Grund wie beim Putzplan: Die Route wird von Vite nach `dist/`
 * gebündelt, und ein Pfad relativ zum Modul zeigte danach in das
 * Build-Verzeichnis, wo die Vorlage nicht liegt — was erst im Betrieb auffiele.
 *
 * ALLE Daten kommen aus `daten.json` und werden als WERTE eingesetzt, nie in
 * den Quelltext. Typst setzt eine Zeichenkette als Text und liest sie nicht
 * noch einmal als Auszeichnung — ein Fach namens `#strong[X]` ist damit ein
 * merkwürdiger Fachname und kein Befehl. Wer die Vorlage ändert, darf deshalb
 * niemals einen Wert in Quelltext einsetzen; genau das prüft der Test „ein
 * Fachname mit Typst-Zeichen wirkt nicht als Code".
 *
 * Die Zellen mit `rowspan` setzt Typst automatisch an den nächsten freien
 * Platz — deshalb liefert `stundenplanPdfDaten` die überdeckten Zellen gar
 * nicht erst mit, genauso wie die Seite im HTML kein `<td>` dafür ausgibt.
 */
export const STUNDENPLAN_VORLAGE = String.raw`
#let daten = json("daten.json")

#set document(
  title: "Stundenplan " + daten.class_label + " " + daten.school_year,
  author: daten.class_label,
)

#set page(
  paper: "a4",
  margin: (x: 1.6cm, y: 1.5cm),
  footer: context [
    #set text(size: 8pt, fill: luma(90))
    Stand: #daten.generated_at
    #h(1fr)
    Seite #counter(page).display() von #counter(page).final().first()
  ],
)

#set text(lang: "de", size: 10pt)
#set par(justify: false)

#let ZEITSPALTE = 2.4cm

// Eine Zeile des Rasters, samt Pausenzeile darunter. Die Pause bekommt eine
// eigene Zeile ueber die ganze Breite; ein rowspan kann sie nie zerschneiden,
// weil ueber eine Pause hinweg nicht zusammengefasst wird.
#let rasterzeilen(rows) = {
  let out = ()
  for r in rows {
    out.push(table.cell(align: horizon + left)[
      #text(size: 7.5pt, fill: luma(110))[#r.label] \
      #text(size: 9pt)[#r.time]
    ])
    for c in r.cells {
      out.push(table.cell(rowspan: c.span, align: horizon + center)[#c.text])
    }
    if r.break_after != "" {
      out.push(table.cell(
        colspan: daten.days.len() + 1,
        fill: luma(238),
        inset: (y: 3pt),
        align: center,
      )[#text(size: 7.5pt, fill: luma(80))[#r.break_after]])
    }
  }
  out
}

// Die leeren Zeilen fuer den Nachmittag — dieselbe Tabelle, einfach
// weitergeschrieben.
//
// Sie stehen bewusst NICHT als eigener Block unter dem Plan: Was ein Kind am
// Nachmittag hat, ist derselbe Tag und dieselbe Spalte wie der Vormittag. Ein
// zweiter Kasten daneben zwingt beim Lesen dazu, den Montag zweimal zu suchen.
//
// Die Zeitspalte bleibt hier LEER, weil die Uhrzeit dieser Zeilen von Kind zu
// Kind verschieden ist — Geige um 14:30, Orchester um 15:00. Sie ist also kein
// vergessenes Feld, sondern das eigentliche Angebot dieser Zeilen.
//
// Hoeher als die Zeilen darueber, damit Handschrift hineinpasst.
#let leerzeilen(anzahl) = {
  let leer = table.cell(inset: (x: 5pt, y: 12pt))[]
  range(anzahl).map(_ => (leer,) * (daten.days.len() + 1)).flatten()
}

#let planseite(plan) = {
  block(width: 100%)[
    #text(size: 16pt, weight: "bold")[Stundenplan]
    #if plan.group != "" [
      #h(0.4em)
      #text(size: 16pt, weight: "bold", fill: luma(90))[Gruppe #plan.group]
    ]
    #v(-0.45em)
    #text(size: 11pt)[#daten.class_label, Schuljahr #daten.school_year]
    #h(1fr)
  ]

  v(0.2em)
  text(size: 9pt, fill: luma(90))[Name: #box(width: 6cm, repeat[.])]
  v(0.7em)

  table(
    columns: (ZEITSPALTE,) + (1fr,) * daten.days.len(),
    align: horizon + center,
    inset: (x: 5pt, y: 7pt),
    stroke: 0.5pt + luma(170),
    table.header(
      table.cell(align: left)[#text(size: 8.5pt, weight: "bold")[Zeit]],
      ..daten.days.map(d => text(size: 9pt, weight: "bold")[#d]),
    ),
    ..rasterzeilen(plan.rows),
    ..leerzeilen(daten.afternoon_lines)
  )

  v(0.4em)
  text(size: 8.5pt, fill: luma(95))[
    Die leeren Zeilen sind fürs Nachmittagsprogramm — Instrumentalunterricht,
    Orchester, AGs. Uhrzeit bitte links selbst eintragen.
  ]
}

#if daten.plans.len() == 0 [
  Für diese Klasse ist noch kein Stundenplan hinterlegt. Sobald er steht, steht
  er hier — dieses PDF wird bei jedem Herunterladen neu erzeugt.
] else [
  #for (i, plan) in daten.plans.enumerate() [
    #if i > 0 [#pagebreak()]
    #planseite(plan)
  ]
]
`
