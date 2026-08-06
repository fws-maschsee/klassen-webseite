import {
	createHash,
	generateKeyPairSync,
	sign as signEd25519,
} from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
	buildSigningInput,
	type ListRequestFields,
	listKeyIdFromPem,
	SIGNING_VERSION,
	TIMESTAMP_TOLERANCE_SECONDS,
	verifyListRequest,
} from '../../src/lib/lists/signatureEd25519.js'
import { TESTKLASSE } from '../setup.js'

/**
 * Die Prüfung der Aufrufe des zonenweiten Dispatchers.
 *
 * Das Schlüsselpaar erzeugt diese Suite selbst — kein Netz, kein eingecheckter
 * Privatschlüssel, aber echte Kryptografie: Signiert wird mit `node:crypto`
 * über genau die Zeichenkette, die `buildSigningInput` liefert. Damit prüft der
 * Test das Verfahren und nicht eine Attrappe.
 *
 * Alle Namen und Adressen sind frei erfunden.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PEM = publicKey.export({ format: 'pem', type: 'spki' }).toString()
const KEY_ID = listKeyIdFromPem(PEM)

const KLASSE = 'klasse-beispiel'
const BODY = Buffer.from('From: vera@example.org\r\n\r\nHallo', 'utf-8')
const NOW = new Date(1_800_000_000_000)
const TS = `${Math.floor(NOW.getTime() / 1000)}`

/** SHA-256 der Body-Bytes, hex — dasselbe, was die Prüfung selbst berechnet. */
const bodyHashOf = (body: Buffer): string =>
	createHash('sha256').update(body).digest('hex')

const feldsatz = (
	abweichung: Partial<ListRequestFields> = {},
): ListRequestFields => ({
	keyId: KEY_ID,
	class: KLASSE,
	list: 'eltern',
	recipient: `eltern@${KLASSE}.lists.fws-maschsee-test.de`,
	envelopeFrom: 'vera@example.org',
	messageId: '<abc@example.org>',
	timestamp: TS,
	bodyHash: bodyHashOf(BODY),
	...abweichung,
})

const signaturFuer = (fields: ListRequestFields): string =>
	signEd25519(
		null,
		Buffer.from(buildSigningInput(fields), 'utf8'),
		privateKey,
	).toString('base64')

/**
 * Baut die Header so, wie der Dispatcher sie schickt: aus DEMSELBEN Feldsatz,
 * über den signiert wurde. Ein Test, der etwas manipulieren will, überschreibt
 * einzelne Header — genau das tut ein Angreifer auch.
 */
const headerFuer = (
	fields: ListRequestFields,
	manipulation: Record<string, string> = {},
): Headers => {
	const headers = new Headers({
		'x-list-key-id': fields.keyId,
		'x-list-class': fields.class,
		'x-list-name': fields.list,
		'x-list-recipient': fields.recipient,
		'x-list-envelope-from': fields.envelopeFrom,
		'x-list-timestamp': fields.timestamp,
		'x-list-signature': signaturFuer(fields),
		...(fields.messageId ? { 'x-list-message-id': fields.messageId } : {}),
	})
	for (const [name, wert] of Object.entries(manipulation)) {
		headers.set(name, wert)
	}
	return headers
}

const pruefe = (
	headers: Headers,
	options: { rawBody?: Buffer; pem?: string; keyIds?: readonly string[] } = {},
) =>
	verifyListRequest({
		headers,
		rawBody: options.rawBody ?? BODY,
		publicKeyPem: options.pem ?? PEM,
		expectedClass: KLASSE,
		keyIds: options.keyIds ?? [KEY_ID],
		now: NOW,
	})

describe('buildSigningInput', () => {
	/**
	 * GOLDEN STRING. Das Gegenstück steht im Dispatcher-Repo
	 * (`lists-dispatcher`, `test/reference.test.ts` gegen `src/signature.ts`) und
	 * ist dieselbe Zeichenkette, Byte für Byte — es ist das Beispiel aus dessen
	 * README. Läuft das Format auf einer Seite weg, wird hier oder dort ein Test
	 * rot und nicht der Betrieb: Eine einseitige Änderung würde sonst dazu
	 * führen, dass gar keine Elternpost mehr durchkommt.
	 */
	test('erzeugt genau die Zeichenkette aus dem Vertrag', () => {
		expect(
			buildSigningInput({
				keyId: 'a1b2c3d4e5f60718',
				class: 'klasse-wiesen',
				list: 'eltern',
				recipient: 'eltern@klasse-wiesen.lists.fws-maschsee-test.de',
				envelopeFrom: 'mutter@example.org',
				messageId: '<abc@example.org>',
				timestamp: '1780000000',
				bodyHash:
					'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
			}),
		).toBe(
			[
				'fwslist.v2',
				'a1b2c3d4e5f60718',
				'klasse-wiesen',
				'eltern',
				'eltern@klasse-wiesen.lists.fws-maschsee-test.de',
				'mutter@example.org',
				'<abc@example.org>',
				'1780000000',
				'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
			].join('\n'),
		)
	})

	test('laesst die Zeile der Message-ID leer stehen, wenn es keine gibt', () => {
		// Ohne die leere Zeile waeren zwei verschiedene Feldbelegungen auf
		// dieselbe Zeichenkette abbildbar.
		const zeilen = buildSigningInput(feldsatz({ messageId: null })).split('\n')
		expect(zeilen).toHaveLength(9)
		expect(zeilen[0]).toBe(SIGNING_VERSION)
		expect(zeilen[6]).toBe('')
	})
})

describe('listKeyIdFromPem', () => {
	/**
	 * Die Vorgabe des Packages, nachgerechnet. Schlägt dieser Test an, sind
	 * `listPublicKeyPem` und `listKeyIds` in `SCHUL_VORGABEN` auseinandergelaufen
	 * — und keine Klasse könnte mehr Listenmail annehmen.
	 */
	test('leitet aus der Vorgabe-PEM genau die Vorgabe-Key-Id ab', () => {
		expect(listKeyIdFromPem(TESTKLASSE.listPublicKeyPem)).toBe(
			'bf2226d575ece8c8',
		)
		expect([...TESTKLASSE.listKeyIds]).toEqual(['bf2226d575ece8c8'])
	})

	test('ist 16 Hex-Zeichen lang und aus dem Schluessel abgeleitet', () => {
		expect(KEY_ID).toMatch(/^[0-9a-f]{16}$/)
		// Ein zweites Paar ergibt eine andere Id — sonst waere die Id kein
		// Unterscheidungsmerkmal.
		const anderes = generateKeyPairSync('ed25519')
			.publicKey.export({ format: 'pem', type: 'spki' })
			.toString()
		expect(listKeyIdFromPem(anderes)).not.toBe(KEY_ID)
	})

	test('wirft bei allem, was kein Ed25519-SPKI-PEM ist', () => {
		expect(() => listKeyIdFromPem('kein PEM')).toThrow(/listPublicKeyPem/)
		expect(() => listKeyIdFromPem('')).toThrow(/listPublicKeyPem/)
		const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
			.publicKey.export({ format: 'pem', type: 'spki' })
			.toString()
		expect(() => listKeyIdFromPem(rsa)).toThrow(/Ed25519/)
	})
})

describe('verifyListRequest', () => {
	test('akzeptiert eine gueltige v2-Signatur und gibt die signierten Felder zurueck', () => {
		const fields = feldsatz()
		const ergebnis = pruefe(headerFuer(fields))
		expect(ergebnis.ok).toBe(true)
		if (!ergebnis.ok) return
		// Der Body-Hash ist SELBST berechnet und kommt aus keinem Header.
		expect(ergebnis.fields).toEqual(fields)
	})

	test('akzeptiert eine Mail ohne Message-ID', () => {
		const ergebnis = pruefe(headerFuer(feldsatz({ messageId: null })))
		expect(ergebnis.ok).toBe(true)
		if (!ergebnis.ok) return
		expect(ergebnis.fields.messageId).toBeNull()
	})

	test('lehnt einen Aufruf ab, dessen Klasse geaendert wurde', () => {
		// Der Datenschutzfall: ein gueltig signierter Aufruf fuer die
		// Nachbarklasse, mit auf uns umgeschriebenem X-List-Class. Alle Klassen
		// pruefen mit DEMSELBEN oeffentlichen Schluessel — nur die mitsignierte
		// Klasse unterscheidet die eigene Post von der fremden.
		const fremd = feldsatz({ class: 'klasse-nachbar' })
		expect(pruefe(headerFuer(fremd, { 'x-list-class': KLASSE }))).toMatchObject(
			{ ok: false, status: 401, reason: expect.stringMatching(/ungueltig/) },
		)
	})

	test('lehnt einen Aufruf fuer eine andere Klasse ab, bevor er geprueft wird', () => {
		const fremd = feldsatz({ class: 'klasse-nachbar' })
		expect(pruefe(headerFuer(fremd))).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/andere.? Klasse/),
		})
	})

	test('lehnt einen veraenderten Body ab', () => {
		expect(
			pruefe(headerFuer(feldsatz()), {
				rawBody: Buffer.from('etwas ganz anderes'),
			}),
		).toMatchObject({ ok: false, status: 401 })
	})

	test('lehnt eine unbekannte Key-Id ab', () => {
		expect(
			pruefe(headerFuer(feldsatz()), { keyIds: ['0123456789abcdef'] }),
		).toMatchObject({ ok: false, reason: expect.stringMatching(/Key-Id/) })
	})

	test('lehnt einen abgelaufenen Zeitstempel ab', () => {
		const alt = `${Number(TS) - TIMESTAMP_TOLERANCE_SECONDS - 1}`
		expect(pruefe(headerFuer(feldsatz({ timestamp: alt })))).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/Zeitfenster/),
		})
	})

	test('lehnt einen Zeitstempel aus der Zukunft ab', () => {
		const spaeter = `${Number(TS) + TIMESTAMP_TOLERANCE_SECONDS + 1}`
		expect(pruefe(headerFuer(feldsatz({ timestamp: spaeter })))).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/Zeitfenster/),
		})
	})

	test('vertraegt eine kaputte Signatur ohne zu werfen', () => {
		for (const kaputt of ['', 'nicht base64 !!', 'AAAA', 'x'.repeat(88)]) {
			expect(
				pruefe(headerFuer(feldsatz(), { 'x-list-signature': kaputt })),
			).toMatchObject({ ok: false, status: 401 })
		}
	})

	test('lehnt die Signatur eines fremden Schluessels ab', () => {
		const fremd = generateKeyPairSync('ed25519')
		const fields = feldsatz()
		const headers = headerFuer(fields, {
			'x-list-signature': signEd25519(
				null,
				Buffer.from(buildSigningInput(fields), 'utf8'),
				fremd.privateKey,
			).toString('base64'),
		})
		expect(pruefe(headers)).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/ungueltig/),
		})
	})

	test('lehnt jeden fehlenden Header ab', () => {
		const pflicht = [
			'x-list-key-id',
			'x-list-class',
			'x-list-name',
			'x-list-recipient',
			'x-list-envelope-from',
			'x-list-timestamp',
			'x-list-signature',
		]
		for (const name of pflicht) {
			const headers = headerFuer(feldsatz())
			headers.delete(name)
			expect(pruefe(headers), name).toMatchObject({ ok: false, status: 401 })
		}
		expect(pruefe(new Headers())).toMatchObject({ ok: false, status: 401 })
	})

	test('lehnt ab, wenn die Konfiguration fehlt, statt durchzulassen', () => {
		// Der eine Fehler, den es hier nicht geben darf: kein Schluessel
		// konfiguriert und deshalb keine Pruefung.
		expect(pruefe(headerFuer(feldsatz()), { keyIds: [] })).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/listKeyIds/),
		})
		expect(pruefe(headerFuer(feldsatz()), { pem: '  ' })).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/listPublicKeyPem/),
		})
		expect(pruefe(headerFuer(feldsatz()), { pem: 'kein PEM' })).toMatchObject({
			ok: false,
			reason: expect.stringMatching(/pruefbar/),
		})
	})
})
