import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	GrantsUnavailableError,
	resetGrantsConfig,
	rolesForUser,
} from '../../src/server/auth/grants.ts'

/**
 * Die Berechtigung kommt zur Laufzeit aus ZITADEL, nicht aus einem Token.
 * Diese Tests halten die beiden Eigenschaften fest, die dabei zaehlen:
 * Rollen werden wirklich dort erfragt, und ein Ausfall fuehrt zu einer
 * VERWEIGERUNG statt zu einem Durchwinken.
 *
 * ROLLEN, sonst nichts. Hier stand einmal auch ein Test fuer `usersWithRole`,
 * das Namen und Adressen aller Personen mit Grant lieferte — die Quelle der
 * entfernten Spiegelung ins Adressbuch. Dass diese Antworten keine
 * Adressbuch-Daten mehr erzeugen, bewacht
 * `tests/auth/getrennte-datenschichten.test.ts`.
 */
describe('Rollen aus ZITADEL', () => {
	const original = { ...process.env }

	beforeEach(() => {
		process.env.ZITADEL_ISSUER = 'https://id.example.org'
		process.env.ZITADEL_ORG_ID = 'org-1'
		process.env.ZITADEL_PROJECT_ID = 'proj-1'
		process.env.ZITADEL_SERVICE_TOKEN = 'tok'
		resetGrantsConfig()
	})

	afterEach(() => {
		process.env = { ...original }
		resetGrantsConfig()
		vi.restoreAllMocks()
	})

	it('fragt die Grants des Projekts dieser Instanz ab', async () => {
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body))
			// Auf das Projekt eingeschraenkt und NUR danach — `userIdQuery`
			// liefert gegen die echte Instanz still null Zeilen.
			expect(body.queries).toEqual([
				{ projectIdQuery: { projectId: 'proj-1' } },
			])
			return new Response(
				JSON.stringify({
					result: [
						{
							userId: 'sub-1',
							roleKeys: ['mitglied', 'admin'],
							state: 'USER_GRANT_STATE_ACTIVE',
						},
						// Ein anderer Grant im selben Projekt — darf nicht
						// mitgeliefert werden.
						{
							userId: 'jemand-anderes',
							roleKeys: ['admin'],
							state: 'USER_GRANT_STATE_ACTIVE',
						},
					],
				}),
				{ status: 200 },
			)
		})
		vi.stubGlobal('fetch', fetchMock)
		expect(await rolesForUser('sub-1')).toEqual(['mitglied', 'admin'])
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it('gibt niemandem die Rollen eines anderen', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							result: [
								{
									userId: 'sub-1',
									roleKeys: ['admin'],
									state: 'USER_GRANT_STATE_ACTIVE',
								},
							],
						}),
						{ status: 200 },
					),
			),
		)
		expect(await rolesForUser('wer-anders')).toEqual([])
	})

	it('ignoriert inaktive Grants', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							result: [
								{
									userId: 'sub-2',
									roleKeys: ['admin'],
									state: 'USER_GRANT_STATE_INACTIVE',
								},
							],
						}),
						{ status: 200 },
					),
			),
		)
		expect(await rolesForUser('sub-2')).toEqual([])
	})

	it('verweigert bei einer Stoerung, statt durchzuwinken', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('connect ECONNREFUSED')
			}),
		)
		await expect(rolesForUser('sub-3')).rejects.toBeInstanceOf(
			GrantsUnavailableError,
		)
	})

	it('verweigert auch bei HTTP-Fehlern', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('nope', { status: 403 })),
		)
		await expect(rolesForUser('sub-4')).rejects.toBeInstanceOf(
			GrantsUnavailableError,
		)
	})

	it('nimmt Namen und Adressen aus der Antwort nicht mit', async () => {
		// Die Antwort von ZITADEL traegt sie; dieses Modul gibt sie nicht weiter.
		// Es liefert Rollen, und Rollen sind keine personenbezogenen Daten, die
		// irgendwo gespeichert werden muessten.
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							result: [
								{
									userId: 'u1',
									email: 'vorname.nachname@example.org',
									firstName: 'Vorname',
									lastName: 'Nachname',
									roleKeys: ['mitglied'],
									state: 'USER_GRANT_STATE_ACTIVE',
								},
							],
						}),
						{ status: 200 },
					),
			),
		)
		expect(await rolesForUser('u1')).toEqual(['mitglied'])
	})
})
