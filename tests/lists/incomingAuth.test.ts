import {
	createHash,
	generateKeyPairSync,
	sign as signEd25519,
} from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { setKlassenConfig } from '../../src/klasse/config.js'
import { instanceName } from '../../src/lib/db/instance.js'
import { authenticateListRequest } from '../../src/lib/lists/incomingAuth.js'
import { computeSignature } from '../../src/lib/lists/signature.js'
import {
	buildSigningInput,
	type ListRequestFields,
	listKeyIdFromPem,
} from '../../src/lib/lists/signatureEd25519.js'
import { TESTKLASSE } from '../setup.js'

/**
 * Die Fallunterscheidung am Eingang: `X-List-Key-Id` vorhanden -> Ed25519 (neuer
 * zonenweiter Dispatcher), Header fehlt -> HMAC (alte Worker je Klasse).
 *
 * Während der Umstellung liefern beide gleichzeitig ein, deshalb muss BEIDES
 * scharf sein. Was dieser Test vor allem ausschließt: dass ein Aufruf durch
 * Weglassen oder durch eine fehlende Konfiguration an einer Prüfung vorbeikommt.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PEM = publicKey.export({ format: 'pem', type: 'spki' }).toString()
const KEY_ID = listKeyIdFromPem(PEM)

const SECRET = 'test-secret'
const BODY = Buffer.from('From: vera@example.org\r\n\r\nHallo', 'utf-8')
const NOW = new Date(1_800_000_000_000)
const TS = `${Math.floor(NOW.getTime() / 1000)}`

const feldsatz = (
	abweichung: Partial<ListRequestFields> = {},
): ListRequestFields => ({
	keyId: KEY_ID,
	class: instanceName(),
	list: 'eltern',
	recipient: `eltern@${instanceName()}.lists.fws-maschsee-test.de`,
	envelopeFrom: 'vera@example.org',
	messageId: '<abc@example.org>',
	timestamp: TS,
	bodyHash: createHash('sha256').update(BODY).digest('hex'),
	...abweichung,
})

/** Header eines Dispatcher-Aufrufs (v2, Ed25519). */
const v2Header = (
	fields: ListRequestFields = feldsatz(),
	manipulation: Record<string, string> = {},
): Headers => {
	const headers = new Headers({
		'x-list-key-id': fields.keyId,
		'x-list-class': fields.class,
		'x-list-name': fields.list,
		'x-list-recipient': fields.recipient,
		'x-list-envelope-from': fields.envelopeFrom,
		'x-list-timestamp': fields.timestamp,
		'x-list-signature': signEd25519(
			null,
			Buffer.from(buildSigningInput(fields), 'utf8'),
			privateKey,
		).toString('base64'),
		...(fields.messageId ? { 'x-list-message-id': fields.messageId } : {}),
	})
	for (const [name, wert] of Object.entries(manipulation)) {
		headers.set(name, wert)
	}
	return headers
}

/** Header eines alten Worker-Aufrufs (v1, HMAC) — ohne `X-List-Key-Id`. */
const v1Header = (
	manipulation: Record<string, string | null> = {},
): Headers => {
	const headers = new Headers({
		'x-list-class': instanceName(),
		'x-list-name': 'eltern',
		'x-list-envelope-from': 'vera@example.org',
		'x-list-message-id': '<abc@example.org>',
		'x-list-timestamp': TS,
		'x-list-signature': computeSignature(SECRET, TS, BODY),
	})
	for (const [name, wert] of Object.entries(manipulation)) {
		if (wert === null) headers.delete(name)
		else headers.set(name, wert)
	}
	return headers
}

const auth = (headers: Headers, rawBody: Buffer = BODY) =>
	authenticateListRequest({ headers, rawBody, now: NOW })

beforeEach(() => {
	// Testschluesselpaar statt der eingecheckten Vorgabe: Den Privatschluessel
	// zur Vorgabe hat nur der Dispatcher, also kann die Suite mit ihr nichts
	// signieren.
	setKlassenConfig({
		...TESTKLASSE,
		listPublicKeyPem: PEM,
		listKeyIds: [KEY_ID],
	})
	process.env.LIST_WEBHOOK_SECRET = SECRET
})

afterEach(() => {
	setKlassenConfig(TESTKLASSE)
	delete process.env.LIST_WEBHOOK_SECRET
	vi.restoreAllMocks()
})

describe('authenticateListRequest, Ed25519-Pfad', () => {
	test('nimmt einen gueltigen Dispatcher-Aufruf an und gibt die signierten Werte zurueck', () => {
		const ergebnis = auth(v2Header())
		expect(ergebnis.ok).toBe(true)
		if (!ergebnis.ok) return
		expect(ergebnis.request).toEqual({
			verfahren: 'ed25519',
			class: instanceName(),
			list: 'eltern',
			envelopeFrom: 'vera@example.org',
			messageId: '<abc@example.org>',
			recipient: `eltern@${instanceName()}.lists.fws-maschsee-test.de`,
			timestamp: TS,
		})
	})

	test('prueft gegen die eigene Klasse, ohne dass sie uebergeben wird', () => {
		// Vorgabe ist `instanceName()`. Ein Aufruf fuer die Nachbarklasse faellt
		// damit auch dann durch, wenn der Route-Handler nichts dazu sagt.
		const fremd = feldsatz({ class: 'klasse-nachbar' })
		expect(auth(v2Header(fremd))).toMatchObject({ ok: false, status: 401 })
	})

	test('faellt bei unbekannter Key-Id NICHT auf HMAC zurueck', () => {
		// Der Kern der Fallunterscheidung: Waehlt der Aufrufer mit einem Header das
		// Verfahren, darf ein ungueltiger Wert nicht ins andere Verfahren
		// zurueckfallen. Hier ist die HMAC-Signatur sogar korrekt — trotzdem 401.
		const headers = v2Header(feldsatz(), {
			'x-list-key-id': '0123456789abcdef',
			'x-list-signature': computeSignature(SECRET, TS, BODY),
		})
		expect(auth(headers)).toMatchObject({
			ok: false,
			status: 401,
			reason: expect.stringMatching(/Key-Id/),
			anAbsender: false,
		})
	})

	test('lehnt ab, wenn die Schluesselkonfiguration fehlt, statt durchzulassen', () => {
		setKlassenConfig({ ...TESTKLASSE, listPublicKeyPem: PEM, listKeyIds: [] })
		expect(auth(v2Header())).toMatchObject({
			ok: false,
			status: 401,
			reason: expect.stringMatching(/listKeyIds/),
		})
	})

	test('lehnt einen veraenderten Body ab', () => {
		expect(auth(v2Header(), Buffer.from('etwas anderes'))).toMatchObject({
			ok: false,
			status: 401,
		})
	})
})

describe('authenticateListRequest, HMAC-Pfad', () => {
	test('nimmt einen gueltigen Aufruf des alten Workers an', () => {
		const ergebnis = auth(v1Header())
		expect(ergebnis.ok).toBe(true)
		if (!ergebnis.ok) return
		expect(ergebnis.request).toEqual({
			verfahren: 'hmac',
			class: instanceName(),
			list: 'eltern',
			envelopeFrom: 'vera@example.org',
			messageId: '<abc@example.org>',
			// Der alte Worker fuehrt den Empfaenger als rein informativ und darf
			// ihn weglassen.
			recipient: null,
			timestamp: TS,
		})
	})

	test('lehnt ab, wenn kein Secret konfiguriert ist', () => {
		delete process.env.LIST_WEBHOOK_SECRET
		expect(auth(v1Header())).toMatchObject({
			ok: false,
			status: 401,
			reason: expect.stringMatching(/LIST_WEBHOOK_SECRET/),
		})
	})

	test('lehnt eine falsche Signatur und einen veraenderten Body ab', () => {
		expect(
			auth(v1Header({ 'x-list-signature': 'ab'.repeat(32) })),
		).toMatchObject({ ok: false, status: 401 })
		expect(auth(v1Header(), Buffer.from('etwas anderes'))).toMatchObject({
			ok: false,
			status: 401,
		})
	})

	test('lehnt fehlende Signatur-Header ab', () => {
		for (const name of ['x-list-timestamp', 'x-list-signature']) {
			expect(auth(v1Header({ [name]: null })), name).toMatchObject({
				ok: false,
				status: 401,
			})
		}
	})

	test('weist eine fremde Klasse mit 404 und einem Text fuer den Absender ab', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {})
		expect(auth(v1Header({ 'x-list-class': 'klasse-nachbar' }))).toMatchObject({
			ok: false,
			status: 404,
			anAbsender: true,
		})
		expect(console.error).toHaveBeenCalled()
	})

	test('verlangt die Klasse, statt die Pruefung ohne sie zu ueberspringen', () => {
		expect(auth(v1Header({ 'x-list-class': null }))).toMatchObject({
			ok: false,
			status: 400,
			reason: expect.stringMatching(/x-list-class/),
		})
	})

	test('verlangt Listenname und Envelope-Absender', () => {
		for (const name of ['x-list-name', 'x-list-envelope-from']) {
			expect(auth(v1Header({ [name]: null })), name).toMatchObject({
				ok: false,
				status: 400,
				reason: expect.stringMatching(new RegExp(name)),
			})
		}
	})
})
