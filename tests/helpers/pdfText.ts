import { inflateSync } from 'node:zlib'

/**
 * Den sichtbaren Text aus einem PDF ziehen — so viel davon, dass ein Test
 * behaupten kann, ein Name stehe darin.
 *
 * Warum von Hand und nicht mit einer Bibliothek: Die Frage, die dieser Helfer
 * beantwortet, ist „steht dieser Familienname wirklich im PDF" — und darauf
 * darf nicht eine Attrappe antworten, die dasselbe Modul benutzt, das den Text
 * hineingeschrieben hat. Ein Leser, der nur die PDF-Bytes kennt, prüft das
 * ERGEBNIS. Ausserdem wäre die naheliegende Bibliothek (pdfjs) eine
 * Abhängigkeit von der Grössenordnung des ganzen übrigen Testbaums.
 *
 * Wie ein Typst-PDF seinen Text ablegt, und warum ein `grep` nicht reicht: Die
 * Schrift ist eingebettet und auf die benutzten Zeichen eingedampft. Im
 * Inhaltsstrom stehen deshalb keine Buchstaben, sondern zwei Byte breite
 * GLYPHEN-NUMMERN dieser eingedampften Schrift — für „a" je nach Dokument eine
 * andere. Die Übersetzung zurück steht als `/ToUnicode`-CMap beim jeweiligen
 * Font, und genau diesen Weg geht der Leser hier:
 *
 *   1. Alle indirekten Objekte einsammeln (Typst schreibt sie unkomprimiert,
 *      ohne Objekt-Ströme).
 *   2. Aus jedem `/Font<</f0 12 0 R …>>` die Zuordnung Ressourcenname → Objekt.
 *   3. Aus dem Font-Objekt die `/ToUnicode`-CMap, daraus Code → Zeichen.
 *   4. Die Inhaltsströme entpacken und durchgehen: `/f0 … Tf` schaltet die
 *      Schrift um, `Tj`/`TJ` zeigen Text.
 *
 * Der Leser deckt genau das ab, was Typst erzeugt, und nicht die ganze
 * PDF-Spezifikation. Kommt eine Fassung, deren Ausgabe er nicht mehr versteht,
 * werden die Tests rot statt still zu bestehen — dafür sorgt der Test, der
 * einen Text erwartet, den er selbst hineingegeben hat.
 */

/** Ein indirektes Objekt: sein Wörterbuch und, wenn vorhanden, sein Strom. */
type PdfObjekt = {
	dict: string
	strom: Buffer | null
}

const objekte = (pdf: Buffer): Map<number, PdfObjekt> => {
	const gefunden = new Map<number, PdfObjekt>()
	const text = pdf.toString('latin1')
	const kopf = /(\d+) 0 obj/g
	let treffer = kopf.exec(text)
	while (treffer !== null) {
		const nummer = Number(treffer[1])
		const start = treffer.index + treffer[0].length
		const ende = text.indexOf('endobj', start)
		if (ende !== -1) {
			gefunden.set(nummer, objektLesen(pdf, text, start, ende))
		}
		treffer = kopf.exec(text)
	}
	return gefunden
}

const objektLesen = (
	pdf: Buffer,
	text: string,
	start: number,
	ende: number,
): PdfObjekt => {
	const stromMarke = /stream\r?\n/.exec(text.slice(start, ende))
	if (!stromMarke) return { dict: text.slice(start, ende), strom: null }

	const dict = text.slice(start, start + stromMarke.index)
	const stromStart = start + stromMarke.index + stromMarke[0].length
	const stromEnde = text.indexOf('endstream', stromStart)
	const roh = pdf.subarray(stromStart, stromEnde === -1 ? ende : stromEnde)
	// Typst packt alle Ströme mit Flate. Was sich nicht entpacken lässt, ist für
	// diesen Leser uninteressant (Schriftdaten, ICC-Profile).
	try {
		return { dict, strom: inflateSync(roh) }
	} catch {
		return { dict, strom: null }
	}
}

/** Code → Zeichen aus einer `/ToUnicode`-CMap. */
const cmapLesen = (cmap: string): Map<number, string> => {
	const zuordnung = new Map<number, string>()

	for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
		for (const zeile of (block[1] ?? '').matchAll(
			/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g,
		)) {
			zuordnung.set(
				Number.parseInt(zeile[1] ?? '0', 16),
				zeichenAus(zeile[2] ?? ''),
			)
		}
	}

	for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
		for (const zeile of (block[1] ?? '').matchAll(
			/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g,
		)) {
			const von = Number.parseInt(zeile[1] ?? '0', 16)
			const bis = Number.parseInt(zeile[2] ?? '0', 16)
			const ziel = Number.parseInt(zeile[3] ?? '0', 16)
			for (let code = von; code <= bis; code++) {
				zuordnung.set(code, String.fromCodePoint(ziel + (code - von)))
			}
		}
	}

	return zuordnung
}

/** Ein UTF-16BE-Hexwert der CMap als Zeichenkette. */
const zeichenAus = (hex: string): string => {
	let ergebnis = ''
	for (let i = 0; i + 3 < hex.length + 1; i += 4) {
		ergebnis += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16))
	}
	return ergebnis
}

/** Ressourcenname (`f0`) → Code-Zuordnung seiner Schrift. */
const schriften = (
	alle: Map<number, PdfObjekt>,
): Map<string, Map<number, string>> => {
	const nachName = new Map<string, Map<number, string>>()

	for (const objekt of alle.values()) {
		for (const fontDict of objekt.dict.matchAll(/\/Font\s*<<([^>]*)>>/g)) {
			for (const eintrag of (fontDict[1] ?? '').matchAll(
				/\/(\w+)\s+(\d+)\s+0\s+R/g,
			)) {
				const name = eintrag[1] ?? ''
				const font = alle.get(Number(eintrag[2]))
				const verweis = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(font?.dict ?? '')
				const cmap = verweis ? alle.get(Number(verweis[1]))?.strom : null
				if (cmap) nachName.set(name, cmapLesen(cmap.toString('latin1')))
			}
		}
	}

	return nachName
}

/**
 * Ein Inhaltsstrom, Zeichen für Zeichen: Zeichenketten sammeln, Schriftwechsel
 * merken.
 *
 * Ein richtiger Abtaster und kein regulaerer Ausdruck, weil eine PDF-Zeichen-
 * kette runde Klammern enthalten darf — geschachtelt oder mit Backslash
 * geschuetzt. Ein Ausdruck, der bei der ersten `)` aufhoert, verliert genau die
 * Zeilen, in denen etwas Ungewoehnliches steht, und das sind die interessanten.
 */
const stromText = (
	strom: Buffer,
	schriftNachName: Map<string, Map<number, string>>,
): string => {
	const daten = strom.toString('latin1')
	const ausgabe: string[] = []
	let aktuell: Map<number, string> | undefined
	let letzterName = ''
	let stueck = ''
	let i = 0

	const anhaengen = (roh: string): void => {
		if (!aktuell) return
		for (let k = 0; k + 1 < roh.length; k += 2) {
			const code = (roh.charCodeAt(k) << 8) | roh.charCodeAt(k + 1)
			stueck += aktuell.get(code) ?? ''
		}
	}

	while (i < daten.length) {
		const zeichen = daten[i]

		if (zeichen === '(') {
			let tiefe = 1
			let roh = ''
			i++
			while (i < daten.length && tiefe > 0) {
				const z = daten[i] ?? ''
				if (z === '\\') {
					const naechstes = daten[i + 1] ?? ''
					if (/[0-7]/.test(naechstes)) {
						const oktal = /^[0-7]{1,3}/.exec(daten.slice(i + 1)) ?? ['0']
						roh += String.fromCharCode(Number.parseInt(oktal[0], 8))
						i += 1 + oktal[0].length
						continue
					}
					const ersatz: Record<string, string> = {
						n: '\n',
						r: '\r',
						t: '\t',
						b: '\b',
						f: '\f',
					}
					roh += ersatz[naechstes] ?? naechstes
					i += 2
					continue
				}
				if (z === '(') tiefe++
				if (z === ')') {
					tiefe--
					if (tiefe === 0) {
						i++
						break
					}
				}
				roh += z
				i++
			}
			anhaengen(roh)
			continue
		}

		// Ein Wörterbuch (`<</MCID 0>>`) ist keine Hex-Zeichenkette. Beide fangen
		// mit `<` an, und wer das nicht unterscheidet, liest die Marken der
		// getaggten Struktur als Text — sie tauchen dann als Buchstabensalat vor
		// jeder Zeile auf.
		if (zeichen === '<' && daten[i + 1] === '<') {
			i += 2
			continue
		}
		if (zeichen === '>' && daten[i + 1] === '>') {
			i += 2
			continue
		}

		if (zeichen === '<') {
			const ende = daten.indexOf('>', i)
			const hex = daten.slice(i + 1, ende === -1 ? undefined : ende)
			let roh = ''
			for (let k = 0; k + 1 < hex.length; k += 2) {
				roh += String.fromCharCode(Number.parseInt(hex.slice(k, k + 2), 16))
			}
			anhaengen(roh)
			i = ende === -1 ? daten.length : ende + 1
			continue
		}

		if (zeichen === '/') {
			const name = /^\/([^\s/[\]<>(){}]*)/.exec(daten.slice(i))
			letzterName = name?.[1] ?? ''
			i += name?.[0].length ?? 1
			continue
		}

		const wort = /^[A-Za-z'"*]+/.exec(daten.slice(i))
		if (wort) {
			const operator = wort[0]
			if (operator === 'Tf') {
				aktuell = schriftNachName.get(letzterName)
			}
			// Nach jedem Textblock ein Trenner: Typst setzt jede Tabellenzelle als
			// eigenen Block. Ohne Trenner klebte die letzte Zelle einer Zeile an der
			// ersten der naechsten, und ein Test koennte einen Text finden, den
			// niemand so sieht.
			if (operator === 'ET' && stueck !== '') {
				ausgabe.push(stueck)
				stueck = ''
			}
			i += operator.length
			continue
		}

		i++
	}

	if (stueck !== '') ausgabe.push(stueck)
	return ausgabe.join('\n')
}

/** Der Text aller Seiten, Blöcke durch Zeilenumbrüche getrennt. */
export const pdfText = (pdf: Buffer): string => {
	const alle = objekte(pdf)
	const schriftNachName = schriften(alle)
	const teile: string[] = []

	for (const objekt of alle.values()) {
		if (!objekt.strom) continue
		const daten = objekt.strom.toString('latin1')
		// Inhaltsströme erkennt man daran, dass sie Text zeigen. CMaps und
		// Metadaten tun das nicht.
		if (!/\bTf\b/.test(daten) || !/\bBT\b/.test(daten)) continue
		teile.push(stromText(objekt.strom, schriftNachName))
	}

	return teile.join('\n')
}

/**
 * Derselbe Text mit zusammengefasstem Weissraum.
 *
 * Fuer Behauptungen ueber einen SATZ. Ein Satz, den der Satzlauf umbrochen hat,
 * steht im PDF in zwei Bloecken — „vorgezogen wegen der" und „Ferien" —, und
 * ein Test, der `toContain('vorgezogen wegen der Ferien')` sagt, waere daran
 * rot, ohne dass etwas falsch waere.
 *
 * Der Preis: Ueber eine Blockgrenze hinweg koennte ein Text zusammenwachsen,
 * den niemand so sieht. Fuer die Behauptungen hier ist das ungefaehrlich — sie
 * nennen ganze Namen und Saetze, und die entstehen nicht aus zwei Zellen, die
 * zufaellig nebeneinanderstehen.
 */
export const pdfTextFlach = (pdf: Buffer): string =>
	pdfText(pdf).replace(/\s+/g, ' ')
