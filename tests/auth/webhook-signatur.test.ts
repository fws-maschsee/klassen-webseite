import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { verifyWebhookSignature } from '../../src/server/auth/revocation.ts'
import { handleZitadelWebhook } from '../../src/server/auth/webhook.ts'

const KEY = 'geheimer-signierschluessel'

const signiere = (body: string, t: number, key = KEY): string =>
	`t=${t},v1=${createHmac('sha256', key).update(`${t}.${body}`).digest('hex')}`

describe('ZITADEL-Signature', () => {
	const body = Buffer.from('{"event_type":"user.locked","aggregateID":"u1"}')
	const jetzt = 1_790_000_000

	test('eine gueltige Signatur wird angenommen', () => {
		expect(
			verifyWebhookSignature(
				body,
				signiere(body.toString(), jetzt),
				KEY,
				jetzt,
			),
		).toEqual({ ok: true })
	})

	test('mehrere v1-Signaturen: eine passende genuegt', () => {
		const header = `${signiere(body.toString(), jetzt, 'alt')},v1=${signiere(body.toString(), jetzt).split('v1=')[1]}`
		expect(verifyWebhookSignature(body, header, KEY, jetzt).ok).toBe(true)
	})

	test('ein falscher Schluessel wird abgelehnt', () => {
		expect(
			verifyWebhookSignature(
				body,
				signiere(body.toString(), jetzt, 'anders'),
				KEY,
				jetzt,
			),
		).toEqual({ ok: false, reason: 'mismatch' })
	})

	test('ein veraenderter Rumpf wird abgelehnt', () => {
		const header = signiere(body.toString(), jetzt)
		expect(
			verifyWebhookSignature(
				Buffer.from('{"event_type":"user.locked","aggregateID":"u2"}'),
				header,
				KEY,
				jetzt,
			).ok,
		).toBe(false)
	})

	test('aelter als fuenf Minuten ist abgelaufen', () => {
		expect(
			verifyWebhookSignature(
				body,
				signiere(body.toString(), jetzt - 301),
				KEY,
				jetzt,
			),
		).toEqual({ ok: false, reason: 'expired' })
		expect(
			verifyWebhookSignature(
				body,
				signiere(body.toString(), jetzt - 299),
				KEY,
				jetzt,
			).ok,
		).toBe(true)
	})

	test('fehlender oder kaputter Kopf', () => {
		expect(verifyWebhookSignature(body, null, KEY, jetzt)).toEqual({
			ok: false,
			reason: 'missing',
		})
		expect(verifyWebhookSignature(body, 't=abc,v1=00', KEY, jetzt)).toEqual({
			ok: false,
			reason: 'malformed',
		})
		expect(verifyWebhookSignature(body, `t=${jetzt}`, KEY, jetzt)).toEqual({
			ok: false,
			reason: 'malformed',
		})
	})
})

describe('POST /auth/zitadel-events', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	const anfrage = (body: string, header?: string) =>
		new Request('http://localhost/auth/zitadel-events', {
			method: 'POST',
			headers: header ? { 'ZITADEL-Signature': header } : {},
			body,
		})

	test('ohne Schluessel gibt es die Route nicht', async () => {
		vi.stubEnv('ZITADEL_WEBHOOK_SIGNING_KEY', '')
		const antwort = await handleZitadelWebhook(anfrage('{}'))
		expect(antwort.status).toBe(404)
	})

	test('ohne gueltige Signatur 401', async () => {
		vi.stubEnv('ZITADEL_WEBHOOK_SIGNING_KEY', KEY)
		vi.spyOn(console, 'warn').mockImplementation(() => {})
		const antwort = await handleZitadelWebhook(
			anfrage('{}', signiere('{"x":1}', Math.floor(Date.now() / 1000))),
		)
		expect(antwort.status).toBe(401)
	})

	test('unbekannte Ereignisse: 200, nichts passiert', async () => {
		vi.stubEnv('ZITADEL_WEBHOOK_SIGNING_KEY', KEY)
		const body = JSON.stringify({ event_type: 'org.added', aggregateID: 'o1' })
		const antwort = await handleZitadelWebhook(
			anfrage(body, signiere(body, Math.floor(Date.now() / 1000))),
		)
		expect(antwort.status).toBe(200)
		expect(await antwort.json()).toEqual({
			action: 'ignored',
			eventType: 'org.added',
		})
	})
})
