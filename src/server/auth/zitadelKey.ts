import { createPrivateKey, type KeyObject, randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'

export type ZitadelKey = {
	type: 'serviceaccount' | 'application'
	keyId: string
	privateKey: KeyObject
	subject: string
}

export class ZitadelKeyError extends Error {}

const ASSERTION_LIFETIME_SECONDS = 60

const text = (value: unknown): string =>
	typeof value === 'string' ? value.trim() : ''

export const parseZitadelKey = (
	json: string,
	envName: string,
	expected: ZitadelKey['type'],
): ZitadelKey => {
	let raw: Record<string, unknown>
	try {
		raw = JSON.parse(json) as Record<string, unknown>
	} catch {
		throw new ZitadelKeyError(`${envName} ist kein JSON`)
	}
	if (raw.type !== expected) {
		throw new ZitadelKeyError(
			`${envName} hat type "${String(raw.type)}", erwartet "${expected}"`,
		)
	}
	const keyId = text(raw.keyId)
	const pem = text(raw.key)
	const subject =
		expected === 'serviceaccount' ? text(raw.userId) : text(raw.clientId)
	if (!keyId || !pem || !subject) {
		throw new ZitadelKeyError(
			`${envName} unvollstaendig: keyId, key und ${expected === 'serviceaccount' ? 'userId' : 'clientId'} werden gebraucht`,
		)
	}
	let privateKey: KeyObject
	try {
		privateKey = createPrivateKey(pem)
	} catch (error) {
		throw new ZitadelKeyError(
			`${envName}: privater Schluessel nicht lesbar (${(error as Error).message})`,
		)
	}
	return { type: expected, keyId, privateKey, subject }
}

export const signAssertion = (
	key: ZitadelKey,
	audience: string,
	now: number = Math.floor(Date.now() / 1000),
): Promise<string> =>
	new SignJWT({})
		.setProtectedHeader({ alg: 'RS256', kid: key.keyId })
		.setIssuer(key.subject)
		.setSubject(key.subject)
		.setAudience(audience)
		.setIssuedAt(now)
		.setExpirationTime(now + ASSERTION_LIFETIME_SECONDS)
		.setJti(randomUUID())
		.sign(key.privateKey)
