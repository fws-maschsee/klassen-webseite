import type { Database } from 'better-sqlite3'
import { openDb } from '../lib/db/index.ts'
import { typstPdf } from '../lib/pdf/typst.ts'
import type { KlassenConfig } from './config.ts'
import { klassenConfig } from './config.ts'
import {
	type PutzplanZeile,
	planAlsEintraege,
	putzplanZeilen,
} from './putzplan.ts'
import { schuljahrAus, standDeutsch } from './zeitangaben.ts'

/**
 * Der Putzplan als PDF — dieselben Daten wie auf der Seite, in einer Form, die
 * man ausdrucken und an den Kühlschrank hängen kann.
 *
 * Erzeugt wird bei JEDEM Aufruf aus der Datenbank. Ein zur Bauzeit erzeugtes
 * PDF wäre der Stand des letzten Deploys, und der Plan ändert sich über MCP,
 * also ohne Deploy: Eine Familie hätte dann einen Zettel in der Hand, auf dem
 * ein getauschter Termin noch falsch steht — und dem Zettel sieht man das nicht
 * an. Genau dieselbe Begründung steht über der Seite (`prerender = false`).
 *
 * Die Vorlage steht in DIESEM Repository und nicht in den Klassen: Beide
 * Klassen sollen dasselbe PDF bekommen. Klassenname, Schuljahr und
 * Kontaktadresse kommen aus der `KlassenConfig`; wer hier einen Klassennamen
 * fest verdrahtet, macht den geteilten Code für die nächste Klasse wertlos.
 */

/**
 * Was die Vorlage als `daten.json` zu sehen bekommt.
 *
 * Englische Feldnamen, weil das eine Maschinenschnittstelle ist — der Vertrag
 * zwischen dieser Datei und der Vorlage unten. Die WERTE sind teils deutsche
 * Anzeigetexte (`21.08.2026`, `Familie Musterfrau und Familie Beispiel`): Sie
 * werden hier gesetzt und nicht in der Vorlage, weil die Seite sie schon so
 * setzt und beide dieselbe Tabelle zeigen sollen. Zwei Formatierungen wären
 * zwei Gelegenheiten, denselben Sonderfall verschieden zu treffen — und einer
 * davon wäre falsch.
 */
export type PutzplanPdfDaten = {
	/** Anzeigename der Klasse, z.B. `Klasse Wiesen`. */
	class_label: string
	/** Schuljahr, z.B. `2026/2027`. */
	school_year: string
	/** Wann dieses PDF erzeugt wurde, deutsch: `15.08.2026, 18:20 Uhr`. */
	generated_at: string
	/** Adresse der Klassenverwaltung. */
	contact_mail: string
	/** Name dahinter, oder leer. */
	contact_name: string
	/** Eine Zeile je Termin, in derselben Reihenfolge wie auf der Seite. */
	rows: { family: string; date: string; note: string }[]
}

/**
 * Das Schuljahr eines Datums steht seit dem Stundenplan-PDF in
 * `zeitangaben.ts` — zwei PDFs brauchen es. Der Name bleibt hier erreichbar,
 * weil `tests/klasse/putzplan-pdf.test.ts` ihn von hier holt und weil er
 * gedanklich zu diesem Modul gehört.
 */
export { schuljahrAus }

/**
 * Welches Schuljahr über dem PDF steht.
 *
 * Drei Quellen in dieser Reihenfolge, und jede hat ihren Grund:
 *
 * 1. `KlassenConfig.schuljahr`, wenn die Klasse es gesetzt hat. Damit lässt sich
 *    das Feld überschreiben, ohne den geteilten Code anzufassen.
 * 2. Sonst das Schuljahr des ERSTEN Termins. Damit passt die Überschrift
 *    zwangsläufig zur Tabelle darunter — ein Plan, der im August anfängt, steht
 *    auch dann unter „2026/2027", wenn ihn jemand im Juni 2027 herunterlädt.
 * 3. Sonst der Kalender. Das ist der leere Plan; dort gibt es keinen Termin,
 *    aus dem sich etwas ableiten ließe.
 *
 * Bewusst KEIN Pflichtfeld in der `KlassenConfig`: Ein Schuljahr, das jede
 * Klasse einmal im Jahr von Hand nachträgt, steht spätestens im zweiten Jahr in
 * einer der Klassen falsch — und ein falsches Schuljahr auf einem sonst
 * richtigen Plan fällt niemandem auf.
 */
export const schuljahrFuer = (
	config: KlassenConfig,
	zeilen: readonly PutzplanZeile[],
	jetzt: Date,
): string => {
	if (config.schuljahr) return config.schuljahr
	const erstes = zeilen[0]?.iso
	return schuljahrAus(erstes ? new Date(`${erstes}T00:00:00.000Z`) : jetzt)
}

/** Die Daten für die Vorlage. Reine Funktion — deshalb ohne Datenbank. */
export const putzplanPdfDaten = (
	config: KlassenConfig,
	zeilen: readonly PutzplanZeile[],
	jetzt: Date,
): PutzplanPdfDaten => ({
	class_label: config.label,
	school_year: schuljahrFuer(config, zeilen, jetzt),
	generated_at: standDeutsch(jetzt),
	contact_mail: config.contactMail,
	contact_name: config.contactName,
	rows: zeilen.map((zeile) => ({
		family: zeile.familie,
		date: zeile.datum,
		note: zeile.anmerkung,
	})),
})

/**
 * Der Dateiname, unter dem das PDF im Download-Ordner landet.
 *
 * Trägt Klasse und Schuljahr, weil dort schon der Plan des Vorjahres liegen
 * kann und weil Eltern zweier Klassen denselben Ordner benutzen. `putzplan.pdf`
 * wäre nach dem zweiten Download `putzplan (1).pdf` und nach dem dritten nicht
 * mehr zuzuordnen.
 *
 * Nur Kleinbuchstaben, Ziffern und Bindestriche: Der Name geht als
 * `Content-Disposition` über HTTP, und ein Header ist ASCII. Der Schrägstrich
 * des Schuljahres wäre dort ausserdem ein Pfadtrenner.
 */
export const putzplanDateiname = (
	config: KlassenConfig,
	schuljahr: string,
): string =>
	`putzplan-${config.slug}-${schuljahr}.pdf`
		.toLowerCase()
		.replaceAll(/[^a-z0-9.]+/g, '-')
		.replace(/-+\.pdf$/, '.pdf')

/** Das fertige PDF samt Dateiname. */
export type PutzplanPdf = {
	pdf: Buffer
	dateiname: string
}

/**
 * Liest den Plan, setzt ihn und gibt das PDF zurück.
 *
 * Nimmt Datenbank und Zeitpunkt als Argumente, damit ein Test denselben Weg
 * geht wie die Route — und nicht einen zweiten, der nur so aussieht.
 */
export const putzplanAlsPdf = async (
	db: Database = openDb(),
	jetzt: Date = new Date(),
	config: KlassenConfig = klassenConfig(),
): Promise<PutzplanPdf> => {
	const zeilen = putzplanZeilen(planAlsEintraege(db))
	const daten = putzplanPdfDaten(config, zeilen, jetzt)
	const pdf = await typstPdf({ vorlage: PUTZPLAN_VORLAGE, daten })
	return {
		pdf,
		dateiname: putzplanDateiname(config, daten.school_year),
	}
}

/**
 * Die Typst-Vorlage.
 *
 * Sie steht als Zeichenkette in einem Modul und nicht als `.typ`-Datei daneben,
 * und dafür gibt es einen handfesten Grund: Die Route wird von Vite nach
 * `dist/` gebündelt. Ein Pfad, der relativ zum Modul aufgelöst wird
 * (`new URL('./putzplan.typ', import.meta.url)`), zeigt nach dem Build in das
 * Build-Verzeichnis, wo die Vorlage nicht liegt — und das fällt erst im Betrieb
 * auf, nicht im Test. Ausserdem muss die Vorlage ohnehin in das
 * Arbeitsverzeichnis des Laufs geschrieben werden, damit `--root` sie
 * umschliesst (siehe `src/lib/pdf/typst.ts`); der Umweg über die Platte wäre
 * ein Lesen, dem sofort ein Schreiben folgt.
 *
 * `String.raw`, damit Backslashes stehen bleiben: In Typst ist `\` ein Zeichen
 * der Auszeichnungssprache (Zeilenumbruch), in einem JavaScript-Literal wäre es
 * der Anfang einer Fluchtsequenz. Heute steht keiner in der Vorlage — genau
 * deshalb steht `String.raw` schon jetzt da: Wer später einen einbaut, soll ihn
 * nicht als stillen Zeilenumbruch im Quelltext wiederfinden.
 *
 * ALLE Daten kommen aus `daten.json` und werden als WERTE eingesetzt. Typst
 * setzt eine Zeichenkette als Text und liest sie nicht noch einmal als
 * Auszeichnung — deshalb ist `Familie #strong[X]` hier ein Familienname mit
 * merkwürdigen Zeichen und kein Befehl. Wer die Vorlage ändert, darf deshalb
 * niemals `eval` benutzen und keinen Wert in Quelltext einsetzen; genau das
 * prüft der Test „ein Familienname mit Typst-Zeichen wirkt nicht als Code".
 *
 * Die Prosa im PDF ist deutsch, denn sie liest ein Mensch. Die Feldnamen sind
 * englisch, denn die liest ein Programm.
 */
// biome-ignore lint/complexity/noUselessStringRaw: siehe oben — `String.raw` steht hier fuer den naechsten Backslash, nicht fuer einen vorhandenen
export const PUTZPLAN_VORLAGE = String.raw`
#let daten = json("daten.json")

#let kontakt = if daten.contact_name != "" {
  daten.contact_name + ", " + daten.contact_mail
} else {
  daten.contact_mail
}

#set document(
  title: "Putzplan " + daten.class_label + " " + daten.school_year,
  author: daten.class_label,
)

#set page(
  paper: "a4",
  margin: (x: 2cm, y: 1.8cm),
  footer: context [
    #set text(size: 8pt, fill: luma(90))
    Stand: #daten.generated_at
    #h(1fr)
    Seite #counter(page).display() von #counter(page).final().first()
  ],
)

#set text(lang: "de", size: 10.5pt)
#set par(justify: false)

#text(size: 17pt, weight: "bold")[Putzplan]
#v(-0.5em)
#text(size: 12pt)[#daten.class_label, Schuljahr #daten.school_year]
#v(0.8em)

#if daten.rows.len() == 0 [
  Für dieses Schuljahr ist noch niemand eingeteilt. Sobald die Einteilung steht,
  steht sie hier — dieses PDF wird bei jedem Herunterladen neu erzeugt.
] else [
  #table(
    columns: (auto, auto, 1fr),
    align: (left + top, left + top, left + top),
    inset: (x: 7pt, y: 6pt),
    stroke: (x, y) => (bottom: 0.5pt + luma(180)),
    table.header([*Familie*], [*Datum*], [*Anmerkungen*]),
    ..daten.rows.map(zeile => (zeile.family, zeile.date, zeile.note)).flatten()
  )
]

#v(1em)

#block(width: 100%, inset: 0pt)[
  #set text(size: 9pt)

  Geputzt wird am Wochenende, frühestens am Freitag. Sprecht euch bitte mit der
  anderen Familie ab, wer wann kommt — ihr seid zu zweit eingeteilt, und das
  Wochenende ist lang genug für zwei Termine. Denkt an den Schlüssel: Den holt
  ihr am besten schon am Freitag ab, am Wochenende ist niemand in der Schule,
  der euch aufschließen kann.

  Wer an seinem Termin nicht kann, tauscht am besten direkt mit einer anderen
  Familie und sagt danach in der Klassenverwaltung Bescheid (#kontakt). Der
  Tausch steht danach sofort auf der Seite und in diesem PDF.
]
`
