import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Shared-Secret-Authentifizierung zwischen Cloudflare-Email-Worker und App.
 *
 * DAS ÄLTERE DER ZWEI VERFAHREN. Es gilt für die Worker JE KLASSE, die über
 * literale Email-Routing-Regeln getriggert werden. Der neue zonenweite
 * Dispatcher signiert stattdessen mit Ed25519 (`signatureEd25519.ts`) und
 * schickt dabei `X-List-Key-Id` mit; welcher Pfad greift, entscheidet allein
 * dieser Header (`authenticateListRequest` in `incomingAuth.ts`). Solange beide
 * Worker-Generationen gleichzeitig einliefern, bleibt dieses Verfahren scharf —
 * abgeschaltet wird es erst, wenn die letzte Klasse umgestellt ist.
 *
 * Signiert wird `${timestamp}.${rawBody}` per HMAC-SHA256 (hex) — dasselbe
 * Verfahren auf beiden Seiten (Stripe-Style). Der Timestamp begrenzt
 * Replay-Angriffe, der Vergleich ist timing-safe.
 *
 * Was hier NICHT gedeckt ist: die Metadaten. Die Signatur bindet nur Zeitpunkt
 * und Body, nicht Klasse, Liste oder Envelope-Absender — die stehen ungeprüft
 * in den Headern. Tragbar war das nur, weil das Secret je Klasse verschieden
 * ist; genau diese Lücke schließt v2, indem es die Metadaten mitsigniert.
 *
 * Warum kein simples Bearer-Token: Der Worker schickt die vollstaendige
 * Original-Mail. Ein reines Token wuerde nur beweisen, dass der Aufrufer das
 * Token kennt; die Signatur bindet zusaetzlich den konkreten Inhalt und den
 * Zeitpunkt, sodass ein abgefangener Request nicht mit veraendertem Body oder
 * Stunden spaeter wiederverwendet werden kann.
 */

/** Max. Alter der Signatur in Sekunden (gegen Replay). */
export const MAX_SKEW_SECONDS = 300

/**
 * Header-Namen des Vertrags mit dem Cloudflare-Email-Worker. Maßgeblich
 * dokumentiert in `email-worker/README.md` bzw. `README.md` des Dispatchers —
 * hier stehen sie als Konstanten, damit ein Tippfehler nicht erst im Betrieb
 * auffällt.
 *
 * Sie stehen in DIESER Datei, obwohl beide Verfahren sie brauchen: Es ist ein
 * Vertrag mit zwei Ausbaustufen, keine zwei Verträge. Zwei Sätze
 * Header-Konstanten wären die eine Kopie, an der sich ein Tippfehler
 * unbemerkt einschleicht. Fällt der HMAC-Pfad weg, wandern sie nach
 * `signatureEd25519.ts`.
 */
export const HEADER_CLASS = 'x-list-class'
export const HEADER_LIST_NAME = 'x-list-name'
export const HEADER_RECIPIENT = 'x-list-recipient'
export const HEADER_ENVELOPE_FROM = 'x-list-envelope-from'
export const HEADER_MESSAGE_ID = 'x-list-message-id'
export const HEADER_TIMESTAMP = 'x-list-timestamp'
export const HEADER_SIGNATURE = 'x-list-signature'
/**
 * Kennung des Signierschlüssels. Schickt nur der neue Dispatcher, und genau
 * daran wird das Verfahren erkannt: Header vorhanden -> Ed25519, Header fehlt
 * -> HMAC. Ein Wert, den ein Angreifer weglassen kann, wählt damit das
 * Verfahren — was nichts schwächt, weil dann der HMAC-Pfad mit vollem Ernst
 * greift und ohne das Secret nichts durchkommt.
 */
export const HEADER_KEY_ID = 'x-list-key-id'

export const computeSignature = (
	secret: string,
	timestamp: string,
	rawBody: Buffer | string,
): string =>
	createHmac('sha256', secret)
		.update(`${timestamp}.`)
		.update(rawBody)
		.digest('hex')

export type VerifyResult = { ok: true } | { ok: false; reason: string }

/**
 * Prueft die Signatur eines eingehenden Worker-Requests:
 *  - Secret muss konfiguriert sein,
 *  - Timestamp darf nicht aelter als `MAX_SKEW_SECONDS` sein,
 *  - HMAC muss timing-safe uebereinstimmen.
 */
export const verifyListSignature = (params: {
	secret: string | undefined
	timestamp: string | null
	signature: string | null
	rawBody: Buffer
	nowSeconds?: number
}): VerifyResult => {
	const { secret, timestamp, signature, rawBody } = params
	if (!secret) return { ok: false, reason: 'LIST_WEBHOOK_SECRET nicht gesetzt' }
	if (!timestamp || !signature) {
		return { ok: false, reason: 'Signatur-Header fehlen' }
	}
	const ts = Number.parseInt(timestamp, 10)
	if (!Number.isFinite(ts))
		return { ok: false, reason: 'ungueltiger Timestamp' }
	const now = params.nowSeconds ?? Math.floor(Date.now() / 1000)
	if (Math.abs(now - ts) > MAX_SKEW_SECONDS) {
		return { ok: false, reason: 'Timestamp ausserhalb der Toleranz' }
	}

	const expected = computeSignature(secret, timestamp, rawBody)
	const a = Buffer.from(expected, 'hex')
	const b = Buffer.from(signature, 'hex')
	if (a.length !== b.length || !timingSafeEqual(a, b)) {
		return { ok: false, reason: 'Signatur stimmt nicht' }
	}
	return { ok: true }
}
