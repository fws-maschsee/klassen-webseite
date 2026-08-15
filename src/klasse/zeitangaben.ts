import { berlinTeile } from '../lib/berlinZeit.ts'

/**
 * Wie Datumsangaben in den PDFs dieser Anwendung geschrieben werden.
 *
 * Zwei Funktionen, die vorher in `putzplanPdf.ts` standen und mit dem
 * Stundenplan-PDF einen zweiten Aufrufer bekommen haben. Sie hier
 * herauszuziehen ist kein Aufräumen: `putzplanPdf.ts` öffnet die Datenbank, und
 * das Stundenplan-PDF liest ausschließlich eine YAML-Datei. Der Import hätte
 * ihm `better-sqlite3` an einen Pfad gehängt, der keine Datenbank braucht.
 *
 * Beide setzen die deutsche Schreibweise — sie liest ein Mensch.
 */

/**
 * Das Schuljahr, in dem ein Datum liegt: `2026/2027` für alles ab August 2026
 * bis Juli 2027.
 *
 * Die Grenze liegt am 1. August und nicht am ersten Schultag. Das ist eine
 * Vereinfachung, und sie ist die richtige: Der erste Schultag steht nirgends
 * als Datum in dieser Anwendung, und im Juli und August liegt ohnehin kein
 * Putztermin — die Vereinfachung kann also nur dort danebenliegen, wo es keine
 * Daten gibt.
 */
export const schuljahrAus = (datum: Date): string => {
	const jahr = datum.getUTCFullYear()
	// `getUTCMonth()` zählt ab 0, August ist 7.
	const beginn = datum.getUTCMonth() >= 7 ? jahr : jahr - 1
	return `${beginn}/${beginn + 1}`
}

/** `15.08.2026, 18:20 Uhr` — nach der Uhr, die bei den Eltern an der Wand hängt. */
export const standDeutsch = (zeitpunkt: Date): string => {
	const t = berlinTeile(zeitpunkt)
	const zweistellig = (zahl: number) => String(zahl).padStart(2, '0')
	return `${zweistellig(t.tag)}.${zweistellig(t.monat)}.${t.jahr}, ${zweistellig(t.stunde)}:${zweistellig(t.minute)} Uhr`
}
