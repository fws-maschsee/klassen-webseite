import { describe, expect, test } from 'vitest'
import { nameFuer } from '../../src/routes/mitbringen/gemeinsam.ts'

/**
 * Wer angemeldet ist, traegt unter dem Kontonamen ein — was im Formular steht,
 * zaehlt dann nicht. Gaeste tippen selbst; ein admin, der fremde Eintraege
 * korrigiert, ueberschreibt deren Namen nicht mit seinem.
 */
describe('nameFuer', () => {
	const konto = { sub: 'sub-a', name: 'Familie Konto', admin: false }
	const gast = { sub: null, name: null, admin: false }
	const admin = { sub: 'sub-admin', name: 'Frau Admin', admin: true }

	test('angemeldet: neuer Eintrag trägt den Kontonamen, das Formular wird ignoriert', () => {
		expect(nameFuer(konto, 'Jemand anderes', undefined)).toBe('Familie Konto')
	})
	test('angemeldet: eigener Eintrag behaelt den Kontonamen', () => {
		expect(nameFuer(konto, 'Umbenannt', 'sub-a')).toBe('Familie Konto')
	})
	test('admin korrigiert fremden Eintrag: der Name der Familie bleibt, was im Formular steht', () => {
		expect(nameFuer(admin, 'Familie Muster', 'sub-x')).toBe('Familie Muster')
		expect(nameFuer(admin, 'Familie Gast', null)).toBe('Familie Gast')
	})
	test('Gast: der Name kommt aus dem Formular, fehlt er, bleibt er undefiniert', () => {
		expect(nameFuer(gast, 'Familie Gast', undefined)).toBe('Familie Gast')
		expect(nameFuer(gast, null, undefined)).toBeUndefined()
	})
})
