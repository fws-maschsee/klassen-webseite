import {
	createHash,
	createPublicKey,
	verify as verifyEd25519,
} from 'node:crypto'

export const HEADER_CLASS = 'x-list-class'
export const HEADER_LIST_NAME = 'x-list-name'
export const HEADER_RECIPIENT = 'x-list-recipient'
export const HEADER_ENVELOPE_FROM = 'x-list-envelope-from'
export const HEADER_MESSAGE_ID = 'x-list-message-id'
export const HEADER_TIMESTAMP = 'x-list-timestamp'
export const HEADER_SIGNATURE = 'x-list-signature'

export const HEADER_KEY_ID = 'x-list-key-id'

export const SIGNING_VERSION = 'fwslist.v2'

// Muss zum Dispatcher passen.
export const TIMESTAMP_TOLERANCE_SECONDS = 300

export type ListRequestFields = {
	keyId: string
	class: string
	list: string
	recipient: string
	envelopeFrom: string
	messageId: string | null
	timestamp: string
	bodyHash: string
}

export type VerifyListRequestResult =
	| {
			ok: true
			fields: ListRequestFields
	  }
	| {
			ok: false
			status: 401
			reason: string
	  }

export type VerifyListRequestOptions = {
	headers: { get(name: string): string | null | undefined }
	rawBody: Uint8Array
	publicKeyPem: string
	expectedClass: string
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

// Muss zeichengenau zu `buildSigningInput` im Repo lists-dispatcher passen; beide Golden-String-Tests mitziehen.
export const buildSigningInput = (fields: ListRequestFields): string =>
	[
		SIGNING_VERSION,
		fields.keyId,
		fields.class,
		fields.list,
		fields.recipient,
		fields.envelopeFrom,
		// Leere Zeile statt weglassen, sonst bildeten zwei Feldbelegungen dieselbe Zeichenkette.
		fields.messageId ?? '',
		fields.timestamp,
		fields.bodyHash,
	].join('\n')

export const listKeyIdFromPem = (publicKeyPem: string): string => {
	let x: string | undefined
	try {
		// Rohschlüssel über JWK statt DER-Offset, ohne Annahme über die Länge des SPKI-Präfixes; wie `generate-keypair.mjs` im Dispatcher.
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

	// Selbst berechnet statt aus einem Header: nur so deckt die Signatur die tatsächlich gelesenen Bytes.
	// Kein timing-safe Vergleich nötig, der Hash öffentlicher Daten ist kein Geheimnis.
	const bodyHash = createHash('sha256').update(rawBody).digest('hex')

	const listClass = headerValue(headers, HEADER_CLASS)
	// Alle Klassen prüfen mit demselben öffentlichen Schlüssel; nur dieser Vergleich trennt Post der Nachbarklasse ab.
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
		return deny('Signatur nicht pruefbar')
	}
	if (!valid) return deny('Signatur ist ungueltig')

	return { ok: true, fields }
}
