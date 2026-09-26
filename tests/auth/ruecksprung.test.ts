import { describe, expect, test } from 'vitest'
import { safeReturnTo } from '../../src/server/auth/oidc.ts'

describe('safeReturnTo', () => {
	test.each([
		['/adressbuch', '/adressbuch'],
		['/termine?monat=9#heute', '/termine?monat=9#heute'],
	])('%s bleibt %s', (wert, erwartet) => {
		expect(safeReturnTo(wert)).toBe(erwartet)
	})

	test.each([
		null,
		undefined,
		'',
		'https://evil.example/',
		'//evil.example',
		'/\\evil.example',
		'/\\/evil.example',
		'/\t/evil.example',
		'\\\\evil.example',
	])('%s führt nicht auf eine fremde Seite', (wert) => {
		expect(safeReturnTo(wert)).toBe('/')
	})
})
