import { afterEach, describe, expect, test, vi } from 'vitest'
import { resetGrantsConfig } from '../../src/server/auth/grants.ts'
import { authFromInfo, rolesFor } from '../../src/server/mcp/guard.ts'
import { authorizationsResponse } from '../helpers/authorizations.ts'

const info = (consentRoles: unknown) => ({
	token: 't',
	clientId: 'c',
	scopes: ['mcp'],
	extra: { userId: 'u-anna', consentRoles },
})

describe('Rollen fuer MCP-Werkzeuge', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		resetGrantsConfig()
	})

	test('mit Dienstzugang frisch aus ZITADEL, nicht aus der Zustimmung', async () => {
		vi.stubEnv('ZITADEL_ISSUER', 'https://id.example.org')
		vi.stubEnv('ZITADEL_ORG_ID', 'org-1')
		vi.stubEnv('ZITADEL_PROJECT_ID', 'proj-1')
		vi.stubEnv('ZITADEL_SERVICE_KEY', '')
		vi.stubEnv('ZITADEL_SERVICE_TOKEN', 'tok')
		resetGrantsConfig()
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				authorizationsResponse([{ userId: 'u-anna', roleKeys: ['mitglied'] }]),
			),
		)
		expect(await rolesFor(authFromInfo(info(['admin'])))).toEqual(['mitglied'])
	})

	test('ohne Dienstzugang gelten die Rollen der Zustimmung', async () => {
		vi.stubEnv('ZITADEL_SERVICE_KEY', '')
		vi.stubEnv('ZITADEL_SERVICE_TOKEN', '')
		resetGrantsConfig()
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		expect(await rolesFor(authFromInfo(info(['admin'])))).toEqual(['admin'])
		expect(await rolesFor(authFromInfo(info(null)))).toEqual([])
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
