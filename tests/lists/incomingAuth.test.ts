import {
	createHash,
	generateKeyPairSync,
	sign as signEd25519,
} from 'node:crypto'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { setKlassenConfig } from '../../src/klasse/config.ts'
import { instanceName } from '../../src/lib/db/instance.ts'
import { authenticateListRequest } from '../../src/lib/lists/incomingAuth.ts'
import {
	buildSigningInput,
	type ListRequestFields,
	listKeyIdFromPem,
} from '../../src/lib/lists/signatureEd25519.ts'
import { TESTKLASSE } from '../setup.ts'

/**
 * Der Eingang für Listenmails: Ed25519 gegen den öffentlichen Schlüssel der
 * Klasse, und nichts sonst. Einliefern darf damit nur der zonenweite
 * Dispatcher, denn nur er hat den privaten Schlüssel.
 *
 * Bis vor kurzem gab es hier einen zweiten Pfad (HMAC mit einem Secret je
 * Klasse, für die alten Worker). Er ist mit den Workern entfallen. Was dieser
 * Test vor allem ausschließt: dass ein Aufruf durch Weglassen eines Headers oder
 * durch eine fehlende Konfiguration an der Prüfung vorbeikommt.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PEM = publicKey.export({ format: 'pem', type: 'spki' }).toString()
const KEY_ID = listKeyIdFromPem(PEM)

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
})

afterEach(() => {
	setKlassenConfig(TESTKLASSE)
	vi.restoreAllMocks()
})

describe('authenticateListRequest, Ed25519-Pfad', () => {
	test('nimmt einen gueltigen Dispatcher-Aufruf an und gibt die signierten Werte zurueck', () => {
		const ergebnis = auth(v2Header())
		expect(ergebnis.ok).toBe(true)
		if (!ergebnis.ok) return
		expect(ergebnis.request).toEqual({
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

	test('lehnt eine unbekannte Key-Id ab', () => {
		// Der Schluesselwechsel laeuft ueber `listKeyIds`. Eine Id, die dort nicht
		// steht, ist kein Grund zum Durchlassen — auch dann nicht, wenn die
		// Signatur zu irgendeinem anderen Schluessel passt.
		const headers = v2Header(feldsatz(), {
			'x-list-key-id': '0123456789abcdef',
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
