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

export const GET: APIRoute = async ({ url }) => {
	const blatt = klassenConfig().blaetter.find((b) => b.pfad === url.pathname)
	if (!blatt) {
		return text(404, 'Dieses Blatt gibt es nicht.')
	}

	try {
		const pdf = await setze(blatt)
		return new Response(new Uint8Array(pdf), {
			status: 200,
			headers: {
				'Content-Type': 'application/pdf',
				'Content-Disposition': `inline; filename="${blatt.dateiname}"`,
				'Content-Length': String(pdf.byteLength),
				'Cache-Control': 'no-store',
			},
		})
	} catch (fehler) {
		return fehlerAntwort(blatt, fehler)
	}
}

const setze = async (blatt: Blatt): Promise<Buffer> => {
	const vorlage = await readFile(path.resolve(blatt.quelle), 'utf8')
	// Leeres `daten`, weil `typstPdf` die Datei immer schreibt; die Blätter lesen sie nicht.
	return typstPdf({ vorlage, daten: {} })
}

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
