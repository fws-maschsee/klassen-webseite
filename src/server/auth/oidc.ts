import { createHash, randomBytes } from 'node:crypto'
import { EncryptJWT, type JWTPayload, jwtDecrypt, jwtVerify } from 'jose'
import { klassenConfig } from '../../klasse/config.ts'
import {
	type AuthSession,
	activeAuthSession,
	authSessionId,
	createAuthSession,
	deleteAuthSession,
	updateAuthSession,
} from '../../lib/db/authSessions.ts'
import { type Discovery, discover, remoteKeySet } from './discovery.ts'
import {
	applyLogout,
	LogoutTokenError,
	verifyLogoutToken,
} from './revocation.ts'
import { canRead } from './roles.ts'
import {
	hasRolesClaim,
	PROJECTS_ROLES_SCOPE,
	projectAudienceScope,
	type RoleScope,
	rolesFromClaims,
} from './tokenRoles.ts'
import {
	parseZitadelKey,
	signAssertion,
	type ZitadelKey,
} from './zitadelKey.ts'

const SESSION_COOKIE = 'fws_session'

const STATE_COOKIE_PREFIX = 'fws_auth_'

const STATE_MAX_AGE_SECONDS = 15 * 60

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

const DEFAULT_ACCESS_LIFETIME_SECONDS = 5 * 60

const REFRESH_LEEWAY_SECONDS = 15

const BASE_SCOPES = ['openid', 'profile', 'email', 'offline_access']

export interface OidcConfig {
	issuer: string
	clientId: string
	clientKey: ZitadelKey | null
	clientSecret: string
	requiredRole: string
	sessionKey: Uint8Array
	roleScope: RoleScope
	scopes: string
}

export class OidcConfigError extends Error {}

const readEnv = (name: string): string => (process.env[name] ?? '').trim()

let cachedConfig: OidcConfig | null = null

export const getOidcConfig = (): OidcConfig => {
	if (cachedConfig) return cachedConfig

	const issuer = readEnv('OIDC_ISSUER') || 'https://id.fws-maschsee-test.de'
	const clientKeyJson = readEnv('OIDC_CLIENT_KEY')
	const clientKey = clientKeyJson ? parseClientKey(clientKeyJson) : null
	const clientId = readEnv('OIDC_CLIENT_ID') || clientKey?.subject || ''
	const clientSecret = clientKey ? '' : readEnv('OIDC_CLIENT_SECRET')
	const requiredRole = readEnv('OIDC_REQUIRED_ROLE') || klassenConfig().authRole
	const sessionSecret = readEnv('SESSION_SECRET')
	const projectId = readEnv('ZITADEL_PROJECT_ID')
	const orgId = readEnv('ZITADEL_ORG_ID')

	const missing = [
		clientId ? null : 'OIDC_CLIENT_ID',
		clientKey || clientSecret ? null : 'OIDC_CLIENT_KEY',
		sessionSecret ? null : 'SESSION_SECRET',
	].filter(Boolean)

	if (clientKey && clientKey.subject !== clientId) {
		throw new OidcConfigError(
			`OIDC_CLIENT_KEY gehoert zu Client ${clientKey.subject}, OIDC_CLIENT_ID ist ${clientId}`,
		)
	}

	if (missing.length > 0) {
		throw new OidcConfigError(
			`Anmeldung nicht konfiguriert, es fehlt: ${missing.join(', ')}`,
		)
	}

	cachedConfig = {
		issuer: issuer.replace(/\/$/, ''),
		clientId,
		clientKey,
		clientSecret,
		requiredRole,
		sessionKey: new Uint8Array(
			createHash('sha256').update(sessionSecret).digest(),
		),
		roleScope: {
			...(projectId ? { projectId } : {}),
			...(orgId ? { orgId } : {}),
		},
		scopes: [
			...BASE_SCOPES,
			...(projectId
				? [projectAudienceScope(projectId), PROJECTS_ROLES_SCOPE]
				: []),
		].join(' '),
	}
	return cachedConfig
}

const parseClientKey = (json: string): ZitadelKey => {
	try {
		return parseZitadelKey(json, 'OIDC_CLIENT_KEY', 'application')
	} catch (error) {
		throw new OidcConfigError((error as Error).message)
	}
}

export const resetOidcConfig = (): void => {
	cachedConfig = null
	refreshInFlight.clear()
}

const parseCookies = (header: string | null): Record<string, string> => {
	const result: Record<string, string> = {}
	if (!header) return result
	for (const part of header.split(';')) {
		const index = part.indexOf('=')
		if (index < 0) continue
		const name = part.slice(0, index).trim()
		if (!name) continue
		result[name] = decodeURIComponent(part.slice(index + 1).trim())
	}
	return result
}

const serializeCookie = (
	name: string,
	value: string,
	options: { maxAge: number; secure: boolean },
): string => {
	const parts = [
		`${name}=${encodeURIComponent(value)}`,
		'Path=/',
		'HttpOnly',
		'SameSite=Lax',
		`Max-Age=${options.maxAge}`,
	]
	if (options.secure) parts.push('Secure')
	return parts.join('; ')
}

const expireCookie = (name: string, secure: boolean): string =>
	[
		`${name}=`,
		'Path=/',
		'HttpOnly',
		'SameSite=Lax',
		'Max-Age=0',
		'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
		...(secure ? ['Secure'] : []),
	].join('; ')

export interface Session {
	id: string
	sub: string
	email: string
	name: string
	roles: string[]
}

const toSession = (session: AuthSession): Session => ({
	id: session.id,
	sub: session.sub,
	email: session.email,
	name: session.name,
	roles: session.roles,
})

const sealSessionHandle = (
	handle: string,
	expiresAt: number,
	key: Uint8Array,
): Promise<string> =>
	new EncryptJWT({ session: handle })
		.setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
		.setIssuedAt()
		.setExpirationTime(expiresAt)
		.encrypt(key)

const openSessionHandle = async (
	value: string,
	key: Uint8Array,
): Promise<string | null> => {
	if (!value) return null
	try {
		const { payload } = await jwtDecrypt(value, key)
		return typeof payload.session === 'string' ? payload.session : null
	} catch {
		return null
	}
}

const base64url = (buffer: Buffer): string => buffer.toString('base64url')

const randomToken = (): string => base64url(randomBytes(32))

const challengeFor = (verifier: string): string =>
	base64url(createHash('sha256').update(verifier).digest())

const basicAuth = (clientId: string, clientSecret: string): string =>
	`Basic ${Buffer.from(
		`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
	).toString('base64')}`

const safeReturnTo = (value: string | null | undefined): string => {
	if (!value) return '/'
	if (!value.startsWith('/')) return '/'
	if (value.startsWith('//')) return '/'
	return value
}

const publicOrigin = (request: Request): string => {
	const configured = readEnv('OIDC_PUBLIC_ORIGIN')
	if (configured) return configured.replace(/\/$/, '')

	const first = (name: string): string | undefined =>
		request.headers.get(name)?.split(',')[0]?.trim() || undefined

	const url = new URL(request.url)
	const host = first('x-forwarded-host') ?? first('host')
	if (host) {
		const proto = first('x-forwarded-proto') ?? url.protocol.replace(':', '')
		return `${proto}://${host}`
	}
	return url.origin
}

const isSecureOrigin = (origin: string): boolean =>
	origin.startsWith('https://')

const redirectUriFor = (request: Request): string =>
	`${publicOrigin(request)}/auth/callback`

const htmlResponse = (
	html: string,
	status: number,
	headers: HeadersInit = {},
) =>
	new Response(html, {
		status,
		headers: { 'Content-Type': 'text/html; charset=utf-8', ...headers },
	})

const wantsHtml = (request: Request): boolean =>
	request.method === 'GET' &&
	(request.headers.get('Accept') ?? '').includes('text/html')

const page = (title: string, body: string): string => `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
         margin: 0; padding: 3rem 1.5rem; background: #f8f8f7; color: #1f2328; }
  main { max-width: 34rem; margin: 0 auto; background: #fff; border-radius: 12px;
         padding: 2rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  h1 { font-size: 1.4rem; margin-top: 0; }
  p { line-height: 1.6; }
  a.button, button { display: inline-block; margin-top: 1rem; padding: .6rem 1.1rem;
         border: 0; border-radius: 8px; background: #1f6feb; color: #fff;
         text-decoration: none; font-size: 1rem; cursor: pointer; }
  code { background: #f0f0ef; padding: .1rem .3rem; border-radius: 4px; }
</style>
</head>
<body><main>${body}</main></body>
</html>`

export const notAMemberPage = (
	email: string,
	siteOwner: string,
	contactMail: string,
): string =>
	page(
		'Kein Zugriff',
		`<h1>Das hier ist die Seite von ${escapeHtml(siteOwner)}</h1>
     <p>Du bist mit der E-Mail-Adresse <code>${escapeHtml(email)}</code> angemeldet
        und hast für diese Klasse keinen Zugriff.</p>
     <p>Ist Dein Kind in einer anderen Klasse, dann ist diese Meldung richtig:
        Du hast den Link einer fremden Klasse. Jede Klasse hat ihre eigene Seite
        unter ihrer eigenen Adresse.</p>
     <p>Gehört Dein Kind in diese Klasse? Dann schreibe an
        <a href="mailto:${escapeHtml(contactMail)}">${escapeHtml(contactMail)}</a>,
        damit Du freigeschaltet wirst. Gib dabei bitte die oben genannte
        E-Mail-Adresse an.</p>
     <p>Mit dem falschen Konto angemeldet?</p>
     <a class="button" href="/auth/logout">Abmelden</a>`,
	)

const errorPage = (headline: string, detail: string): string =>
	page(
		'Anmeldung fehlgeschlagen',
		`<h1>${escapeHtml(headline)}</h1>
     <p>${escapeHtml(detail)}</p>
     <a class="button" href="/">Noch einmal versuchen</a>`,
	)

const escapeHtml = (value: string): string =>
	value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;')

interface PendingLogin extends JWTPayload {
	state: string
	nonce: string
	verifier: string
	returnTo: string
}

export const startLogin = async (
	request: Request,
	returnTo: string,
): Promise<Response> => {
	const config = getOidcConfig()
	const origin = publicOrigin(request)
	const secure = isSecureOrigin(origin)
	const discovery = await discover(config.issuer)

	const state = randomToken()
	const nonce = randomToken()
	const verifier = randomToken()

	const pending: PendingLogin = {
		state,
		nonce,
		verifier,
		returnTo: safeReturnTo(returnTo),
	}
	const cookieValue = await new EncryptJWT(pending)
		.setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
		.setIssuedAt()
		.setExpirationTime(`${STATE_MAX_AGE_SECONDS}s`)
		.encrypt(config.sessionKey)

	const authorize = new URL(discovery.authorization_endpoint)
	authorize.searchParams.set('client_id', config.clientId)
	authorize.searchParams.set('response_type', 'code')
	authorize.searchParams.set('scope', config.scopes)
	authorize.searchParams.set('redirect_uri', redirectUriFor(request))
	authorize.searchParams.set('state', state)
	authorize.searchParams.set('nonce', nonce)
	authorize.searchParams.set('code_challenge', challengeFor(verifier))
	authorize.searchParams.set('code_challenge_method', 'S256')

	return new Response(null, {
		status: 302,
		headers: {
			Location: authorize.toString(),
			'Set-Cookie': serializeCookie(
				`${STATE_COOKIE_PREFIX}${state.slice(0, 16)}`,
				cookieValue,
				{ maxAge: STATE_MAX_AGE_SECONDS, secure },
			),
		},
	})
}

interface TokenResponse {
	id_token?: string
	access_token?: string
	refresh_token?: string
	expires_in?: number
	error?: string
	error_description?: string
}

const CLIENT_ASSERTION_TYPE =
	'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

export const clientAuthentication = async (
	config: OidcConfig,
): Promise<{
	headers: Record<string, string>
	params: Record<string, string>
}> => {
	if (config.clientKey) {
		return {
			headers: {},
			params: {
				client_id: config.clientId,
				client_assertion_type: CLIENT_ASSERTION_TYPE,
				client_assertion: await signAssertion(config.clientKey, config.issuer),
			},
		}
	}
	return {
		headers: { Authorization: basicAuth(config.clientId, config.clientSecret) },
		params: {},
	}
}

const postToIdp = async (
	config: OidcConfig,
	endpoint: string,
	body: Record<string, string>,
): Promise<Response> => {
	const auth = await clientAuthentication(config)
	return fetch(endpoint, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json',
			...auth.headers,
		},
		body: new URLSearchParams({ ...body, ...auth.params }).toString(),
	})
}

const exchange = async (
	config: OidcConfig,
	discovery: Discovery,
	body: Record<string, string>,
): Promise<TokenResponse> => {
	const response = await postToIdp(config, discovery.token_endpoint, body)
	return (await response.json()) as TokenResponse
}

const verifyIdToken = async (
	config: OidcConfig,
	discovery: Discovery,
	idToken: string,
	nonce?: string,
): Promise<JWTPayload> => {
	const { payload } = await jwtVerify(
		idToken,
		remoteKeySet(discovery.jwks_uri),
		{ issuer: config.issuer, audience: config.clientId },
	)
	if (nonce && payload.nonce !== nonce) {
		throw new Error('nonce stimmt nicht')
	}
	return payload
}

const rolesFromUserinfo = async (
	config: OidcConfig,
	discovery: Discovery,
	accessToken: string | undefined,
	sub: string,
): Promise<string[]> => {
	if (!discovery.userinfo_endpoint || !accessToken) return []
	const response = await fetch(discovery.userinfo_endpoint, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: 'application/json',
		},
	})
	if (!response.ok) {
		throw new Error(`Userinfo antwortete mit HTTP ${response.status}`)
	}
	const claims = (await response.json()) as Record<string, unknown>
	if (claims.sub !== sub) throw new Error('Userinfo gehoert zu jemand anderem')
	return rolesFromClaims(claims, config.roleScope)
}

type TokenIdentity = {
	sub: string
	sid: string | null
	email: string
	name: string
	roles: string[]
}

const identityFromTokens = async (
	config: OidcConfig,
	discovery: Discovery,
	tokens: TokenResponse & { id_token: string },
	nonce?: string,
): Promise<TokenIdentity> => {
	const claims = await verifyIdToken(config, discovery, tokens.id_token, nonce)
	const sub = String(claims.sub ?? '')
	if (!sub) throw new Error('ID-Token ohne sub')
	// ZITADEL omits the roles claim from the ID token unless idTokenRoleAssertion is on; userinfo always has it.
	const roles = hasRolesClaim(claims, config.roleScope)
		? rolesFromClaims(claims, config.roleScope)
		: await rolesFromUserinfo(config, discovery, tokens.access_token, sub)
	return {
		sub,
		sid: typeof claims.sid === 'string' && claims.sid ? claims.sid : null,
		email: String(claims.email ?? ''),
		name: String(claims.name ?? ''),
		roles,
	}
}

const accessExpiresAt = (tokens: TokenResponse, now: number): number => {
	const lifetime = Number(tokens.expires_in)
	return (
		now +
		(Number.isFinite(lifetime) && lifetime > 0
			? lifetime
			: DEFAULT_ACCESS_LIFETIME_SECONDS)
	)
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

export const handleCallback = async (request: Request): Promise<Response> => {
	const config = getOidcConfig()
	const url = new URL(request.url)
	const secure = isSecureOrigin(publicOrigin(request))
	const cookies = parseCookies(request.headers.get('Cookie'))

	const idpError = url.searchParams.get('error')
	if (idpError) {
		return htmlResponse(
			errorPage(
				'Die Anmeldung wurde abgebrochen',
				url.searchParams.get('error_description') || idpError,
			),
			400,
		)
	}

	const state = url.searchParams.get('state')
	const code = url.searchParams.get('code')
	if (!state || !code) {
		return htmlResponse(
			errorPage(
				'Unvollständige Antwort',
				'Der Anmeldedienst hat keinen Code geschickt.',
			),
			400,
		)
	}

	const cookieName = `${STATE_COOKIE_PREFIX}${state.slice(0, 16)}`
	const pendingCookie = cookies[cookieName]
	if (!pendingCookie) {
		return startLogin(request, '/')
	}

	let pending: PendingLogin
	try {
		const { payload } = await jwtDecrypt(pendingCookie, config.sessionKey)
		pending = payload as PendingLogin
	} catch {
		return startLogin(request, '/')
	}

	if (pending.state !== state) {
		return htmlResponse(
			errorPage(
				'Sicherheitsprüfung fehlgeschlagen',
				'Der Anmeldevorgang passt nicht zu diesem Browser.',
			),
			400,
		)
	}

	const discovery = await discover(config.issuer)
	const tokens = await exchange(config, discovery, {
		grant_type: 'authorization_code',
		code,
		redirect_uri: redirectUriFor(request),
		code_verifier: pending.verifier,
	})

	const idToken = tokens.id_token
	if (!idToken) {
		return htmlResponse(
			errorPage(
				'Anmeldung fehlgeschlagen',
				tokens.error_description || tokens.error || 'Kein ID-Token erhalten.',
			),
			502,
		)
	}

	let identity: TokenIdentity
	try {
		identity = await identityFromTokens(
			config,
			discovery,
			{ ...tokens, id_token: idToken },
			pending.nonce,
		)
	} catch (error) {
		return htmlResponse(
			errorPage(
				'Anmeldung fehlgeschlagen',
				`Das Token war nicht gültig: ${String(error)}`,
			),
			502,
		)
	}

	const now = nowSeconds()
	const expiresAt = now + SESSION_MAX_AGE_SECONDS
	const { handle } = createAuthSession({
		...identity,
		refreshToken: tokens.refresh_token ?? null,
		accessExpiresAt: accessExpiresAt(tokens, now),
		expiresAt,
	})
	const sessionCookie = await sealSessionHandle(
		handle,
		expiresAt,
		config.sessionKey,
	)

	const headers = new Headers({ Location: safeReturnTo(pending.returnTo) })
	headers.append(
		'Set-Cookie',
		serializeCookie(SESSION_COOKIE, sessionCookie, {
			maxAge: SESSION_MAX_AGE_SECONDS,
			secure,
		}),
	)
	headers.append('Set-Cookie', expireCookie(cookieName, secure))
	return new Response(null, { status: 302, headers })
}

const revokeAtIdp = async (
	config: OidcConfig,
	refreshToken: string,
): Promise<void> => {
	try {
		const discovery = await discover(config.issuer)
		if (!discovery.revocation_endpoint) return
		await postToIdp(config, discovery.revocation_endpoint, {
			token: refreshToken,
			token_type_hint: 'refresh_token',
		})
	} catch (error) {
		console.warn(
			`[anmeldung] Refresh-Token nicht widerrufen: ${(error as Error).message}`,
		)
	}
}

export const handleLogout = async (request: Request): Promise<Response> => {
	const origin = publicOrigin(request)
	const secure = isSecureOrigin(origin)
	let target = `${origin}/`

	try {
		const config = getOidcConfig()
		const handle = await openSessionHandle(
			parseCookies(request.headers.get('Cookie'))[SESSION_COOKIE] ?? '',
			config.sessionKey,
		)
		if (handle) {
			const session = activeAuthSession(handle)
			deleteAuthSession(authSessionId(handle))
			if (session?.refreshToken) {
				await revokeAtIdp(config, session.refreshToken)
			}
		}
		const discovery = await discover(config.issuer)
		if (discovery.end_session_endpoint) {
			const endSession = new URL(discovery.end_session_endpoint)
			endSession.searchParams.set('client_id', config.clientId)
			endSession.searchParams.set('post_logout_redirect_uri', `${origin}/`)
			target = endSession.toString()
		}
	} catch (error) {
		console.warn(
			`[anmeldung] Abmelden unvollstaendig: ${(error as Error).message}`,
		)
	}

	return new Response(null, {
		status: 302,
		headers: {
			Location: target,
			'Set-Cookie': expireCookie(SESSION_COOKIE, secure),
		},
	})
}

const noStore = { 'Cache-Control': 'no-store' }

export const handleBackchannelLogout = async (
	request: Request,
): Promise<Response> => {
	const config = getOidcConfig()
	let token = ''
	try {
		const form = new URLSearchParams(await request.text())
		token = form.get('logout_token') ?? ''
	} catch {}
	if (!token) {
		return Response.json(
			{ error: 'invalid_request', error_description: 'logout_token fehlt' },
			{ status: 400, headers: noStore },
		)
	}
	try {
		const discovery = await discover(config.issuer)
		const target = await verifyLogoutToken(token, {
			issuer: config.issuer,
			audience: config.clientId,
			keys: remoteKeySet(discovery.jwks_uri),
		})
		const revoked = applyLogout(target)
		console.log(
			`[backchannel-logout] ${revoked} Sitzung(en) beendet (${target.sid ? `sid ${target.sid}` : `sub ${target.sub}`})`,
		)
		return new Response(null, { status: 200, headers: noStore })
	} catch (error) {
		if (error instanceof LogoutTokenError) {
			console.warn(`[backchannel-logout] ${error.message}`)
			return Response.json(
				{ error: 'invalid_request', error_description: error.message },
				{ status: 400, headers: noStore },
			)
		}
		throw error
	}
}

const refreshInFlight = new Map<string, Promise<AuthSession | null>>()

const exchangeRefreshToken = async (
	config: OidcConfig,
	session: AuthSession,
): Promise<AuthSession | null> => {
	if (!session.refreshToken) return null
	const discovery = await discover(config.issuer)
	const tokens = await exchange(config, discovery, {
		grant_type: 'refresh_token',
		refresh_token: session.refreshToken,
		scope: config.scopes,
	})
	const idToken = tokens.id_token
	if (!idToken) return null
	const identity = await identityFromTokens(config, discovery, {
		...tokens,
		id_token: idToken,
	})
	if (identity.sub !== session.sub) return null
	const refresh = {
		email: identity.email || session.email,
		name: identity.name || session.name,
		roles: identity.roles,
		refreshToken: tokens.refresh_token ?? session.refreshToken,
		accessExpiresAt: accessExpiresAt(tokens, nowSeconds()),
	}
	if (!updateAuthSession(session.id, refresh)) return null
	return { ...session, ...refresh }
}

const refreshAuthSession = (
	config: OidcConfig,
	session: AuthSession,
): Promise<AuthSession | null> => {
	const running = refreshInFlight.get(session.id)
	if (running) return running
	const result = exchangeRefreshToken(config, session)
		.catch((error: unknown) => {
			console.warn(
				`[anmeldung] Verlaengerung fuer ${session.sub} fehlgeschlagen: ${(error as Error).message}`,
			)
			return null
		})
		.finally(() => refreshInFlight.delete(session.id))
	refreshInFlight.set(session.id, result)
	return result
}

export interface SessionOutcome {
	state: 'unauthenticated' | 'unauthorized' | 'ok'
	session: Session | null
}

export interface AuthOutcome {
	response: Response | null
	session: Session | null
}

const unauthenticated = async (request: Request): Promise<Response> => {
	const url = new URL(request.url)
	if (!wantsHtml(request)) {
		return new Response('Unauthorized', {
			status: 401,
			headers: { 'WWW-Authenticate': 'Bearer' },
		})
	}
	return startLogin(request, `${url.pathname}${url.search}`)
}

export const resolveSession = async (
	request: Request,
): Promise<SessionOutcome> => {
	const config = getOidcConfig()
	const cookies = parseCookies(request.headers.get('Cookie'))

	const handle = await openSessionHandle(
		cookies[SESSION_COOKIE] ?? '',
		config.sessionKey,
	)
	let session = handle ? activeAuthSession(handle) : null
	if (!session) {
		return { state: 'unauthenticated', session: null }
	}

	if (nowSeconds() >= session.accessExpiresAt - REFRESH_LEEWAY_SECONDS) {
		const refreshed = await refreshAuthSession(config, session)
		if (!refreshed) {
			deleteAuthSession(session.id)
			return { state: 'unauthenticated', session: null }
		}
		session = refreshed
	}

	if (!canRead(session.roles, config.requiredRole)) {
		return { state: 'unauthorized', session: toSession(session) }
	}

	return { state: 'ok', session: toSession(session) }
}

export const authenticate = async (
	request: Request,
	options: { siteOwner: string; contactMail: string },
): Promise<AuthOutcome> => {
	const outcome = await resolveSession(request)

	if (outcome.state === 'unauthenticated') {
		return { response: await unauthenticated(request), session: null }
	}

	if (outcome.state === 'unauthorized') {
		return {
			response: new Response(
				notAMemberPage(
					outcome.session?.email ?? '',
					options.siteOwner,
					options.contactMail,
				),
				{
					status: 403,
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				},
			),
			session: null,
		}
	}

	return { response: null, session: outcome.session }
}

export { SESSION_COOKIE }
