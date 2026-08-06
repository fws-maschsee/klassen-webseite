import {
	createHash,
	createPublicKey,
	verify as verifyEd25519,
} from 'node:crypto'
import {
	HEADER_CLASS,
	HEADER_ENVELOPE_FROM,
	HEADER_KEY_ID,
	HEADER_LIST_NAME,
	HEADER_MESSAGE_ID,
	HEADER_RECIPIENT,
	HEADER_SIGNATURE,
	HEADER_TIMESTAMP,
} from './signature.ts'

/**
 * Ed25519-Prüfung der Aufrufe des zonenweiten Dispatchers (`fwslist.v2`).
 *
 * Der Vorgänger war ein Cloudflare-Worker JE KLASSE mit einem geteilten
 * HMAC-Secret (`signature.ts`). Damit hielt jede App ein Geheimnis, mit dem
 * sich Aufrufe an sie selbst fälschen lassen — also Mail unter beliebigem
 * Absender an die Eltern der Klasse, ohne jede Berechtigungsprüfung. Beim
 * neuen Dispatcher liegt der Privatschlüssel nur dort; die Apps bekommen den
 * öffentlichen Teil, denselben Wert für alle Klassen, im Klartext eingecheckt.
 *
 * Dafür fällt eine Eigenschaft weg, die vorher gratis war: Mit einem Secret je
 * Klasse kam die Klassenbindung aus dem Schlüssel selbst — nur der
 * Wiesen-Schlüssel erzeugte gültige Wiesen-Signaturen. Jetzt verifiziert JEDE
 * Klasse mit demselben öffentlichen Schlüssel, also müssen die Metadaten IN
 * die Signatur. Ohne die Klasse in der signierten Zeichenkette ließe sich ein
 * abgefangener, gültig signierter Aufruf für Klasse A mit geändertem
 * `X-List-Class` bei Klasse B einliefern.
 *
 * ACHTUNG, ZWEI ORTE: Die kanonische Zeichenkette (`buildSigningInput`) gibt es
 * zweimal — hier und im Dispatcher-Repo `lists-dispatcher` in `src/signature.ts`
 * (dort signierend) samt der zum Kopieren gedachten Vorlage `reference/verify.ts`,
 * nach der diese Datei gebaut ist. Eine Änderung am Format betrifft IMMER beide
 * Seiten; einseitig geändert kommt keine Elternpost mehr durch. Abgesichert ist
 * das durch einen Golden-String-Test auf jeder Seite: hier
 * `tests/lists/signatureEd25519.test.ts`, dort `test/reference.test.ts`. Wer das
 * Format ändert, ändert beide Golden Strings — und merkt daran, dass er zwei
 * Repos anfassen muss.
 */

/**
 * Version des Signaturformats. Steht als erste Zeile IN der signierten
 * Zeichenkette, damit ein späteres v3 nicht als v2 durchgehen kann.
 */
export const SIGNING_VERSION = 'fwslist.v2'

/**
 * Zeitfenster für den Replay-Schutz, in Sekunden. Muss zum Dispatcher passen.
 *
 * Bewusst eine eigene Konstante und nicht `MAX_SKEW_SECONDS` aus `signature.ts`:
 * Das sind zwei Verträge mit zwei Gegenstellen, die zufällig denselben Wert
 * haben. Wird einer davon großzügiger, soll der andere es nicht mitmachen.
 *
 * Gegen doppelte VERTEILUNG schützt dieses Fenster ohnehin nicht — SMTP ist
 * at-least-once, dieselbe Mail darf legitim mehrfach ankommen. Das leistet die
 * Idempotenz in `incoming.ts` über Message-ID plus Liste.
 */
export const TIMESTAMP_TOLERANCE_SECONDS = 300

/**
 * Die signierten Felder — und damit die einzigen Werte, denen die App glauben
 * darf.
 */
export type ListRequestFields = {
	keyId: string
	/** Klassen-Label; ist gegen die eigene Klasse geprüft. */
	class: string
	/** Listen-Localpart, z.B. `eltern`. */
	list: string
	/** Vollständige Envelope-Empfängeradresse. */
	recipient: string
	/** SMTP `MAIL FROM` — HIERAUF ist zu autorisieren, nie auf den `From:`-Header. */
	envelopeFrom: string
	/** `Message-ID:` der Mail, oder `null` wenn sie keine hat. */
	messageId: string | null
	/** Unix-Zeit in Sekunden, Dezimalstring. */
	timestamp: string
	/** SHA-256 der Body-Bytes, hex. SELBST berechnet, nie aus einem Header. */
	bodyHash: string
}

export type VerifyListRequestResult =
	| {
			ok: true
			/**
			 * Ab hier gilt: weiterarbeiten mit DIESEN Werten, nicht mit den Headern
			 * des Requests. Beides sieht gleich aus, ist es aber nicht — nur diese
			 * Werte sind von der Signatur gedeckt. Wer nach der Prüfung erneut
			 * `request.headers.get('x-list-class')` liest, hat sie umsonst gemacht.
			 */
			fields: ListRequestFields
	  }
	| {
			ok: false
			/**
			 * Immer 401, auch bei fremder Klasse, unbekannter Key-Id oder fehlender
			 * Konfiguration. Alle diese Fälle sind Konfigurations- oder
			 * Manipulationsfehler und keine Absenderfehler — der Dispatcher
			 * behandelt 401 deshalb als Störung und stellt später erneut zu, statt
			 * die Mail dem Absender zurückzugeben.
			 */
			status: 401
			reason: string
	  }

export type VerifyListRequestOptions = {
	/** Alles mit `get(name)` — `Headers`, `node:http`-Header, ein Objektliteral. */
	headers: { get(name: string): string | null | undefined }
	/** Die rohen Body-Bytes, VOR jedem Parsen. */
	rawBody: Uint8Array
	/** Öffentlicher Ed25519-Schlüssel als SPKI-PEM. Kein Secret, eingecheckt. */
	publicKeyPem: string
	/** Die eigene Klasse. */
	expectedClass: string
	/** Akzeptierte Key-Ids. Zu genau einer davon passt `publicKeyPem`. */
	keyIds: readonly string[]
	now?: Date
}

const deny = (reason: string): VerifyListRequestResult => ({
	ok: false,
	status: 401,
	reason,
})

const headerValue = (
	headers: VerifyListRequestOptions['headers'],
	name: string,
): string | null => {
	const value = headers.get(name)
	return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Baut die zu signierende Zeichenkette: ein Feld je Zeile, Trenner `\n`, kein
 * abschließender Zeilenumbruch. Muss ZEICHENGENAU zu `buildSigningInput` im
 * Dispatcher passen (siehe der Hinweis am Dateikopf).
 *
 * Die Zeile für die Message-ID bleibt auch dann stehen, wenn es keine gibt —
 * sonst wären zwei verschiedene Feldbelegungen auf dieselbe Zeichenkette
 * abbildbar.
 */
export const buildSigningInput = (fields: ListRequestFields): string =>
	[
		SIGNING_VERSION,
		fields.keyId,
		fields.class,
		fields.list,
		fields.recipient,
		fields.envelopeFrom,
		fields.messageId ?? '',
		fields.timestamp,
		fields.bodyHash,
	].join('\n')

/**
 * Leitet die Key-Id aus einem öffentlichen Schlüssel ab: die ersten 16
 * Hex-Zeichen von SHA-256 über den rohen, 32 Byte langen Schlüssel.
 *
 * Abgeleitet und nicht frei gewählt, damit Id und Schlüssel nicht
 * auseinanderlaufen können: Zu einer Id gehört genau ein Schlüssel,
 * nachrechenbar aus dem PEM allein. Genau das prüft `defineKlassenConfig` — ein
 * eingecheckter Schlüssel mit einer nicht dazu passenden Id fällt damit beim
 * Start auf und nicht erst an der ersten Elternmail.
 *
 * Die rohen Bytes kommen aus dem JWK-Export (`x`, base64url) statt aus einem
 * Offset in die DER-Struktur — gleiches Ergebnis, aber ohne die Annahme, dass
 * das SPKI-Präfix genau 12 Byte lang bleibt. Dieselbe Rechnung steht in
 * `scripts/generate-keypair.mjs` des Dispatchers.
 *
 * Wirft bei allem, was kein Ed25519-SPKI-PEM ist: Eine falsche Konfiguration
 * soll laut scheitern und keine Id erfinden, zu der nie eine Signatur passt.
 */
export const listKeyIdFromPem = (publicKeyPem: string): string => {
	let x: string | undefined
	try {
		x = createPublicKey(publicKeyPem).export({ format: 'jwk' }).x
	} catch (error) {
		throw new Error(
			`listPublicKeyPem ist kein lesbarer oeffentlicher Schluessel (SPKI-PEM erwartet): ${(error as Error).message}`,
		)
	}
	const raw = x === undefined ? Buffer.alloc(0) : Buffer.from(x, 'base64url')
	if (raw.length !== 32) {
		throw new Error(
			`listPublicKeyPem ist kein Ed25519-Schluessel (${raw.length} statt 32 Byte)`,
		)
	}
	return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/**
 * Prüft einen Aufruf des Dispatchers und gibt die SIGNIERTEN Felder zurück.
 *
 * Der aufrufende Code muss ab hier ausschließlich mit `result.fields`
 * weiterarbeiten und `request.headers` nicht mehr anfassen — die Header sind
 * unbeglaubigt, die Felder sind es nicht. Im Route-Handler
 * (`src/routes/api/lists/incoming.ts`) ist das über
 * `authenticateListRequest` so umgesetzt: dort wird nach der Prüfung kein
 * `X-List-*`-Header mehr gelesen.
 *
 * Die Reihenfolge ist Absicht — jede Stufe hat einen Grund, VOR der nächsten zu
 * stehen:
 *
 * 1. **Key-Id** aus der Positivliste. Fängt einen zurückgezogenen Schlüssel mit
 *    einer klaren Meldung ab, statt ihn erst an der Signatur scheitern zu
 *    lassen. Eine leere Positivliste oder ein leeres PEM lehnen ab, statt
 *    durchzulassen: Eine fehlende Konfiguration ist ein 401 und keine
 *    Ausnahme von der Prüfung.
 * 2. **Zeitfenster.** Billig, und ein altes Token muss nicht erst
 *    kryptografisch geprüft werden.
 * 3. **Body-Hash.** SELBST über die empfangenen Bytes gebildet und so in die
 *    kanonische Zeichenkette gegeben. Daran hängt die Integrität des Bodys: Die
 *    Signatur deckt nur einen Hash ab, und wenn dieser Hash unser eigener ist,
 *    deckt sie die Bytes, die wir wirklich gelesen haben. Deshalb schickt der
 *    Dispatcher auch keinen Hash-Header mit — ein mitgeschickter Hash wäre eine
 *    Einladung, ihn zu vergleichen statt ihn zu berechnen.
 * 4. **Klasse.** Fremde Klasse -> abweisen, bevor irgendetwas passiert. Das ist
 *    der Datenschutzfall: Alle Klassen verifizieren mit demselben öffentlichen
 *    Schlüssel, also unterscheidet nur dieser Vergleich (und die mitsignierte
 *    Klasse in Schritt 5) Post der eigenen von Post der Nachbarklasse.
 * 5. **Ed25519-Signatur** über die vollständige kanonische Zeichenkette. Erst
 *    hier steht fest, dass die Werte aus 1–4 auch die signierten sind.
 */
export const verifyListRequest = ({
	headers,
	rawBody,
	publicKeyPem,
	expectedClass,
	keyIds,
	now = new Date(),
}: VerifyListRequestOptions): VerifyListRequestResult => {
	if (keyIds.length === 0) return deny('listKeyIds ist leer')
	if (publicKeyPem.trim().length === 0) return deny('listPublicKeyPem ist leer')

	const keyId = headerValue(headers, HEADER_KEY_ID)
	if (keyId === null) return deny('X-List-Key-Id fehlt')
	if (!keyIds.includes(keyId)) return deny('Unbekannte Key-Id')

	const timestamp = headerValue(headers, HEADER_TIMESTAMP)
	if (timestamp === null || !/^[0-9]{1,20}$/.test(timestamp)) {
		return deny('X-List-Timestamp fehlt oder ist keine Unix-Zeit')
	}
	const age = Math.floor(now.getTime() / 1000) - Number(timestamp)
	if (Math.abs(age) > TIMESTAMP_TOLERANCE_SECONDS) {
		return deny('X-List-Timestamp liegt ausserhalb des Zeitfensters')
	}

	// Kein timing-safe Vergleich nötig: Beide Seiten sind der Hash öffentlicher
	// Daten, hier ist kein Geheimnis zu erraten.
	const bodyHash = createHash('sha256').update(rawBody).digest('hex')

	const listClass = headerValue(headers, HEADER_CLASS)
	if (listClass !== expectedClass) {
		return deny('Aufruf gehoert zu einer anderen Klasse')
	}

	const list = headerValue(headers, HEADER_LIST_NAME)
	if (list === null) return deny('X-List-Name fehlt')
	const recipient = headerValue(headers, HEADER_RECIPIENT)
	if (recipient === null) return deny('X-List-Recipient fehlt')
	const envelopeFrom = headerValue(headers, HEADER_ENVELOPE_FROM)
	if (envelopeFrom === null) return deny('X-List-Envelope-From fehlt')
	const signature = headerValue(headers, HEADER_SIGNATURE)
	if (signature === null) return deny('X-List-Signature fehlt')

	const fields: ListRequestFields = {
		keyId,
		class: listClass,
		list,
		recipient,
		envelopeFrom,
		// Fehlt der Header, ist `null` signiert worden — nicht der leere String.
		messageId: headerValue(headers, HEADER_MESSAGE_ID),
		timestamp,
		bodyHash,
	}

	let valid = false
	try {
		valid = verifyEd25519(
			null,
			Buffer.from(buildSigningInput(fields), 'utf8'),
			createPublicKey(publicKeyPem),
			Buffer.from(signature, 'base64'),
		)
	} catch {
		// Kaputtes PEM oder keine Base64-Signatur. Beides ist "nicht geprüft" und
		// damit "nicht akzeptiert" — nie ein Durchfallen ins Gültige.
		return deny('Signatur nicht pruefbar')
	}
	if (!valid) return deny('Signatur ist ungueltig')

	return { ok: true, fields }
}
