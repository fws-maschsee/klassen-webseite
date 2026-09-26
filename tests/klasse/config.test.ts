import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { defineKlassenConfig, PUBLIC_PATHS } from '../../src/klasse/config.ts'
import { listKeyIdFromPem } from '../../src/lib/lists/signatureEd25519.ts'

const gueltig = {
	slug: 'klasse-beispiel',
	label: 'Klasse Beispiel',
	domain: 'klasse-beispiel.example.org',
	repoUrl: 'https://github.com/fws-maschsee/klasse-beispiel',
	contactMail: 'verwaltung@example.org',
	calendarPath: '/public/beispiel.ics',
}

describe('defineKlassenConfig', () => {
	test('leitet alles ab, was aus slug und domain folgt', () => {
		const config = defineKlassenConfig(gueltig)
		expect(config.siteUrl).toBe('https://klasse-beispiel.example.org')
		expect(config.analyticsDomain).toBe('klasse-beispiel.example.org')
		expect(config.listDomain).toBe('klasse-beispiel.lists.fws-maschsee-test.de')
		expect(config.dbPath).toBe('./data/klasse-beispiel.db')
		expect(config.zitadelProject).toBe('klasse-beispiel')
		expect(config.authRole).toBe('mitglied')
		expect(config.feedbackUrl).toBe(
			'https://github.com/fws-maschsee/klasse-beispiel/issues',
		)
	})

	test('laesst sich jeden abgeleiteten Wert einzeln ueberschreiben', () => {
		const config = defineKlassenConfig({
			...gueltig,
			domain: 'alte-domain.example.org',
			analyticsDomain: 'neue-domain.example.org',
			listDomain: 'sonderfall.example.org',
			feedbackUrl: 'https://github.com/x/y/discussions',
		})
		expect(config.siteUrl).toBe('https://alte-domain.example.org')
		expect(config.analyticsDomain).toBe('neue-domain.example.org')
		expect(config.listDomain).toBe('sonderfall.example.org')
		expect(config.feedbackUrl).toBe('https://github.com/x/y/discussions')
	})

	test('lehnt einen Kalender ausserhalb der oeffentlichen Pfade ab', () => {
		expect(() =>
			defineKlassenConfig({ ...gueltig, calendarPath: '/beispiel.ics' }),
		).toThrow(/oeffentlichen Pfad/)
	})

	test('akzeptiert null als "diese Klasse hat keinen Kalender"', () => {
		expect(
			defineKlassenConfig({ ...gueltig, calendarPath: null }).calendarPath,
		).toBeNull()
	})

	test('hat ohne Angabe keine alte Kalenderadresse', () => {
		expect(defineKlassenConfig(gueltig).calendarLegacyPath).toBeNull()
	})

	test('nimmt eine alte Kalenderadresse auf', () => {
		expect(
			defineKlassenConfig({ ...gueltig, calendarLegacyPath: '/beispiel.ics' })
				.calendarLegacyPath,
		).toBe('/beispiel.ics')
	})

	test('lehnt eine alte Kalenderadresse ohne Ziel ab', () => {
		expect(() =>
			defineKlassenConfig({
				...gueltig,
				calendarPath: null,
				calendarLegacyPath: '/beispiel.ics',
			}),
		).toThrow(/Umleitung ohne Ziel/)
	})

	test('lehnt eine Umleitung auf sich selbst ab', () => {
		expect(() =>
			defineKlassenConfig({
				...gueltig,
				calendarLegacyPath: gueltig.calendarPath,
			}),
		).toThrow(/auf sich selbst/)
	})

	test('lehnt einen slug ab, der als Maildomain nicht funktioniert', () => {
		expect(() =>
			defineKlassenConfig({ ...gueltig, slug: 'Klasse Beispiel' }),
		).toThrow(/slug/)
	})

	test('lehnt eine URL im domain-Feld ab', () => {
		expect(() =>
			defineKlassenConfig({
				...gueltig,
				domain: 'https://klasse-beispiel.example.org',
			}),
		).toThrow(/keine URL/)
	})

	test('bringt den Schluessel des Dispatchers als Vorgabe mit', () => {
		const config = defineKlassenConfig(gueltig)
		expect(config.listPublicKeyPem).toContain('BEGIN PUBLIC KEY')
		expect([...config.listKeyIds]).toEqual([
			listKeyIdFromPem(config.listPublicKeyPem),
		])
	})

	test('lehnt eine Key-Id ab, die nicht zum Schluessel passt', () => {
		const pem = generateKeyPairSync('ed25519')
			.publicKey.export({ format: 'pem', type: 'spki' })
			.toString()
		expect(() =>
			defineKlassenConfig({ ...gueltig, listPublicKeyPem: pem }),
		).toThrow(/listKeyIds/)
		expect(
			defineKlassenConfig({
				...gueltig,
				listPublicKeyPem: pem,
				listKeyIds: [listKeyIdFromPem(pem)],
			}).listKeyIds,
		).toHaveLength(1)
	})

	test('lehnt eine leere Key-Id-Liste und ein kaputtes PEM ab', () => {
		expect(() => defineKlassenConfig({ ...gueltig, listKeyIds: [] })).toThrow(
			/listKeyIds ist leer/,
		)
		expect(() =>
			defineKlassenConfig({ ...gueltig, listPublicKeyPem: 'kein PEM' }),
		).toThrow(/listPublicKeyPem/)
	})

	test('nennt alle Fehler auf einmal', () => {
		try {
			defineKlassenConfig({
				...gueltig,
				slug: 'Falsch',
				contactMail: 'keine-adresse',
				repoUrl: 'github.com/x/y',
			})
			throw new Error('erwartet: Fehler')
		} catch (fehler) {
			const text = (fehler as Error).message
			expect(text).toContain('slug')
			expect(text).toContain('contactMail')
			expect(text).toContain('repoUrl')
		}
	})
})

describe('PUBLIC_PATHS', () => {
	test('enthaelt genau die zwei Pfade, die ohne Cookie auskommen muessen', () => {
		expect([...PUBLIC_PATHS]).toEqual(['/public/', '/api/lists/'])
	})
})

describe('blaetter', () => {
	test('ein Blatt unter einem oeffentlichen Pfad wird abgelehnt', () => {
		expect(() =>
			defineKlassenConfig({
				...gueltig,
				blaetter: [
					{
						pfad: '/public/stundenplan.pdf',
						quelle: 'src/blaetter/stundenplan.typ',
						dateiname: 'stundenplan.pdf',
					},
				],
			}),
		).toThrow(/oeffentlichen Pfad/)
	})

	test('eine Quelle ausserhalb von src/ wird abgelehnt', () => {
		expect(() =>
			defineKlassenConfig({
				...gueltig,
				blaetter: [
					{
						pfad: '/blaetter/stundenplan.pdf',
						quelle: 'dokumente/stundenplan.typ',
						dateiname: 'stundenplan.pdf',
					},
				],
			}),
		).toThrow(/unter src\//)
	})

	test('ohne Angabe ist die Liste leer', () => {
		expect(defineKlassenConfig(gueltig).blaetter).toEqual([])
	})
})
