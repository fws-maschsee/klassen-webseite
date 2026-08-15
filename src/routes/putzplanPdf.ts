import type { APIRoute } from 'astro'
import { putzplanAlsPdf } from '../klasse/putzplanPdf.ts'
import {
	TypstFehler,
	TypstFehlt,
	TypstZeitueberschreitung,
} from '../lib/pdf/typst.ts'

export const prerender = false

/**
 * `GET /docs/putzen/putzplan.pdf` — der Putzplan zum Ausdrucken.
 *
 * Liegt HINTER dem Login, und das ist die wichtigste Eigenschaft dieser Route:
 * Im Plan stehen Familiennamen. Unter `/public/` wäre er für jeden abrufbar,
 * der die Adresse kennt, und Adressen werden weitergegeben. Die Middleware
 * schützt alles, was nicht unter einem Pfad aus `PUBLIC_PATHS` liegt — dieser
 * Pfad liegt bewusst neben der Seite, die dieselben Daten zeigt, und ist damit
 * genauso geschützt wie sie.
 *
 * Der Pfad ist vollständig statisch. Nur dadurch gewinnt er gegen shipyards
 * Docs-Catch-all `/docs/[...slug]`, unter dem sonst eine 404-Seite mit
 * `Content-Type: text/html` ausgeliefert würde — und ein PDF-Reader zeigte
 * dann „Datei beschädigt" statt „bitte anmelden".
 *
 * `prerender = false` ist die Grundlage, nicht eine Einstellung: Ein zur
 * Bauzeit erzeugtes PDF zeigte den Plan vom letzten Deploy.
 */
export const GET: APIRoute = async () => {
	try {
		const { pdf, dateiname } = await putzplanAlsPdf()
		return new Response(new Uint8Array(pdf), {
			status: 200,
			headers: {
				'Content-Type': 'application/pdf',
				// `attachment`: Der Plan ist zum Ausdrucken und Aufhängen da, nicht
				// zum Durchblättern im Browser-Tab — die Seite daneben ist dafür das
				// bessere Werkzeug.
				'Content-Disposition': `attachment; filename="${dateiname}"`,
				'Content-Length': String(pdf.byteLength),
				// Der Plan ändert sich über MCP, ohne Deploy. Eine Zwischenstation,
				// die dieses PDF vorhält, lieferte den Stand von gestern aus — bei
				// einem Dokument, das genau deshalb zur Laufzeit erzeugt wird.
				'Cache-Control': 'no-store',
			},
		})
	} catch (fehler) {
		return fehlerAntwort(fehler)
	}
}

/**
 * Aus einem Fehler des Satzlaufs eine Antwort machen, die dem Menschen davor
 * sagt, was los ist — und dem Log, was zu tun ist.
 *
 * Getrennte Meldungen, weil die drei Fälle verschiedene Zuständigkeiten haben:
 * ein fehlendes Programm ist ein unvollständiges Image, eine gerissene Frist
 * ein zu großer oder ein kaputter Plan, ein Satzfehler ein Fehler in der
 * Vorlage. Alle drei als „500" auszugeben hieße, sie beim Nachsehen nicht mehr
 * auseinanderhalten zu können.
 */
const fehlerAntwort = (fehler: unknown): Response => {
	if (fehler instanceof TypstFehlt) {
		console.error(`[putzplan-pdf] ${fehler.message}`)
		return text(
			503,
			'Der PDF-Satz ist auf diesem Server nicht eingerichtet. Die Tabelle auf der Seite zeigt denselben Plan.',
		)
	}
	if (fehler instanceof TypstZeitueberschreitung) {
		console.error(`[putzplan-pdf] ${fehler.message}`)
		return text(
			504,
			'Das PDF war nicht rechtzeitig fertig. Bitte noch einmal versuchen; die Tabelle auf der Seite zeigt denselben Plan.',
		)
	}
	if (fehler instanceof TypstFehler) {
		console.error(`[putzplan-pdf] ${fehler.message}`)
		return text(
			500,
			'Das PDF konnte nicht erzeugt werden. Die Tabelle auf der Seite zeigt denselben Plan.',
		)
	}
	throw fehler
}

const text = (status: number, inhalt: string): Response =>
	new Response(inhalt, {
		status,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	})
