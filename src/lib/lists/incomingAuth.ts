import { klassenConfig } from '../../klasse/config.js'
import { instanceName } from '../db/instance.js'
import {
	HEADER_CLASS,
	HEADER_ENVELOPE_FROM,
	HEADER_KEY_ID,
	HEADER_LIST_NAME,
	HEADER_MESSAGE_ID,
	HEADER_RECIPIENT,
	HEADER_SIGNATURE,
	HEADER_TIMESTAMP,
	verifyListSignature,
} from './signature.js'
import { verifyListRequest } from './signatureEd25519.js'

/**
 * Wer darf `/api/lists/incoming` aufrufen? — die eine Stelle, die das
 * entscheidet.
 *
 * Während der Umstellung liefern ZWEI Worker-Generationen gleichzeitig ein:
 *
 *  - die alten Worker je Klasse, getriggert über literale
 *    Email-Routing-Regeln, mit HMAC-SHA256 und einem geteilten Secret je
 *    Klasse (`signature.ts`);
 *  - der neue zonenweite Dispatcher am Catch-all, mit Ed25519 und
 *    mitsignierten Metadaten (`signatureEd25519.ts`).
 *
 * Solange eine Liste noch eine literale Regel hat, gewinnt sie gegen den
 * Catch-all — deshalb ist das kein Schalter, sondern ein Nebeneinander, das
 * klassen- und listenweise abgebaut wird. Erkannt wird das Verfahren an
 * `X-List-Key-Id`: vorhanden -> Ed25519, fehlt -> HMAC.
 *
 * BEIDE Pfade sind scharf. Eine fehlende Konfiguration lässt keinen Aufruf
 * durch, sondern lehnt ab: ohne `LIST_WEBHOOK_SECRET` scheitert der HMAC-Pfad,
 * ohne `listPublicKeyPem`/`listKeyIds` der Ed25519-Pfad. Der Fehler, den es hier
 * nicht geben darf, ist ein `if (secret)`, das die Prüfung überspringt, wenn
 * nichts konfiguriert ist — das wäre ein offenes Relay in die Elternschaft.
 *
 * Diese Funktion liegt in `lib/` und nicht im Route-Handler, damit die
 * Fallunterscheidung ohne Astro, Datenbank und Netz testbar ist
 * (`tests/lists/incomingAuth.test.ts`). Der Handler bleibt der dünne Teil.
 */

/**
 * Die Werte, mit denen der Route-Handler weiterarbeitet — und zwar
 * ausschließlich mit diesen. Nach der Prüfung wird kein `X-List-*`-Header mehr
 * gelesen; wer das täte, hätte die Prüfung umsonst gemacht.
 */
export type AuthenticatedListRequest = {
	/**
	 * Welches Verfahren gegriffen hat. Der Unterschied ist nicht kosmetisch:
	 *
	 *  - `ed25519`: Die Felder unten SIND signiert. Klasse, Liste und
	 *    Envelope-Absender sind so beglaubigt wie der Body.
	 *  - `hmac`: Die Signatur deckt nur Zeitpunkt und Body ab. Die Felder unten
	 *    stammen aus den Headern und sind lediglich von einer Gegenstelle
	 *    gekommen, die das Secret DIESER Klasse kennt. Genau deshalb gibt es v2.
	 */
	verfahren: 'ed25519' | 'hmac'
	/** Klassen-Label; ist gegen die eigene Klasse geprüft. */
	class: string
	/** Listen-Localpart, z.B. `eltern`. */
	list: string
	/** SMTP `MAIL FROM` — HIERAUF wird autorisiert, nie auf den `From:`-Header. */
	envelopeFrom: string
	/** `Message-ID:` der Mail, oder `null`. Schlüssel der Idempotenz. */
	messageId: string | null
	/**
	 * Vollständige Envelope-Empfängeradresse. `null` möglich, weil der alte
	 * Worker den Header als rein informativ führt und ihn weglassen darf.
	 */
	recipient: string | null
	/** Unix-Zeit in Sekunden, Dezimalstring. */
	timestamp: string
}

export type ListAuthResult =
	| { ok: true; request: AuthenticatedListRequest }
	| {
			ok: false
			status: 400 | 401 | 404
			reason: string
			/**
			 * `true`: Der Text geht dem Absender per SMTP-Unzustellbarkeitsnachricht
			 * zurück (der Worker liest `reason` aus dem JSON). Er muss verständlich
			 * sein und darf nichts Vertrauliches enthalten, insbesondere keine
			 * Empfängeradressen. `false`: Der Text ist für uns und wird als `error`
			 * ausgeliefert.
			 */
			anAbsender: boolean
	  }

export type ListAuthOptions = {
	headers: { get(name: string): string | null | undefined }
	/** Die rohen Body-Bytes, VOR jedem Parsen. */
	rawBody: Buffer
	/** Vorgabe: `instanceName()` — die Klasse, die dieses Deployment ist. */
	expectedClass?: string
	now?: Date
}

const headerValue = (
	headers: ListAuthOptions['headers'],
	name: string,
): string | null => {
	const value = headers.get(name)
	return typeof value === 'string' && value.length > 0 ? value : null
}

const fehlerhaft = (
	status: 400 | 401 | 404,
	reason: string,
	anAbsender = false,
): ListAuthResult => ({ ok: false, status, reason, anAbsender })

/**
 * Die Klasse gehört nicht zu dieser Instanz. Beide Pfade lehnen ab, aber mit
 * verschiedenem Status — jeder so, wie seine Gegenstelle es liest:
 *
 *  - alter Worker: `404` mit einem Text für den Absender, wie bisher;
 *  - Dispatcher: `401` (in `verifyListRequest`), weil er 401 als Störung
 *    behandelt und die Mail beim einliefernden Server lässt. Eine misgeroutete
 *    Mail ist ein Fehler in der Routing-Regel und keiner des Absenders.
 */
const fremdeKlasse = (className: string, expected: string): ListAuthResult => {
	console.error(
		`[lists/incoming] Mail fuer Klasse "${className}" bei Instanz "${expected}" abgewiesen - Routing-Regel pruefen`,
	)
	return fehlerhaft(404, 'Diese Adresse gehört nicht zu dieser Klasse.', true)
}

export const authenticateListRequest = ({
	headers,
	rawBody,
	expectedClass = instanceName(),
	now,
}: ListAuthOptions): ListAuthResult => {
	// Nur die Anwesenheit des Headers wählt den Pfad, nicht sein Inhalt: Eine
	// unbekannte Key-Id soll im Ed25519-Pfad mit "Unbekannte Key-Id" scheitern
	// und nicht in den HMAC-Pfad zurückfallen. Ein Rückfall wäre die Stelle, an
	// der sich eine Prüfung durch Weglassen wählen ließe.
	if (headerValue(headers, HEADER_KEY_ID) === null) {
		return authenticateHmac({ headers, rawBody, expectedClass, now })
	}

	const config = klassenConfig()
	const verified = verifyListRequest({
		headers,
		rawBody,
		publicKeyPem: config.listPublicKeyPem,
		expectedClass,
		keyIds: config.listKeyIds,
		now,
	})
	if (!verified.ok) {
		// Kein `reason` für den Absender: Eine ungültige Signatur ist ein
		// Konfigurations- oder Manipulationsfehler auf der Aufruferseite.
		return fehlerhaft(verified.status, verified.reason)
	}

	// Ab hier ausschließlich `verified.fields` — die Header werden nicht mehr
	// angefasst.
	return {
		ok: true,
		request: {
			verfahren: 'ed25519',
			class: verified.fields.class,
			list: verified.fields.list,
			envelopeFrom: verified.fields.envelopeFrom,
			messageId: verified.fields.messageId,
			recipient: verified.fields.recipient,
			timestamp: verified.fields.timestamp,
		},
	}
}

/**
 * Der bisherige Pfad, unverändert scharf: Secret aus der Umgebung, HMAC über
 * `${timestamp}.${rawBody}`, danach die Header lesen.
 *
 * Die Klasse wird hier ANDERS geprüft als früher: Sie ist jetzt Pflicht. Bisher
 * hieß es `if (className && className !== instanceName())` — ein fehlender
 * Header hat die Prüfung also übersprungen. Der Worker schickt ihn immer, und
 * der einzige Fall, in dem er fehlt, ist der, in dem niemand mehr sagen kann,
 * für welche Klasse die Mail war. Das ist kein Fall zum Durchlassen.
 */
const authenticateHmac = ({
	headers,
	rawBody,
	expectedClass,
	now,
}: Required<Pick<ListAuthOptions, 'headers' | 'rawBody' | 'expectedClass'>> & {
	now?: Date
}): ListAuthResult => {
	// Die beiden Header vorab, damit `timestamp` unten als `string` weiterlebt:
	// `verifyListSignature` lehnt sie fehlend ebenfalls mit 401 ab, aber davon
	// weiß der Compiler nichts.
	const timestamp = headerValue(headers, HEADER_TIMESTAMP)
	const signature = headerValue(headers, HEADER_SIGNATURE)
	if (timestamp === null || signature === null) {
		return fehlerhaft(401, 'Signatur-Header fehlen')
	}

	const sig = verifyListSignature({
		secret: process.env.LIST_WEBHOOK_SECRET,
		timestamp,
		signature,
		rawBody,
		nowSeconds: now ? Math.floor(now.getTime() / 1000) : undefined,
	})
	if (!sig.ok) {
		// 401 gilt beim Worker als Störung auf UNSERER Seite, nicht als
		// Absenderfehler: Er wirft, und der einliefernde Server stellt später
		// erneut zu. Deshalb hier auch kein `reason` für den Absender.
		return fehlerhaft(401, sig.reason)
	}

	const className = headerValue(headers, HEADER_CLASS)
	if (className === null) {
		return fehlerhaft(400, `Header ${HEADER_CLASS} fehlt`)
	}
	if (className !== expectedClass) return fremdeKlasse(className, expectedClass)

	const list = headerValue(headers, HEADER_LIST_NAME)
	if (list === null) return fehlerhaft(400, `Header ${HEADER_LIST_NAME} fehlt`)
	const envelopeFrom = headerValue(headers, HEADER_ENVELOPE_FROM)
	if (envelopeFrom === null) {
		return fehlerhaft(400, `Header ${HEADER_ENVELOPE_FROM} fehlt`)
	}

	return {
		ok: true,
		request: {
			verfahren: 'hmac',
			class: className,
			list,
			envelopeFrom,
			messageId: headerValue(headers, HEADER_MESSAGE_ID),
			recipient: headerValue(headers, HEADER_RECIPIENT),
			timestamp,
		},
	}
}
