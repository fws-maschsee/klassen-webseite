import type { APIRoute } from 'astro'
import { standLesen } from '../../lib/db/mitbringen.ts'

export const prerender = false

/**
 * `GET /public/mitbringen/<id>/stand` — die Liste als JSON.
 *
 * Die Seite fragt das alle paar Sekunden ab und vergleicht `list.revision`;
 * nur wenn sich der Zaehler bewegt hat, zeichnet sie die Eintraege neu. So
 * sieht jede Familie, was die anderen gerade eingetragen haben, ohne dass
 * jemand die Seite neu laedt — und ohne dass der Server fuer dreissig offene
 * Browser dreissig Mal pro Sekunde die Liste rendert.
 *
 * `?ab=<revision>`: ist der Stand unveraendert, kommt 304 ohne Rumpf.
 */
export const GET: APIRoute = ({ params, url }) => {
	const stand = standLesen(params.id ?? '')
	if (!stand) return new Response('Diese Liste gibt es nicht.', { status: 404 })
	const ab = Number(url.searchParams.get('ab'))
	if (Number.isInteger(ab) && ab === stand.list.revision) {
		return new Response(null, {
			status: 304,
			headers: { 'Cache-Control': 'no-store' },
		})
	}
	return new Response(JSON.stringify(stand), {
		status: 200,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	})
}
