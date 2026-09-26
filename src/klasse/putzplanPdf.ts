import type { Database } from 'better-sqlite3'
import { berlinTeile } from '../lib/berlinZeit.ts'
import { openDb } from '../lib/db/index.ts'
import { typstPdf } from '../lib/pdf/typst.ts'
import type { KlassenConfig } from './config.ts'
import { klassenConfig } from './config.ts'
import {
	type PutzplanZeile,
	planAlsEintraege,
	putzplanZeilen,
} from './putzplan.ts'

export type PutzplanPdfDaten = {
	class_label: string
	school_year: string
	generated_at: string
	contact_mail: string
	contact_name: string
	rows: { family: string; date: string; note: string }[]
}

export const schuljahrAus = (datum: Date): string => {
	const jahr = datum.getUTCFullYear()
	// Grenze 1. August (Monat 7, ab 0) statt erster Schultag: der steht nirgends, und im Sommer liegt kein Termin.
	const beginn = datum.getUTCMonth() >= 7 ? jahr : jahr - 1
	return `${beginn}/${beginn + 1}`
}

export const schuljahrFuer = (
	config: KlassenConfig,
	zeilen: readonly PutzplanZeile[],
	jetzt: Date,
): string => {
	if (config.schuljahr) return config.schuljahr
	const erstes = zeilen[0]?.iso
	return schuljahrAus(erstes ? new Date(`${erstes}T00:00:00.000Z`) : jetzt)
}

const standDeutsch = (zeitpunkt: Date): string => {
	const t = berlinTeile(zeitpunkt)
	const zweistellig = (zahl: number) => String(zahl).padStart(2, '0')
	return `${zweistellig(t.tag)}.${zweistellig(t.monat)}.${t.jahr}, ${zweistellig(t.stunde)}:${zweistellig(t.minute)} Uhr`
}

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

export const putzplanDateiname = (
	config: KlassenConfig,
	schuljahr: string,
): string =>
	// Nur ASCII ohne „/“: der Name geht in den Content-Disposition-Header.
	`putzplan-${config.slug}-${schuljahr}.pdf`
		.toLowerCase()
		.replaceAll(/[^a-z0-9.]+/g, '-')
		.replace(/-+\.pdf$/, '.pdf')

export type PutzplanPdf = {
	pdf: Buffer
	dateiname: string
}

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

// Als String statt .typ-Datei, weil Vite die Route nach dist/ bündelt und ein modulrelativer Pfad dort ins Leere zeigt.
// Daten nur über daten.json als Werte einsetzen, nie per eval oder in den Quelltext — sonst wird ein Familienname zu Typst-Code.
// biome-ignore lint/complexity/noUselessStringRaw: `String.raw` steht fuer den naechsten Backslash, nicht fuer einen vorhandenen
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

  Geputzt wird am Wochenende, frühestens am Freitag.
  Denkt an den Schlüssel: Den holt ihr am besten schon am Freitag ab, am
  Wochenende ist niemand in der Schule, der euch aufschließen kann.

  Wer an seinem Termin nicht kann, tauscht am besten direkt mit einer anderen
  Familie und sagt danach in der Klassenverwaltung Bescheid (#kontakt).
]
`
