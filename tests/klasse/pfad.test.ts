import { describe, expect, test } from 'vitest'
import { createKlassenMiddleware } from '../../src/klasse/middleware.ts'
import {
	brauchtKeineAnmeldung,
	normalisierterPfad,
} from '../../src/klasse/pfad.ts'
import { TESTKLASSE } from '../setup.ts'

describe('normalisierterPfad', () => {
	test.each([
		['/public/kalender.ics', '/public/kalender.ics'],
		['/public/Klasse%20Wiesen.ics', '/public/Klasse Wiesen.ics'],
		['//dokumente/x.pdf', '/dokumente/x.pdf'],
		['/./dokumente/x.pdf', '/dokumente/x.pdf'],
	])('%s wird zu %s', (roh, erwartet) => {
		expect(normalisierterPfad(roh)).toBe(erwartet)
	})

	test.each([
		'/public/..%2fdokumente/x.pdf',
		'/public/..%2Fdokumente/x.pdf',
		'/public/..%5cdokumente/x.pdf',
		'/public/..%5Cdokumente/x.pdf',
		'/public/..\\dokumente/x.pdf',
		'/public/%2e%2e/dokumente/x.pdf',
		'/public/../dokumente/x.pdf',
		'/public/..%252fdokumente/x.pdf',
		'/public/%252e%252e/dokumente/x.pdf',
		'/auth/..%2fdokumente/x.pdf',
		'/api/lists/%2e%2e/%2e%2e/adressbuch',
		'/public/%00.pdf',
		'/public/%E0%A4%A',
	])('%s wird abgewiesen', (roh) => {
		expect(normalisierterPfad(roh)).toBeNull()
	})
})

describe('brauchtKeineAnmeldung', () => {
	test.each([
		['/public/kalender.ics', true],
		['/api/lists/abc', true],
		['/auth/login', true],
		['/dokumente/x.pdf', false],
		['/publicx/y', false],
	])('%s → %s', (pfad, erwartet) => {
		expect(brauchtKeineAnmeldung(pfad)).toBe(erwartet)
	})
})

describe('die Astro-Middleware', () => {
	test.each([
		'/public/..%2fadressbuch',
		'/api/lists/..%2f..%2fadressbuch',
		'/auth/..%5cadressbuch',
	])('%s kommt nicht an der Anmeldung vorbei', async (pfad) => {
		const middleware = createKlassenMiddleware(TESTKLASSE)
		let durchgelassen = false

		const antwort = (await middleware(
			{
				request: new Request(`https://klasse-beispiel.example.org${pfad}`),
				locals: {},
				// biome-ignore lint/suspicious/noExplicitAny: Attrappe eines APIContext
			} as any,
			async () => {
				durchgelassen = true
				return new Response('geschützt')
			},
		)) as Response

		expect(durchgelassen).toBe(false)
		expect(antwort.status).toBe(400)
	})
})
