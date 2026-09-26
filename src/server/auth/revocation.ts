import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { type JWTVerifyGetKey, jwtVerify } from 'jose'
import {
	expireAccessTokensBySub,
	expireAllAccessTokens,
	revokeAuthSessionsBySid,
	revokeAuthSessionsBySub,
	subForSid,
} from '../../lib/db/authSessions.ts'
import { openDb } from '../../lib/db/index.ts'
import { revokeAllTokensForUser } from '../../lib/db/oauth.ts'

export type Revocation = { sessions: number; mcpTokens: number }

export const revokeUser = (
	sub: string,
	db: Database = openDb(),
): Revocation => {
	const sessions = revokeAuthSessionsBySub(sub, db)
	const { access, refresh } = revokeAllTokensForUser(sub, db)
	return { sessions, mcpTokens: access + refresh }
}

export const BACKCHANNEL_LOGOUT_EVENT =
	'http://schemas.openid.net/event/backchannel-logout'

export class LogoutTokenError extends Error {}

export type LogoutTarget = { sub: string | null; sid: string | null }

export const verifyLogoutToken = async (
	token: string,
	options: { issuer: string; audience: string; keys: JWTVerifyGetKey },
): Promise<LogoutTarget> => {
	let payload: Record<string, unknown>
	try {
		;({ payload } = await jwtVerify(token, options.keys, {
			issuer: options.issuer,
			audience: options.audience,
			requiredClaims: ['iat'],
			maxTokenAge: '10m',
		}))
	} catch (error) {
		throw new LogoutTokenError(
			`logout_token ungueltig: ${(error as Error).message}`,
		)
	}
	const events = payload.events
	if (
		!events ||
		typeof events !== 'object' ||
		!Object.hasOwn(events, BACKCHANNEL_LOGOUT_EVENT)
	) {
		throw new LogoutTokenError('logout_token ohne backchannel-logout-Ereignis')
	}
	if ('nonce' in payload) {
		throw new LogoutTokenError('logout_token darf keine nonce tragen')
	}
	const sub =
		typeof payload.sub === 'string' && payload.sub ? payload.sub : null
	const sid =
		typeof payload.sid === 'string' && payload.sid ? payload.sid : null
	if (!sub && !sid) {
		throw new LogoutTokenError('logout_token nennt weder sub noch sid')
	}
	return { sub, sid }
}

export const applyLogout = (
	target: LogoutTarget,
	db: Database = openDb(),
): number =>
	target.sid
		? revokeAuthSessionsBySid(target.sid, db)
		: revokeAuthSessionsBySub(target.sub as string, db)

export const SIGNATURE_TOLERANCE_SECONDS = 300

export type SignatureCheck =
	| { ok: true }
	| { ok: false; reason: 'missing' | 'malformed' | 'expired' | 'mismatch' }

export const verifyWebhookSignature = (
	rawBody: Buffer,
	header: string | null,
	signingKey: string,
	now: number = Math.floor(Date.now() / 1000),
): SignatureCheck => {
	if (!header) return { ok: false, reason: 'missing' }
	let timestamp: number | null = null
	const signatures: Buffer[] = []
	for (const pair of header.split(',')) {
		const [name, value, ...rest] = pair.trim().split('=')
		if (!name || value === undefined || rest.length > 0) {
			return { ok: false, reason: 'malformed' }
		}
		if (name === 't') {
			if (!/^\d+$/.test(value)) return { ok: false, reason: 'malformed' }
			timestamp = Number(value)
		} else if (name === 'v1' && /^[0-9a-f]+$/i.test(value)) {
			signatures.push(Buffer.from(value, 'hex'))
		}
	}
	if (timestamp === null || signatures.length === 0) {
		return { ok: false, reason: 'malformed' }
	}
	if (Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
		return { ok: false, reason: 'expired' }
	}
	const expected = createHmac('sha256', signingKey)
		.update(`${timestamp}.`)
		.update(rawBody)
		.digest()
	const match = signatures.some(
		(signature) =>
			signature.length === expected.length &&
			timingSafeEqual(signature, expected),
	)
	return match ? { ok: true } : { ok: false, reason: 'mismatch' }
}

export type ZitadelEvent = {
	aggregateID?: string
	aggregateType?: string
	event_type?: string
	eventType?: string
	event_payload?: unknown
	eventPayload?: unknown
}

const ACCOUNT_EVENTS = new Set([
	'user.locked',
	'user.deactivated',
	'user.removed',
])

const USER_TOKEN_EVENTS = new Set([
	'user.token.removed',
	'user.human.signed.out',
	'user.human.refresh.token.removed',
])

const OIDC_SESSION_EVENTS = new Set([
	'oidc_session.access_token.revoked',
	'oidc_session.refresh_token.revoked',
])

const REVOKE_GRANT_EVENTS = new Set([
	'user.grant.removed',
	'user.grant.cascade.removed',
	'user.grant.deactivated',
])

// Geänderte Rollen brauchen keine neue Anmeldung: die Verlängerung holt sie frisch, MCP liest sie mit Dienstzugang je Aufruf.
const REFRESH_GRANT_EVENTS = new Set([
	'user.grant.changed',
	'user.grant.cascade.changed',
	'user.grant.added',
	'user.grant.reactivated',
])

export type EventOutcome =
	| { action: 'revoke_user'; sub: string; sessions: number; mcpTokens: number }
	| { action: 'revoke_sessions'; sub: string; sessions: number }
	| { action: 'refresh_user'; sub: string; sessions: number }
	| { action: 'refresh_all'; sessions: number }
	| { action: 'ignored'; eventType: string }

const payloadOf = (event: ZitadelEvent): Record<string, unknown> => {
	const raw = event.event_payload ?? event.eventPayload
	return raw && typeof raw === 'object' && !Array.isArray(raw)
		? (raw as Record<string, unknown>)
		: {}
}

const text = (value: unknown): string =>
	typeof value === 'string' ? value : ''

export const handleZitadelEvent = (
	event: ZitadelEvent,
	projectId: string,
	injectedDb?: Database,
): EventOutcome => {
	const db = (): Database => injectedDb ?? openDb()
	const eventType = text(event.event_type) || text(event.eventType)
	const aggregateId = text(event.aggregateID)
	const payload = payloadOf(event)
	const eventProject = text(payload.projectId)

	if (ACCOUNT_EVENTS.has(eventType) && aggregateId) {
		return {
			action: 'revoke_user',
			sub: aggregateId,
			...revokeUser(aggregateId, db()),
		}
	}

	if (USER_TOKEN_EVENTS.has(eventType) && aggregateId) {
		return {
			action: 'revoke_sessions',
			sub: aggregateId,
			sessions: revokeAuthSessionsBySub(aggregateId, db()),
		}
	}

	if (eventType === 'session.terminated' && aggregateId) {
		const sub = subForSid(aggregateId, db())
		if (!sub) return { action: 'ignored', eventType }
		return {
			action: 'revoke_sessions',
			sub,
			sessions: revokeAuthSessionsBySid(aggregateId, db()),
		}
	}

	if (OIDC_SESSION_EVENTS.has(eventType)) {
		// These events name only ZITADEL's internal OIDC session; a forced refresh fails for exactly the revoked tokens.
		return { action: 'refresh_all', sessions: expireAllAccessTokens(db()) }
	}

	if (eventType.startsWith('user.grant.')) {
		if (projectId && eventProject && eventProject !== projectId) {
			return { action: 'ignored', eventType }
		}
		const userId = text(payload.userId)
		if (REVOKE_GRANT_EVENTS.has(eventType)) {
			if (userId) {
				return {
					action: 'revoke_user',
					sub: userId,
					...revokeUser(userId, db()),
				}
			}
			// Deactivated/cascade grant events carry no userId; renewing every session re-reads the roles within one request.
			return { action: 'refresh_all', sessions: expireAllAccessTokens(db()) }
		}
		if (REFRESH_GRANT_EVENTS.has(eventType)) {
			if (userId) {
				return {
					action: 'refresh_user',
					sub: userId,
					sessions: expireAccessTokensBySub(userId, db()),
				}
			}
			return { action: 'refresh_all', sessions: expireAllAccessTokens(db()) }
		}
	}

	return { action: 'ignored', eventType: eventType || '(leer)' }
}
