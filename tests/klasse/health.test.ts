import { describe, expect, test } from 'vitest'
import {
	healthReport,
	healthStatusCode,
	UNKNOWN,
} from '../../src/klasse/health.ts'

const input = (
	env: Record<string, string | undefined> = {},
	rest: { listKeyIds?: readonly string[]; hasPublicKey?: boolean } = {},
) => ({
	instance: 'klasse-wiesen',
	env,
	listKeyIds: rest.listKeyIds ?? (['bf2226d575ece8c8'] as const),
	hasPublicKey: rest.hasPublicKey ?? true,
})

describe('healthReport', () => {
	test('nennt die Commits aus der Bau-Umgebung', () => {
		const report = healthReport(
			input({
				BUILD_COMMIT: 'abc1234',
				BUILD_SHARED: 'def5678',
				BUILD_TIME: '2026-08-12T06:00:00Z',
			}),
		)
		expect(report.commit).toBe('abc1234')
		expect(report.shared).toBe('def5678')
		expect(report.builtAt).toBe('2026-08-12T06:00:00Z')
		expect(report.instance).toBe('klasse-wiesen')
		expect(report.status).toBe('ok')
	})

	test('ohne Bau-Angaben steht dort "unknown" und nicht etwas Erfundenes', () => {
		const report = healthReport(input())
		expect(report.commit).toBe(UNKNOWN)
		expect(report.shared).toBe(UNKNOWN)
		expect(report.builtAt).toBeNull()
	})

	test('leere Zeichenketten gelten als fehlend', () => {
		const report = healthReport(input({ BUILD_COMMIT: '   ', BUILD_TIME: '' }))
		expect(report.commit).toBe(UNKNOWN)
		expect(report.builtAt).toBeNull()
	})

	test('meldet ed25519 nur, wenn Schluessel UND Kennung da sind', () => {
		expect(healthReport(input()).lists.schemes).toEqual(['ed25519'])
		expect(
			healthReport(input({}, { hasPublicKey: false })).lists.schemes,
		).toEqual([])
		expect(healthReport(input({}, { listKeyIds: [] })).lists.schemes).toEqual(
			[],
		)
	})

	test('ohne jedes Verfahren bleibt die Liste leer statt "ok" zu behaupten', () => {
		const report = healthReport(
			input({}, { hasPublicKey: false, listKeyIds: [] }),
		)
		expect(report.lists.schemes).toEqual([])
		expect(report.status).toBe('ok')
	})

	test('gibt die Schluesselkennungen weiter, aber keine Zahlen aus der Datenbank', () => {
		const report = healthReport(input())
		expect(report.lists.keyIds).toEqual(['bf2226d575ece8c8'])
		const felder = JSON.stringify(report)
		for (const verboten of ['mitglieder', 'count', '@', 'eltern']) {
			expect(felder.toLowerCase()).not.toContain(verboten)
		}
	})

	test('die Nutzlast ist englisch benannt', () => {
		const report = healthReport(input({ BUILD_COMMIT: 'abc' }))
		expect(Object.keys(report).sort()).toEqual([
			'builtAt',
			'commit',
			'instance',
			'lists',
			'serviceAccess',
			'shared',
			'status',
		])
		expect(Object.keys(report.lists).sort()).toEqual(['keyIds', 'schemes'])
	})
})

describe('Dienstzugang im Health-Bericht', () => {
	const mit = (status: 'ok' | 'failing' | 'not_configured') =>
		healthReport({
			...input(),
			serviceAccess: {
				status,
				credential: status === 'not_configured' ? null : 'key',
				checkedAt: status === 'not_configured' ? null : '2026-09-26T12:00:00Z',
				error: status === 'failing' ? 'HTTP 400 invalid_grant' : null,
			},
		})

	test('ohne Schluessel (Vorschau) bleibt es bei ok und 200', () => {
		const report = healthReport(input())
		expect(report.serviceAccess.status).toBe('not_configured')
		expect(report.status).toBe('ok')
		expect(healthStatusCode(report)).toBe(200)
	})

	test('ein gescheiterter Token-Tausch macht den Bericht rot: degraded und 503', () => {
		const report = mit('failing')
		expect(report.status).toBe('degraded')
		expect(report.serviceAccess.error).toContain('invalid_grant')
		expect(healthStatusCode(report)).toBe(503)
	})

	test('ein funktionierender Dienstzugang ist ok', () => {
		expect(healthStatusCode(mit('ok'))).toBe(200)
	})
})
