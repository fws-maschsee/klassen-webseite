import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
	pruefeDkimFuerDomain,
	type ResolveTxt,
} from '../../src/lib/lists/dkim.ts'

const fixture = (name: string): Buffer =>
	readFileSync(new URL(`../fixtures/dkim/${name}`, import.meta.url))

const dns: Record<string, string> = JSON.parse(
	fixture('dns.json').toString('utf-8'),
)

const resolveTxt: ResolveTxt = async (name) => {
	const eintrag = dns[name]
	if (!eintrag) throw Object.assign(new Error(name), { code: 'ENOTFOUND' })
	return [[eintrag.slice(0, 100), eintrag.slice(100)]]
}

const ersetze = (raw: Buffer, alt: string, neu: string): Buffer =>
	Buffer.from(raw.toString('latin1').replace(alt, neu), 'latin1')

describe('pruefeDkimFuerDomain mit Signaturen von dkimpy', () => {
	test.each(['rsa-relaxed.eml', 'rsa-simple.eml', 'ed25519.eml'])(
		'%s besteht',
		async (name) => {
			expect(
				await pruefeDkimFuerDomain(fixture(name), 'example.org', {
					resolveTxt,
				}),
			).toEqual({ kind: 'pass', domain: 'example.org' })
		},
	)

	test('Domain-Vergleich ignoriert Groß-/Kleinschreibung', async () => {
		expect(
			await pruefeDkimFuerDomain(fixture('rsa-relaxed.eml'), 'Example.ORG', {
				resolveTxt,
			}),
		).toMatchObject({ kind: 'pass' })
	})

	test('relaxed übersteht umgefaltete Header und Leerzeichen am Zeilenende', async () => {
		const raw = ersetze(
			fixture('rsa-relaxed.eml'),
			'Date: Mon, 16 Nov 2026',
			'Date:   Mon,\r\n\t16 Nov 2026',
		)
		expect(
			await pruefeDkimFuerDomain(
				ersetze(raw, 'Vera\r\n', 'Vera   \r\n'),
				'example.org',
				{ resolveTxt },
			),
		).toMatchObject({ kind: 'pass' })
	})

	test('vorangestellte Header des empfangenden MX stören nicht', async () => {
		const raw = Buffer.concat([
			Buffer.from('Received: from mx.example.net\r\n'),
			fixture('rsa-simple.eml'),
		])
		expect(
			await pruefeDkimFuerDomain(raw, 'example.org', { resolveTxt }),
		).toMatchObject({ kind: 'pass' })
	})

	test('geänderter Text fällt durch', async () => {
		expect(
			await pruefeDkimFuerDomain(
				ersetze(fixture('rsa-relaxed.eml'), 'Donnerstag.', 'Freitag.'),
				'example.org',
				{ resolveTxt },
			),
		).toEqual({ kind: 'fail', reason: 'Body-Hash stimmt nicht' })
	})

	test('geänderter From fällt durch', async () => {
		expect(
			await pruefeDkimFuerDomain(
				ersetze(fixture('ed25519.eml'), 'Vera Beispiel', 'Anna Beispiel'),
				'example.org',
				{ resolveTxt },
			),
		).toEqual({ kind: 'fail', reason: 'Signatur ungültig' })
	})

	test('ein zweiter, untergeschobener From oberhalb fällt durch', async () => {
		const raw = ersetze(
			fixture('rsa-simple.eml'),
			'From: Vera',
			'From: Anna <anna@example.org>\r\nFrom: Vera',
		)
		expect(
			await pruefeDkimFuerDomain(raw, 'example.org', { resolveTxt }),
		).toMatchObject({ kind: 'fail' })
	})

	test('Signatur einer anderen Domain zählt nicht', async () => {
		expect(
			await pruefeDkimFuerDomain(fixture('rsa-relaxed.eml'), 'levinkeller.de', {
				resolveTxt,
			}),
		).toMatchObject({
			kind: 'fail',
			reason: expect.stringContaining('d=example.org'),
		})
	})

	test('Subdomain zählt nicht', async () => {
		expect(
			await pruefeDkimFuerDomain(
				fixture('rsa-relaxed.eml'),
				'mail.example.org',
				{ resolveTxt },
			),
		).toMatchObject({ kind: 'fail' })
	})

	test('ohne Signatur kein pass', async () => {
		expect(
			await pruefeDkimFuerDomain(
				Buffer.from('From: vera@example.org\r\n\r\nHallo\r\n'),
				'example.org',
				{ resolveTxt },
			),
		).toEqual({ kind: 'fail', reason: 'keine DKIM-Signatur' })
	})

	test('fehlender Schlüssel im DNS ist fail', async () => {
		expect(
			await pruefeDkimFuerDomain(fixture('rsa-relaxed.eml'), 'example.org', {
				resolveTxt: async () => {
					throw Object.assign(new Error('x'), { code: 'ENOTFOUND' })
				},
			}),
		).toEqual({ kind: 'fail', reason: 'kein DKIM-Schlüssel im DNS' })
	})

	test('DNS-Störung ist temperror', async () => {
		expect(
			await pruefeDkimFuerDomain(fixture('rsa-relaxed.eml'), 'example.org', {
				resolveTxt: async () => {
					throw Object.assign(new Error('x'), { code: 'ETIMEOUT' })
				},
			}),
		).toMatchObject({ kind: 'temperror' })
	})

	test('widerrufener Schlüssel (leeres p=) ist fail', async () => {
		expect(
			await pruefeDkimFuerDomain(fixture('rsa-relaxed.eml'), 'example.org', {
				resolveTxt: async () => [['v=DKIM1; k=rsa; p=']],
			}),
		).toMatchObject({ kind: 'fail' })
	})

	test('l= wird abgelehnt, weil sich sonst Text anhängen ließe', async () => {
		expect(
			await pruefeDkimFuerDomain(
				ersetze(fixture('rsa-relaxed.eml'), 'v=1;', 'v=1; l=10;'),
				'example.org',
				{ resolveTxt },
			),
		).toEqual({ kind: 'fail', reason: 'l= wird nicht akzeptiert' })
	})
})
