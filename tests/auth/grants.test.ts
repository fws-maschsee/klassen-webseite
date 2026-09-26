import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	GrantsUnavailableError,
	grantedAccounts,
	resetGrantsConfig,
	rolesForUser,
} from '../../src/server/auth/grants.ts'
import {
	AUTHORIZATIONS_PATH,
	authorizationsBody,
	authorizationsResponse,
} from '../helpers/authorizations.ts'

describe('Rollen aus ZITADEL (Authorization Service v2)', () => {
	beforeEach(() => {
		vi.stubEnv('ZITADEL_ISSUER', 'https://id.example.org')
		vi.stubEnv('ZITADEL_ORG_ID', 'org-1')
		vi.stubEnv('ZITADEL_PROJECT_ID', 'proj-1')
		vi.stubEnv('ZITADEL_SERVICE_KEY', '')
		vi.stubEnv('ZITADEL_SERVICE_TOKEN', 'tok')
		resetGrantsConfig()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		resetGrantsConfig()
	})

	it('fragt die Autorisierungen des eigenen Projekts ab', async () => {
		const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
			expect(url).toBe(`https://id.example.org${AUTHORIZATIONS_PATH}`)
			const body = JSON.parse(String(init.body))
			expect(body.filters).toEqual([{ projectId: { id: 'proj-1' } }])
			return authorizationsResponse([
				{ userId: 'sub-1', roleKeys: ['mitglied', 'admin'] },
				{ userId: 'jemand-anderes', roleKeys: ['admin'] },
			])
		})
		vi.stubGlobal('fetch', fetchMock)
		expect(await rolesForUser('sub-1')).toEqual(['mitglied', 'admin'])
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it('gibt niemandem die Rollen eines anderen', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				authorizationsResponse([{ userId: 'sub-1', roleKeys: ['admin'] }]),
			),
		)
		expect(await rolesForUser('wer-anders')).toEqual([])
	})

	it('ignoriert inaktive Autorisierungen', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				authorizationsResponse([
					{ userId: 'sub-2', roleKeys: ['admin'], state: 'STATE_INACTIVE' },
				]),
			),
		)
		expect(await rolesForUser('sub-2')).toEqual([])
	})

	it('laesst Autorisierungen fremder Projekte nicht durch, auch wenn ZITADEL sie liefert', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				authorizationsResponse([
					{ userId: 'sub-3', roleKeys: ['admin'], projectId: 'proj-anders' },
					{ userId: 'sub-3', roleKeys: ['mitglied'] },
				]),
			),
		)
		expect(await rolesForUser('sub-3')).toEqual(['mitglied'])
	})

	it('blaettert durch alle Seiten', async () => {
		const alle = Array.from({ length: 450 }, (_, i) => ({
			userId: `u-${i}`,
			email: `p${i}@example.org`,
			roleKeys: ['mitglied'],
		}))
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			const { pagination } = JSON.parse(String(init.body))
			const seite = authorizationsBody(
				alle.slice(pagination.offset, pagination.offset + pagination.limit),
			)
			seite.pagination.totalResult = String(alle.length)
			return Response.json(seite)
		})
		vi.stubGlobal('fetch', fetchMock)
		const konten = await grantedAccounts()
		expect(konten).toHaveLength(450)
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})

	it('nimmt die Anmeldeadresse als Mail, einen blossen Benutzernamen nicht', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				authorizationsResponse([
					{ userId: 'u1', email: 'Anna@Example.org', roleKeys: ['mitglied'] },
					{ userId: 'u2', email: 'bert', roleKeys: ['mitglied'] },
				]),
			),
		)
		expect(await grantedAccounts()).toEqual([
			{ userId: 'u1', email: 'anna@example.org', roles: ['mitglied'] },
			{ userId: 'u2', email: '', roles: ['mitglied'] },
		])
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
})
