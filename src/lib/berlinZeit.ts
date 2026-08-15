/**
 * Rechnen mit der Uhr, die bei den Eltern an der Wand haengt.
 *
 * „Sonntags um 17 Uhr" ist eine Aussage ueber die ORTSZEIT und nicht ueber UTC.
 * Zwischen beiden liegt im Sommer eine Stunde mehr als im Winter, und genau da
 * gehen solche Dienste kaputt: Wer `17 - 2` rechnet, verschickt ein halbes Jahr
 * lang um 16 Uhr, und niemand meldet es, weil eine Erinnerung eine Stunde
 * frueher niemandem auffaellt. Wer `17 - 1` rechnet, verschickt im Sommer um 18
 * Uhr — auch das faellt nicht auf. Auffallen wuerde erst der Tag, an dem die
 * Zeitumstellung eine Erinnerung ganz verschluckt.
 *
 * Deshalb steht hier nirgends eine Stundenzahl. Die Zeitzonendatenbank wird
 * gefragt, ueber `Intl` — und zwar fuer JEDEN Zeitpunkt einzeln, denn der
 * Versatz gehoert zum Zeitpunkt und nicht zur Zeitzone.
 */

/** Die Zeitzone der Schule. Kein Wert aus der Umgebung: die Schule zieht nicht um. */
export const ZEITZONE = 'Europe/Berlin'

const TEILE = new Intl.DateTimeFormat('en-US', {
	timeZone: ZEITZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	// `hourCycle: 'h23'` und nicht `hour12: false`: letzteres liefert in
	// manchen ICU-Staenden die Stunde 24 statt 0, und `Date.UTC(…, 24, …)`
	// waere dann der naechste Tag.
	hourCycle: 'h23',
})

export type BerlinTeile = {
	jahr: number
	/** 1–12, wie ein Mensch ihn schreibt — nicht Javascripts 0–11. */
	monat: number
	tag: number
	stunde: number
	minute: number
	sekunde: number
}

/** Was die Uhr in Berlin zu diesem Zeitpunkt zeigt. */
export const berlinTeile = (zeitpunkt: Date): BerlinTeile => {
	const teile = Object.fromEntries(
		TEILE.formatToParts(zeitpunkt).map(({ type, value }) => [type, value]),
	)
	const zahl = (name: string): number => Number.parseInt(teile[name] ?? '0', 10)
	return {
		jahr: zahl('year'),
		monat: zahl('month'),
		tag: zahl('day'),
		stunde: zahl('hour'),
		minute: zahl('minute'),
		sekunde: zahl('second'),
	}
}

/**
 * Versatz der Ortszeit gegenueber UTC zu diesem Zeitpunkt, in Millisekunden.
 *
 * Gemessen und nicht gewusst: Die Berliner Wanduhrzeit wird gelesen, als waere
 * sie UTC, und die Differenz zum echten Zeitpunkt ist der Versatz. Der Trick
 * kommt ohne Tabelle aus und stimmt auch dann, wenn sich die Regel aendert.
 */
const versatzMs = (zeitpunkt: Date): number => {
	const t = berlinTeile(zeitpunkt)
	// Millisekunden abschneiden: `Date.UTC` bekommt sie nicht mit, und ein
	// Versatz ist immer ein Vielfaches einer Minute.
	const volleSekunden = Math.floor(zeitpunkt.getTime() / 1000) * 1000
	return (
		Date.UTC(t.jahr, t.monat - 1, t.tag, t.stunde, t.minute, t.sekunde) -
		volleSekunden
	)
}

/**
 * Der Zeitpunkt, zu dem die Uhr in Berlin dieses Datum und diese Uhrzeit
 * zeigt.
 *
 * Zweistufig, weil der Versatz vom Ergebnis abhaengt, das er berechnen soll:
 * Der erste Versuch nimmt den Versatz an der falschen Stelle des Kalenders
 * (naemlich um bis zu einen Tag daneben), der zweite den an der richtigen. An
 * jedem Tag ausser den beiden Umstellungstagen liefern beide dasselbe.
 */
export const berlinZeitpunkt = (
	jahr: number,
	monat: number,
	tag: number,
	stunde = 0,
	minute = 0,
): Date => {
	const alsWaereEsUtc = Date.UTC(jahr, monat - 1, tag, stunde, minute)
	const ersterVersuch = alsWaereEsUtc - versatzMs(new Date(alsWaereEsUtc))
	return new Date(alsWaereEsUtc - versatzMs(new Date(ersterVersuch)))
}
