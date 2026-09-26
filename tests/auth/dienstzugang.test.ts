import { decodeProtectedHeader, jwtVerify } from 'jose'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { resetDiscovery } from '../../src/server/auth/discovery.ts'
import {
	GrantsConfigError,
	grantedAccounts,
	resetGrantsConfig,
	serviceAccessStatus,
} from '../../src/server/auth/grants.ts'
import {
	AUTHORIZATIONS_PATH,
	authorizationsResponse,
} from '../helpers/authorizations.ts'
import { createIdp, ISSUER, pem, rsaKeyPair } from '../helpers/idp.ts'

const schluessel = rsaKeyPair()

const SERVICE_KEY = JSON.stringify({
	type: 'serviceaccount',
	keyId: 'key-7',
	key: pem(schluessel.privateKey),
	userId: 'svc-user-1',
})

type Aufruf = { url: string; init?: RequestInit }

const zitadel = (
	optionen: {
		tokenStatus?: number
		expiresIn?: number
		grantsStatus?: () => number
	} = {},
) => {
	const idp = createIdp()
	const aufrufe: Aufruf[] = []
	let ausgegeben = 0
	const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
		const ziel = String(url)
		aufrufe.push({ url: ziel, init })
		if (ziel.endsWith('/.well-known/openid-configuration')) {
			return Response.json(idp.discovery)
		}
		if (ziel === idp.discovery.token_endpoint) {
			if (optionen.tokenStatus && optionen.tokenStatus !== 200) {
				return Response.json(
					{ error: 'invalid_grant', error_description: 'key revoked' },
					{ status: optionen.tokenStatus },
				)
			}
			ausgegeben++
			return Response.json({
				access_token: `at-${ausgegeben}`,
				token_type: 'Bearer',
				expires_in: optionen.expiresIn ?? 43199,
			})
		}
		if (ziel.endsWith(AUTHORIZATIONS_PATH)) {
			const status = optionen.grantsStatus?.() ?? 200
			if (status !== 200) return new Response('nein', { status })
			return authorizationsResponse([
				{ userId: 'u-anna', email: 'anna@example.org', roleKeys: ['mitglied'] },
			])
		}
		return new Response('unerwartet', { status: 500 })
	})
	vi.stubGlobal('fetch', fetchMock)
	const tokenAufrufe = () =>
		aufrufe.filter((a) => a.url === idp.discovery.token_endpoint)
	const bearer = () =>
		aufrufe
			.filter((a) => a.url.endsWith(AUTHORIZATIONS_PATH))
			.map((a) => new Headers(a.init?.headers).get('authorization'))
	return { tokenAufrufe, bearer }
}

describe('Dienstzugang per JWT-Profile', () => {
	beforeEach(() => {
		vi.stubEnv('ZITADEL_ISSUER', ISSUER)
		vi.stubEnv('ZITADEL_ORG_ID', 'org-1')
		vi.stubEnv('ZITADEL_PROJECT_ID', 'proj-1')
		vi.stubEnv('ZITADEL_SERVICE_KEY', SERVICE_KEY)
		vi.stubEnv('ZITADEL_SERVICE_TOKEN', '')
		resetGrantsConfig()
		resetDiscovery()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.useRealTimers()
		vi.restoreAllMocks()
		resetGrantsConfig()
		resetDiscovery()
	})

	test('die Assertion ist RS256, traegt die keyId und nennt Konto und Issuer', async () => {
		const z = zitadel()
		await grantedAccounts()
		const [aufruf] = z.tokenAufrufe()
		const form = new URLSearchParams(String(aufruf?.init?.body))
		expect(form.get('grant_type')).toBe(
			'urn:ietf:params:oauth:grant-type:jwt-bearer',
		)
		expect(form.get('scope')).toBe(
			'openid urn:zitadel:iam:org:project:id:zitadel:aud',
		)
		const assertion = form.get('assertion') as string
		expect(decodeProtectedHeader(assertion)).toEqual({
			alg: 'RS256',
			kid: 'key-7',
		})
		const { payload } = await jwtVerify(assertion, schluessel.publicKey, {
			issuer: 'svc-user-1',
			subject: 'svc-user-1',
			audience: ISSUER,
		})
		expect(
			(payload.exp as number) - (payload.iat as number),
		).toBeLessThanOrEqual(60)
		expect(payload.jti).toBeTruthy()
		expect(z.bearer()).toEqual(['Bearer at-1'])
	})

	test('das Token wird bis kurz vor Ablauf wiederverwendet, dann erneuert', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
		const z = zitadel({ expiresIn: 300 })
		await grantedAccounts()
		vi.setSystemTime(new Date('2026-09-26T12:02:00Z'))
		await grantedAccounts()
		expect(z.tokenAufrufe()).toHaveLength(1)
		vi.setSystemTime(new Date('2026-09-26T12:04:30Z'))
		await grantedAccounts()
		expect(z.tokenAufrufe()).toHaveLength(2)
		expect(z.bearer()).toEqual(['Bearer at-1', 'Bearer at-1', 'Bearer at-2'])
	})

	test('bei 401 wird genau einmal neu getauscht', async () => {
		let erster = true
		const z = zitadel({
			grantsStatus: () => {
				if (!erster) return 200
				erster = false
				return 401
			},
		})
		expect(await grantedAccounts()).toHaveLength(1)
		expect(z.tokenAufrufe()).toHaveLength(2)
		expect(z.bearer()).toEqual(['Bearer at-1', 'Bearer at-2'])
	})

	test('bleibt es bei 401, kommt ein Fehler statt einer Schleife', async () => {
		const z = zitadel({ grantsStatus: () => 401 })
		await expect(grantedAccounts()).rejects.toThrow(/HTTP 401/)
		expect(z.tokenAufrufe()).toHaveLength(2)
	})

	test('der Schluessel hat Vorrang vor dem Uebergangs-PAT', async () => {
		vi.stubEnv('ZITADEL_SERVICE_TOKEN', 'alter-pat')
		resetGrantsConfig()
		const z = zitadel()
		await grantedAccounts()
		expect(z.bearer()).toEqual(['Bearer at-1'])
	})

	test('ohne Schluessel gilt der PAT, ohne Token-Tausch', async () => {
		vi.stubEnv('ZITADEL_SERVICE_KEY', '')
		vi.stubEnv('ZITADEL_SERVICE_TOKEN', 'alter-pat')
		resetGrantsConfig()
		const z = zitadel()
		await grantedAccounts()
		expect(z.tokenAufrufe()).toHaveLength(0)
		expect(z.bearer()).toEqual(['Bearer alter-pat'])
	})

	test('ohne beides: klar „nicht verfuegbar“', async () => {
		vi.stubEnv('ZITADEL_SERVICE_KEY', '')
		resetGrantsConfig()
		await expect(grantedAccounts()).rejects.toBeInstanceOf(GrantsConfigError)
		await expect(grantedAccounts()).rejects.toThrow(/nicht verfuegbar/)
	})

	test('ein kaputter Schluessel wird benannt', async () => {
		vi.stubEnv('ZITADEL_SERVICE_KEY', '{"type":"application"}')
		resetGrantsConfig()
		await expect(grantedAccounts()).rejects.toThrow(/ZITADEL_SERVICE_KEY/)
	})
})

describe('Dienstzugang im Health-Check', () => {
	beforeEach(() => {
		vi.stubEnv('ZITADEL_ISSUER', ISSUER)
		vi.stubEnv('ZITADEL_ORG_ID', 'org-1')
		vi.stubEnv('ZITADEL_PROJECT_ID', 'proj-1')
		vi.stubEnv('ZITADEL_SERVICE_KEY', SERVICE_KEY)
		resetGrantsConfig()
		resetDiscovery()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.useRealTimers()
		vi.restoreAllMocks()
		resetGrantsConfig()
		resetDiscovery()
	})

	test('ohne Schluessel: not_configured, ohne einen einzigen Abruf', async () => {
		vi.stubEnv('ZITADEL_SERVICE_KEY', '')
		vi.stubEnv('ZITADEL_SERVICE_TOKEN', '')
		const fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
		expect((await serviceAccessStatus()).status).toBe('not_configured')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	test('ein erfolgreicher Tausch ist ok und wird fuenf Minuten gemerkt', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
		const z = zitadel()
		expect(await serviceAccessStatus()).toMatchObject({
			status: 'ok',
			credential: 'key',
		})
		vi.setSystemTime(new Date('2026-09-26T12:04:00Z'))
		await serviceAccessStatus()
		expect(z.tokenAufrufe()).toHaveLength(1)
		vi.setSystemTime(new Date('2026-09-26T12:05:01Z'))
		await serviceAccessStatus()
		expect(z.tokenAufrufe()).toHaveLength(2)
	})

	test('ein gescheiterter Tausch ist failing und wird laut geloggt', async () => {
		zitadel({ tokenStatus: 400 })
		const fehler = vi.spyOn(console, 'error').mockImplementation(() => {})
		const status = await serviceAccessStatus()
		expect(status.status).toBe('failing')
		expect(status.error).toContain('key revoked')
		expect(fehler).toHaveBeenCalled()
	})
})
