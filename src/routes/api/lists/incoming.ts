import type { APIRoute } from 'astro'
import {
	handleIncomingListMail,
	statusForResult,
} from '../../../lib/lists/incoming.ts'
import { authenticateListRequest } from '../../../lib/lists/incomingAuth.ts'

export const prerender = false

/**
 * Eingang für Listenmails aus dem Cloudflare-Email-Worker.
 *
 * Der maßgebliche Vertrag steht in `README.md` des Dispatcher-Repos
 * `lists-dispatcher` (früher `email-worker/README.md`); diese Datei ist die
 * App-Seite davon. Kurzfassung:
 *
 *   POST /api/lists/incoming
 *   Content-Type: message/rfc822
 *   Body: die ROHE, unveränderte Mail — die Signatur deckt genau diese Bytes ab
 *   Header:
 *     X-List-Class         Klassen-Label, z.B. "klasse-wiesen"
 *     X-List-Name          Listen-Localpart, z.B. "eltern"
 *     X-List-Recipient     vollständige Empfängeradresse
 *     X-List-Envelope-From SMTP MAIL FROM — hierauf wird autorisiert
 *     X-List-Message-Id    Message-ID der Mail, falls vorhanden
 *     X-List-Timestamp     Unix-Sekunden
 *     X-List-Key-Id        Kennung des Signierschlüssels — NUR beim neuen,
 *                          zonenweiten Dispatcher. Dieser Header entscheidet
 *                          über das Verfahren, siehe `incomingAuth.ts`
 *     X-List-Signature     mit Key-Id: base64(Ed25519 über die kanonische
 *                                      Zeichenkette, Metadaten mitsigniert)
 *                          ohne:       hex(HMAC-SHA256(secret,
 *                                      `${timestamp}.${rawBody}`))
 *
 *   202 verteilt · 200 angenommen, aber bewusst nicht verteilt ·
 *   403 abgelehnt · 404 Liste unbekannt / fremde Klasse · 413 zu groß ·
 *   401 Signatur ungültig · 500 Störung (Worker stellt später erneut zu)
 *
 * Bei 403/404/413 liest der Worker `reason` aus dem JSON und gibt den Text dem
 * Absender in der SMTP-Antwort zurück. Er darf deshalb nichts Vertrauliches
 * enthalten.
 *
 * Diese Datei liest die `X-List-*`-Header NICHT selbst. Sie bekommt sie geprüft
 * von `authenticateListRequest` und arbeitet ausschließlich mit dem Ergebnis
 * weiter — im Ed25519-Pfad sind das die SIGNIERTEN Werte, und ein zweiter Griff
 * in `request.headers` würde die Signatur um ihre Wirkung bringen.
 */

/**
 * Eigenes Größenlimit. Der Worker prüft bereits gegen sein `MAX_MESSAGE_BYTES`
 * (Default 10 MiB); diese Prüfung ist die zweite Verteidigungslinie für den
 * Fall, dass jemand direkt auf den Endpunkt zugreift oder die Worker-Variable
 * zu großzügig steht. Jede angenommene Mail wird vollständig geparst und
 * anschließend an jeden Empfänger einzeln über SES ausgeliefert.
 */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

const maxBytes = (): number =>
	Number.parseInt(process.env.MAX_MESSAGE_BYTES ?? `${DEFAULT_MAX_BYTES}`, 10)

const megabytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)

export const POST: APIRoute = async ({ request }) => {
	const rawBody = Buffer.from(await request.arrayBuffer())

	const auth = authenticateListRequest({ headers: request.headers, rawBody })
	if (!auth.ok) {
		return Response.json(
			auth.anAbsender ? { reason: auth.reason } : { error: auth.reason },
			{ status: auth.status },
		)
	}
	// Ab hier nur noch diese Werte — nicht `request.headers`.
	const { list, envelopeFrom, messageId } = auth.request

	const limit = maxBytes()
	if (rawBody.length > limit) {
		return Response.json(
			{
				reason: `Nachricht zu groß (${megabytes(rawBody.length)} MB, erlaubt sind ${megabytes(limit)} MB). Bitte große Anhänge verlinken statt anhängen.`,
			},
			{ status: 413 },
		)
	}

	// HIER STAND EIN ABGLEICH MIT ZITADEL, und hier kommt keiner mehr hin.
	//
	// Vor jeder Listenmail wurden die Grants geholt und INS ADRESSBUCH
	// GESCHRIEBEN — Neuzugaenge angelegt, Personen ohne Grant geloescht. Das ist
	// entfallen und bleibt entfallen: Adressbuch und ZITADEL sind getrennte
	// Datenschichten (Entscheidung des Betreibers, siehe README). Wer Post
	// bekommt, steht im Adressbuch, weil ein Mensch ihn eingetragen hat.
	//
	// WAS SEIT DEM 15.08. TROTZDEM FRAGT: die Konten-Pruefung vor dem Versand,
	// in `handleIncomingListMail` (`src/lib/versand/kontopruefung.ts`). Sie
	// VERGLEICHT die Empfaenger mit den Grant-Inhabern und laesst die
	// Nicht-Passenden weg; sie schreibt nichts. Sie musste kommen, weil der
	// frueher an dieser Stelle notierte Preis zu hoch war: Ein entzogener Grant
	// nahm niemandem die Post, und ein Entzug loest kein Ereignis aus, das der
	// Webhook auffangen koennte (`user.removed` meldet das geloeschte Konto,
	// nicht die entzogene Rolle).
	//
	// Damit ist der Eingang nicht mehr unabhaengig von ZITADELs Verfuegbarkeit.
	// In der Vorgabe-Betriebsart `report` aendert eine Stoerung nichts an der
	// Verteilung. In `enforce` haelt sie die Mail auf — und dann kommt sie hier
	// als `unavailable` an und wird mit 503 beantwortet, also mit einer
	// spaeteren Zustellung durch den Worker und nicht mit einer Ablehnung beim
	// Absender.
	try {
		const result = await handleIncomingListMail(rawBody, {
			listName: list,
			envelopeFrom,
			messageId,
		})
		return Response.json(result, { status: statusForResult(result) })
	} catch (err) {
		// 5xx heißt für den Worker "später erneut zustellen" - genau richtig für
		// einen unerwarteten Fehler auf unserer Seite.
		console.error('[lists/incoming] unerwarteter Fehler', err)
		return Response.json(
			{ error: err instanceof Error ? err.message : String(err) },
			{ status: 500 },
		)
	}
}
