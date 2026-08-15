import { getCollection } from 'astro:content'
import type { APIRoute } from 'astro'
import type { StundenplanEintrag } from '../../../src/klasse/stundenplan.ts'
import { stundenplanAlsPdf } from '../../../src/klasse/stundenplanPdf.ts'
import {
	TypstFehler,
	TypstFehlt,
	TypstZeitueberschreitung,
} from '../../../src/lib/pdf/typst.ts'

export const prerender = false

/**
 * `GET /docs/stundenplan.pdf` — der Stundenplan zum Ausdrucken, eine Seite je
 * Gruppe, mit leeren Zeilen für das Nachmittagsprogramm.
 *
 * Liegt hinter dem Login wie die Seite daneben, die dieselben Daten zeigt. Im
 * Plan steht zwar kein Name eines Kindes — aber wer wann wo ist, ist eine
 * Angabe über dreißig Kinder, und sie gehört nicht an eine Adresse, die man
 * weitergeben kann. Die Middleware schützt alles, was nicht unter einem Pfad
 * aus `PUBLIC_PATHS` liegt.
 *
 * Liegt unter `astro/` und nicht bei den übrigen Routen in `src/routes/`, weil
 * sie `astro:content` braucht: `getCollection` ist ein virtuelles Modul und
 * existiert nur innerhalb einer Astro-Kompilierung. Im Nodeteil des Projekts
 * (`tsconfig.json`) gibt es dafür keine Typen, und `astro check` liefe an der
 * Datei vorbei — der Fehler fiele erst im Build einer Klasse auf.
 *
 * Der Pfad ist vollständig statisch. Nur dadurch gewinnt er gegen shipyards
 * Docs-Catch-all `/docs/[...slug]`, unter dem sonst eine 404-Seite mit
 * `Content-Type: text/html` ausgeliefert würde — und ein PDF-Reader zeigte
 * dann „Datei beschädigt" statt „bitte anmelden".
 */
export const GET: APIRoute = async () => {
	try {
		const eintraege = (await getCollection(
			'stundenplan',
		)) as StundenplanEintrag[]
		const { pdf, dateiname } = await stundenplanAlsPdf(eintraege)
		return new Response(new Uint8Array(pdf), {
			status: 200,
			headers: {
				'Content-Type': 'application/pdf',
				// `attachment`: Der Plan ist zum Ausdrucken und Einheften da, nicht
				// zum Durchblättern im Browser-Tab — die Seite daneben ist dafür das
				// bessere Werkzeug, und nur der Ausdruck hat die Felder zum Ausfüllen.
				'Content-Disposition': `attachment; filename="${dateiname}"`,
				'Content-Length': String(pdf.byteLength),
				// Anders als beim Putzplan ändert sich der Stundenplan nur mit einem
				// Deploy. Trotzdem `no-store`: Das PDF trägt seinen Erzeugungs-
				// zeitpunkt im Fuß, und ein Zwischenspeicher machte daraus ein Blatt,
				// auf dem ein falsches „Stand:" steht. Ein Stundenplan wird einmal im
				// Schuljahr heruntergeladen; hier ist nichts zu sparen.
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
 * Getrennte Meldungen wie beim Putzplan-PDF, weil die drei Fälle verschiedene
 * Zuständigkeiten haben: ein fehlendes Programm ist ein unvollständiges Image,
 * eine gerissene Frist ein zu großer oder kaputter Plan, ein Satzfehler ein
 * Fehler in der Vorlage. Alle drei als „500" auszugeben hieße, sie beim
 * Nachsehen nicht mehr auseinanderhalten zu können.
 */
const fehlerAntwort = (fehler: unknown): Response => {
	if (fehler instanceof TypstFehlt) {
		console.error(`[stundenplan-pdf] ${fehler.message}`)
		return text(
			503,
			'Der PDF-Satz ist auf diesem Server nicht eingerichtet. Die Tabelle auf der Seite zeigt denselben Plan.',
		)
	}
	if (fehler instanceof TypstZeitueberschreitung) {
		console.error(`[stundenplan-pdf] ${fehler.message}`)
		return text(
			504,
			'Das PDF war nicht rechtzeitig fertig. Bitte noch einmal versuchen; die Tabelle auf der Seite zeigt denselben Plan.',
		)
	}
	if (fehler instanceof TypstFehler) {
		console.error(`[stundenplan-pdf] ${fehler.message}`)
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
