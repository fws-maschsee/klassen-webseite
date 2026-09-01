import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { APIRoute } from 'astro'
import { type Blatt, klassenConfig } from '../klasse/config.ts'
import {
	TypstFehler,
	TypstFehlt,
	TypstZeitueberschreitung,
	typstPdf,
} from '../lib/pdf/typst.ts'

export const prerender = false

/**
 * Ein Blatt der Klasse als PDF — gesetzt beim Abruf aus seiner Typst-Quelle.
 *
 * Diese eine Route bedient ALLE Blätter einer Klasse; welches gemeint ist,
 * steht in `blaetter` der `KlassenConfig` und wird über den angefragten Pfad
 * herausgesucht. Die Astro-Integration hängt sie je Eintrag einmal ein.
 *
 * Zwei Eigenschaften sind der Zweck der Übung, und beide sind gegen einen
 * konkreten Fehler geschrieben:
 *
 * 1. **Das PDF liegt nicht unter `public/`.** Dort wird ohne Anmeldung
 *    ausgeliefert — dorthin gehört genau eine Sache, der Kalender, den eine
 *    Kalender-App ohne Cookie abholen muss. Ein Blatt der Klasse dort abzulegen
 *    heißt, es für jeden abrufbar zu machen, der die Adresse kennt. Diese Route
 *    liegt unter einem normalen Pfad und damit hinter derselben Anmeldung wie
 *    die Seite, die darauf verlinkt.
 *
 * 2. **Das PDF steht nicht im Repository.** Ein eingechecktes PDF ist eine
 *    zweite Quelle neben der `.typ`; es veraltet, ohne dass man es ihm ansieht,
 *    und niemand merkt es, bis jemand den falschen Zettel an der Wand hat.
 *
 * Gesetzt wird bei jedem Abruf und nicht beim Bauen. Das kostet den Bruchteil
 * einer Sekunde und spart die ganze Klasse von Fehlern, die entstehen, wenn ein
 * Erzeugnis und seine Quelle auseinanderlaufen können.
 */
export const GET: APIRoute = async ({ url }) => {
	const blatt = klassenConfig().blaetter.find((b) => b.pfad === url.pathname)
	if (!blatt) {
		// Kann nur auftreten, wenn jemand eine Route einhängt, die nicht in der
		// Konfiguration steht — dann ist die Konfiguration die Wahrheit.
		return text(404, 'Dieses Blatt gibt es nicht.')
	}

	try {
		const pdf = await setze(blatt)
		return new Response(new Uint8Array(pdf), {
			status: 200,
			headers: {
				'Content-Type': 'application/pdf',
				// `inline`: Ein Blatt zum Ausdrucken schaut man sich vorher an, und
				// aus der Vorschau heraus druckt jeder Browser direkt.
				'Content-Disposition': `inline; filename="${blatt.dateiname}"`,
				'Content-Length': String(pdf.byteLength),
				// Kein Zwischenspeicher: Das Blatt ändert sich mit dem nächsten
				// Deploy, und ein vorgehaltenes PDF wäre genau der veraltete Zettel,
				// den diese Route verhindern soll.
				'Cache-Control': 'no-store',
			},
		})
	} catch (fehler) {
		return fehlerAntwort(blatt, fehler)
	}
}

/**
 * Die Quelle lesen und setzen.
 *
 * Der Pfad kommt aus der Konfiguration und wird gegen das Arbeitsverzeichnis
 * aufgelöst — das ist die Wurzel der Klasse, dort liegt auch ihre
 * `package.json`. `resolve` normalisiert dabei; dass die Quelle unter `src/`
 * liegen muss, prüft `defineKlassenConfig` schon beim Bauen.
 */
const setze = async (blatt: Blatt): Promise<Buffer> => {
	const vorlage = await readFile(path.resolve(blatt.quelle), 'utf8')
	// Kein `daten.json`: Diese Blätter sind vollständig, sie lesen nichts von
	// außen. Der leere Wert ist trotzdem nötig, weil `typstPdf` ihn immer
	// schreibt — eine Vorlage, die ihn nicht liest, stört das nicht.
	return typstPdf({ vorlage, daten: {} })
}

/**
 * Aus einem Fehler eine Antwort machen, die dem Menschen davor sagt, was los
 * ist — und dem Log, was zu tun ist. Getrennt nach Zuständigkeit, wie bei der
 * Putzplan-Route: ein fehlendes Programm ist ein unvollständiges Image, eine
 * gerissene Frist eine zu große Vorlage, ein Satzfehler ein Fehler in der
 * Quelle.
 */
const fehlerAntwort = (blatt: Blatt, fehler: unknown): Response => {
	if (fehler instanceof TypstFehlt) {
		console.error(`[blatt-pdf] ${blatt.quelle}: ${fehler.message}`)
		return text(503, 'Der PDF-Satz ist auf diesem Server nicht eingerichtet.')
	}
	if (fehler instanceof TypstZeitueberschreitung) {
		console.error(`[blatt-pdf] ${blatt.quelle}: ${fehler.message}`)
		return text(504, 'Das Blatt konnte nicht rechtzeitig gesetzt werden.')
	}
	if (fehler instanceof TypstFehler) {
		console.error(`[blatt-pdf] ${blatt.quelle}: ${fehler.message}`)
		return text(500, 'Das Blatt konnte nicht gesetzt werden.')
	}
	if ((fehler as NodeJS.ErrnoException)?.code === 'ENOENT') {
		console.error(`[blatt-pdf] Quelle fehlt: ${blatt.quelle}`)
		return text(500, 'Die Quelle dieses Blattes fehlt auf dem Server.')
	}
	console.error(`[blatt-pdf] ${blatt.quelle}:`, fehler)
	return text(500, 'Das Blatt konnte nicht gesetzt werden.')
}

const text = (status: number, inhalt: string): Response =>
	new Response(inhalt, {
		status,
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	})
