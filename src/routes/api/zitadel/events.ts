import type { APIRoute } from 'astro'
import {
	handleZitadelEvent,
	SIGNATURE_HEADER,
	signingKey,
} from '../../../lib/zitadel/events.ts'

export const prerender = false

/**
 * `POST /api/zitadel/events` — der Empfaenger fuer ZITADEL Actions v2.
 *
 *   Header: ZITADEL-Signature: t=<Unix-Sekunden>,v1=<hex HMAC-SHA256>
 *   Rumpf:  die Ereignis-Nutzlast als JSON
 *
 *   200 verarbeitet oder bewusst uebergangen · 400 Nutzlast unlesbar ·
 *   401 Unterschrift fehlt oder passt nicht · 503 kein Signaturschluessel
 *   konfiguriert (ZITADEL versucht es dann spaeter erneut)
 *
 * Die Fachlogik steht in `src/lib/zitadel/events.ts`; diese Datei ist nur die
 * HTTP-Haut darum — dieselbe Aufteilung wie beim Listeneingang, und aus
 * demselben Grund: Was geprueft und geloescht wird, muss ohne Server testbar
 * sein.
 *
 * Der Pfad liegt unter `/api/zitadel/` und damit in `PUBLIC_PATHS`. Das ist
 * kein Loch: Der Endpunkt ist nicht ungeschuetzt, sondern signaturgeprueft —
 * genau wie `/api/lists/`. ZITADEL kann kein Sitzungscookie mitbringen; die
 * einzige Alternative waere ein zweiter Anmeldemechanismus.
 *
 * DIE REIHENFOLGE HIER IST ABSICHT: erst der Header, dann der Rumpf. Fehlt die
 * Unterschrift, wird der Rumpf gar nicht erst eingelesen — ein Aufruf ohne
 * Beweis darf nicht einmal Arbeitsspeicher kosten.
 */
export const POST: APIRoute = async ({ request }) => {
	const signature = request.headers.get(SIGNATURE_HEADER)
	if (!signature) {
		return Response.json({ error: 'invalid signature' }, { status: 401 })
	}

	const rawBody = await request.text()

	try {
		const { status, body } = handleZitadelEvent({
			rawBody,
			signature,
			signingKey: signingKey(),
		})
		return Response.json(body, { status })
	} catch (err) {
		// 5xx heisst fuer ZITADEL „spaeter erneut versuchen" — richtig fuer eine
		// Stoerung bei uns, und unschaedlich, weil das Loeschen idempotent ist.
		console.error('[zitadel/events] unerwarteter Fehler', err)
		return Response.json(
			{ error: err instanceof Error ? err.message : String(err) },
			{ status: 500 },
		)
	}
}
