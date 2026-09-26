import { createLocalJWKSet, type JSONWebKeySet } from 'jose'
import { beforeAll, describe, expect, test } from 'vitest'
import {
	BACKCHANNEL_LOGOUT_EVENT,
	LogoutTokenError,
	verifyLogoutToken,
} from '../../src/server/auth/revocation.ts'
import { createIdp, type Idp, ISSUER } from '../helpers/idp.ts'

let idp: Idp
let fremd: Idp
let keys: ReturnType<typeof createLocalJWKSet>

const EVENTS = { [BACKCHANNEL_LOGOUT_EVENT]: {} }

beforeAll(async () => {
	idp = createIdp()
	fremd = createIdp()
	keys = createLocalJWKSet((await idp.jwks()) as JSONWebKeySet)
})

const pruefe = (token: string) =>
	verifyLogoutToken(token, { issuer: ISSUER, audience: 'client-1', keys })

describe('logout_token', () => {
	test('ein gueltiges Token nennt sub und sid', async () => {
		const token = await idp.sign({
			aud: 'client-1',
			sub: 'u-anna',
			sid: 'sid-1',
			jti: 'j1',
			events: EVENTS,
		})
		expect(await pruefe(token)).toEqual({ sub: 'u-anna', sid: 'sid-1' })
	})

	test('sid allein genuegt', async () => {
		const token = await idp.sign({
			aud: 'client-1',
			sid: 'sid-1',
			events: EVENTS,
		})
		expect(await pruefe(token)).toEqual({ sub: null, sid: 'sid-1' })
	})

	test.each([
		['fremde Zielgruppe', { aud: 'client-2', sub: 'u', events: EVENTS }],
		['ohne Ereignis', { aud: 'client-1', sub: 'u' }],
		['falsches Ereignis', { aud: 'client-1', sub: 'u', events: { x: {} } }],
		['mit nonce', { aud: 'client-1', sub: 'u', events: EVENTS, nonce: 'n' }],
		['weder sub noch sid', { aud: 'client-1', events: EVENTS }],
	])('abgelehnt: %s', async (_name, claims) => {
		await expect(pruefe(await idp.sign(claims))).rejects.toBeInstanceOf(
			LogoutTokenError,
		)
	})

	test('abgelehnt: von einem anderen Schluessel signiert', async () => {
		const token = await fremd.sign({
			aud: 'client-1',
			sub: 'u',
			events: EVENTS,
		})
		await expect(pruefe(token)).rejects.toBeInstanceOf(LogoutTokenError)
	})

	test('abgelehnt: kein JWT', async () => {
		await expect(pruefe('kein.jwt.token')).rejects.toBeInstanceOf(
			LogoutTokenError,
		)
	})
})
