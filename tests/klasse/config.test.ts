import { describe, expect, test } from 'vitest'
import { defineKlassenConfig, PUBLIC_PATHS } from '../../src/klasse/config.js'

/**
 * Der Konfigurationsvertrag ist die einzige Stelle, an der sich zwei Klassen
 * noch unterscheiden dürfen. Was er durchlässt, läuft ungeprüft in den Betrieb
 * — deshalb prüft dieser Test die Ablehnungen und nicht die Vorgaben.
 */

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
		// Der Fall aus der Wirklichkeit: `klasse-wiesen` laeuft unter
		// `klasse-poellmann.de`, weil DNS und Zertifikat daran haengen.
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
		// Der Sieben-Monats-Fehler: aus `/public/x.ics` wurde `/x.ics`, und jedes
		// Abo hoerte still auf zu aktualisieren.
		expect(() =>
			defineKlassenConfig({ ...gueltig, calendarPath: '/beispiel.ics' }),
		).toThrow(/oeffentlichen Pfad/)
	})

	test('akzeptiert null als "diese Klasse hat keinen Kalender"', () => {
		expect(
			defineKlassenConfig({ ...gueltig, calendarPath: null }).calendarPath,
		).toBeNull()
	})

	test('lehnt einen slug ab, der als Maildomain nicht funktioniert', () => {
		// Der Slug wird Teil von `<liste>@<slug>.lists...` und eines Dateinamens.
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

	test('nennt alle Fehler auf einmal', () => {
		// Eine Klasse, die drei Felder falsch hat, soll sie in einem Durchgang
		// erfahren und nicht in drei Fehlversuchen.
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
		// Diese Liste zu erweitern heisst, Protokolle zu veroeffentlichen.
		expect([...PUBLIC_PATHS]).toEqual(['/public/', '/api/lists/'])
	})
})
