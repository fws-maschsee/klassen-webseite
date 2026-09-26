import type { APIRoute } from 'astro'
import { putzplanAlsPdf } from '../klasse/putzplanPdf.ts'
import {
	TypstFehler,
	TypstFehlt,
	TypstZeitueberschreitung,
} from '../lib/pdf/typst.ts'

// Zur Bauzeit erzeugt zeigte das PDF den Plan vom letzten Deploy.
export const prerender = false

export const GET: APIRoute = async () => {
	try {
		const { pdf, dateiname } = await putzplanAlsPdf()
		return new Response(new Uint8Array(pdf), {
			status: 200,
			headers: {
				'Content-Type': 'application/pdf',
				'Content-Disposition': `attachment; filename="${dateiname}"`,
				'Content-Length': String(pdf.byteLength),
				// Der Plan ändert sich per MCP ohne Deploy; ein Zwischenspeicher lieferte den alten Stand.
				'Cache-Control': 'no-store',
			},
		})
	} catch (fehler) {
		return fehlerAntwort(fehler)
	}
}

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
