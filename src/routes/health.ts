import type { APIRoute } from 'astro'
import { klassenConfig } from '../klasse/config.ts'
import { gesundheit } from '../klasse/health.ts'
import { instanceName } from '../lib/db/instance.ts'

export const prerender = false

/**
 * `GET /public/health` — welcher Stand läuft hier?
 *
 * Liegt unter `/public/`, weil dieser Pfad ohnehin ohne Anmeldung erreichbar
 * ist (der Klassenkalender wohnt dort). Ein eigener offener Pfad wäre eine
 * Ausnahme mehr in der Anmeldung, und die will man für einen Endpunkt, der drei
 * Zeichenketten ausgibt, nicht haben.
 *
 * Die Antwort ist immer 200. Das ist Absicht und keine Nachlässigkeit: Der
 * Endpunkt sagt „diese Anwendung nimmt Anfragen an und das ist ihr Stand" — und
 * genau das ist die Frage einer Readiness-Probe. Was er NICHT tut, ist die
 * Datenbank oder den Mailversand prüfen. Täte er das, würde eine vollgelaufene
 * Warteschlange den Pod aus dem Service nehmen und die Seite abschalten, obwohl
 * sie tadellos funktioniert.
 *
 * `instanceName()` liest die Instanz-Identität, die beim Start schon gegen den
 * Inhalt der Datenbank geprüft wurde (`assertInstanceMatches`) — der Wert ist
 * hier also nicht bloß eine Env-Variable, sondern die geprüfte Identität. Läuft
 * die falsche Datei, fährt die Anwendung gar nicht hoch, und dann antwortet
 * dieser Endpunkt auch nicht.
 */
export const GET: APIRoute = () => {
	const config = klassenConfig()

	const auskunft = gesundheit({
		instanz: instanceName(),
		env: process.env,
		listKeyIds: config.listKeyIds,
		hatPublicKey: Boolean(config.listPublicKeyPem?.trim()),
	})

	return new Response(JSON.stringify(auskunft, null, 2), {
		status: 200,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			// Ohne das antwortet irgendeine Zwischenstation den Stand von gestern —
			// bei einem Endpunkt, dessen einziger Zweck die Aktualität ist.
			'Cache-Control': 'no-store',
		},
	})
}
