import { discover } from './discovery.ts'
import {
	parseZitadelKey,
	signAssertion,
	type ZitadelKey,
} from './zitadelKey.ts'

export class GrantsConfigError extends Error {}

export class GrantsUnavailableError extends Error {}

const readEnv = (name: string): string => (process.env[name] ?? '').trim()

export type ServiceCredential =
	| { kind: 'key'; key: ZitadelKey }
	| { kind: 'pat'; token: string }

export type GrantsConfig = {
	issuer: string
	orgId: string
	projectId: string
	credential: ServiceCredential
}

const UNAVAILABLE =
	'Kontoliste nicht verfuegbar: kein Dienstzugang zu ZITADEL konfiguriert'

export const serviceAccessConfigured = (): boolean =>
	Boolean(readEnv('ZITADEL_SERVICE_KEY') || readEnv('ZITADEL_SERVICE_TOKEN'))

let cachedConfig: GrantsConfig | null = null

export const getGrantsConfig = (): GrantsConfig => {
	if (cachedConfig) return cachedConfig
	const issuer =
		readEnv('ZITADEL_ISSUER') ||
		readEnv('OIDC_ISSUER') ||
		'https://id.fws-maschsee-test.de'
	const orgId = readEnv('ZITADEL_ORG_ID')
	const projectId = readEnv('ZITADEL_PROJECT_ID')
	const keyJson = readEnv('ZITADEL_SERVICE_KEY')
	const pat = readEnv('ZITADEL_SERVICE_TOKEN')

	if (!keyJson && !pat) {
		throw new GrantsConfigError(`${UNAVAILABLE} (ZITADEL_SERVICE_KEY fehlt)`)
	}
	const missing = [
		orgId ? null : 'ZITADEL_ORG_ID',
		projectId ? null : 'ZITADEL_PROJECT_ID',
	].filter(Boolean)
	if (missing.length > 0) {
		throw new GrantsConfigError(
			`${UNAVAILABLE}, es fehlt: ${missing.join(', ')}`,
		)
	}
	let credential: ServiceCredential
	if (keyJson) {
		try {
			credential = {
				kind: 'key',
				key: parseZitadelKey(keyJson, 'ZITADEL_SERVICE_KEY', 'serviceaccount'),
			}
		} catch (error) {
			throw new GrantsConfigError((error as Error).message)
		}
	} else {
		credential = { kind: 'pat', token: pat }
	}
	cachedConfig = {
		issuer: issuer.replace(/\/$/, ''),
		orgId,
		projectId,
		credential,
	}
	return cachedConfig
}

export const resetGrantsConfig = (): void => {
	cachedConfig = null
	cache = null
	accessToken = null
	probe = null
}

// ZITADEL only accepts tokens for its own APIs when they carry the zitadel audience scope.
const TOKEN_SCOPE = 'openid urn:zitadel:iam:org:project:id:zitadel:aud'

const TOKEN_RENEW_BEFORE_SECONDS = 60

let accessToken: { token: string; expiresAt: number } | null = null

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

const exchangeServiceKey = async (config: GrantsConfig): Promise<string> => {
	if (config.credential.kind !== 'key') return config.credential.token
	let response: Response
	try {
		const discovery = await discover(config.issuer)
		response = await fetch(discovery.token_endpoint, {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'application/json',
			},
			body: new URLSearchParams({
				grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
				scope: TOKEN_SCOPE,
				assertion: await signAssertion(config.credential.key, config.issuer),
			}).toString(),
		})
	} catch (error) {
		throw new GrantsUnavailableError(
			`ZITADEL nicht erreichbar: ${(error as Error).message}`,
		)
	}
	const body = (await response.json().catch(() => ({}))) as {
		access_token?: string
		expires_in?: number
		error?: string
		error_description?: string
	}
	if (!response.ok || !body.access_token) {
		const message =
			`Token-Tausch mit ZITADEL_SERVICE_KEY fehlgeschlagen: HTTP ${response.status} ${body.error_description ?? body.error ?? ''}`.trim()
		console.error(`[dienstzugang] ${message}`)
		throw new GrantsUnavailableError(message)
	}
	const lifetime = Number(body.expires_in)
	accessToken = {
		token: body.access_token,
		expiresAt:
			nowSeconds() +
			(Number.isFinite(lifetime) && lifetime > 0 ? lifetime : 300),
	}
	return body.access_token
}

const bearerToken = async (config: GrantsConfig): Promise<string> => {
	if (config.credential.kind === 'pat') return config.credential.token
	if (
		accessToken &&
		nowSeconds() < accessToken.expiresAt - TOKEN_RENEW_BEFORE_SECONDS
	) {
		return accessToken.token
	}
	return exchangeServiceKey(config)
}

const post = async <T>(pfad: string, rumpf: unknown): Promise<T> => {
	const config = getGrantsConfig()
	const send = async (token: string): Promise<Response> => {
		try {
			return await fetch(`${config.issuer}${pfad}`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'x-zitadel-orgid': config.orgId,
					'content-type': 'application/json',
				},
				body: JSON.stringify(rumpf),
			})
		} catch (error) {
			throw new GrantsUnavailableError(
				`ZITADEL nicht erreichbar: ${(error as Error).message}`,
			)
		}
	}
	let response = await send(await bearerToken(config))
	if (response.status === 401 && config.credential.kind === 'key') {
		accessToken = null
		response = await send(await bearerToken(config))
	}
	if (!response.ok) {
		throw new GrantsUnavailableError(
			`ZITADEL antwortete mit HTTP ${response.status}`,
		)
	}
	return (await response.json()) as T
}

type Authorization = {
	project?: { id?: string }
	state?: string
	roles?: { key?: string }[]
	user?: { id?: string; preferredLoginName?: string }
}

export const LIST_AUTHORIZATIONS_PATH =
	'/zitadel.authorization.v2.AuthorizationService/ListAuthorizations'

type GrantRow = {
	userId: string
	email: string
	roleKeys: string[]
}

const PAGE_SIZE = 200

const MAX_PAGES = 50

const listAuthorizations = async (
	projectId: string,
	maxRows = PAGE_SIZE * MAX_PAGES,
): Promise<Authorization[]> => {
	const rows: Authorization[] = []
	for (let page = 0; page < MAX_PAGES && rows.length < maxRows; page++) {
		const limit = Math.min(PAGE_SIZE, maxRows - rows.length)
		const body = await post<{
			authorizations?: Authorization[]
			pagination?: { totalResult?: string | number }
		}>(LIST_AUTHORIZATIONS_PATH, {
			pagination: { offset: rows.length, limit, asc: true },
			filters: [{ projectId: { id: projectId } }],
		})
		const batch = body.authorizations ?? []
		rows.push(...batch)
		const total = Number(body.pagination?.totalResult ?? rows.length)
		if (batch.length < limit || rows.length >= total) break
	}
	return rows
}

const loginEmail = (name: string | undefined): string => {
	const value = (name ?? '').trim().toLowerCase()
	return value.includes('@') ? value : ''
}

const toGrantRow =
	(projectId: string) =>
	(row: Authorization): GrantRow[] => {
		const userId = row.user?.id
		if (!userId) return []
		// v1 ignored the project filter for PROJECT_OWNER_VIEWER; checking again keeps foreign grants out if v2 ever does too.
		if (row.project?.id !== projectId) return []
		if ((row.state ?? 'STATE_ACTIVE') !== 'STATE_ACTIVE') return []
		return [
			{
				userId,
				email: loginEmail(row.user?.preferredLoginName),
				roleKeys: (row.roles ?? []).flatMap((role) =>
					role.key ? [role.key] : [],
				),
			},
		]
	}

const CACHE_TTL_MS = 5000
let cache: { at: number; rows: GrantRow[] } | null = null

const projectGrants = async (): Promise<GrantRow[]> => {
	if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows
	const config = getGrantsConfig()
	const rows = (await listAuthorizations(config.projectId)).flatMap(
		toGrantRow(config.projectId),
	)
	cache = { at: Date.now(), rows }
	return rows
}

export const rolesForUser = async (userId: string): Promise<string[]> => {
	if (!userId) return []
	const rows = await projectGrants()
	return [
		...new Set(
			rows
				.filter((row) => row.userId === userId)
				.flatMap((row) => row.roleKeys),
		),
	]
}

export type GrantedAccount = {
	userId: string
	email: string
	roles: string[]
}

export const grantedAccounts = async (): Promise<GrantedAccount[]> => {
	const rows = await projectGrants()
	const byUser = new Map<string, GrantedAccount>()
	for (const row of rows) {
		if (!row.userId) continue
		const email = (row.email ?? '').trim().toLowerCase()
		const vorhanden = byUser.get(row.userId)
		if (!vorhanden) {
			byUser.set(row.userId, {
				userId: row.userId,
				email,
				roles: [...new Set(row.roleKeys ?? [])],
			})
			continue
		}
		for (const rolle of row.roleKeys ?? []) {
			if (!vorhanden.roles.includes(rolle)) vorhanden.roles.push(rolle)
		}
		if (!vorhanden.email && email) vorhanden.email = email
	}
	return [...byUser.values()]
}

export type ServiceAccessStatus = {
	status: 'ok' | 'failing' | 'not_configured'
	credential: ServiceCredential['kind'] | null
	checkedAt: string | null
	error: string | null
}

const PROBE_TTL_MS = 5 * 60 * 1000

let probe: { at: number; result: Promise<ServiceAccessStatus> } | null = null

const runProbe = async (): Promise<ServiceAccessStatus> => {
	const checkedAt = new Date().toISOString()
	let kind: ServiceCredential['kind'] | null = null
	try {
		const config = getGrantsConfig()
		kind = config.credential.kind
		if (kind === 'key') accessToken = null
		await listAuthorizations(config.projectId, 1)
		return { status: 'ok', credential: kind, checkedAt: checkedAt, error: null }
	} catch (error) {
		const message = (error as Error).message
		console.error(`[dienstzugang] Pruefung fehlgeschlagen: ${message}`)
		return {
			status: 'failing',
			credential: kind,
			checkedAt: checkedAt,
			error: message,
		}
	}
}

export const serviceAccessStatus = (): Promise<ServiceAccessStatus> => {
	if (!serviceAccessConfigured()) {
		return Promise.resolve({
			status: 'not_configured',
			credential: null,
			checkedAt: null,
			error: null,
		})
	}
	if (!probe || Date.now() - probe.at >= PROBE_TTL_MS) {
		probe = { at: Date.now(), result: runProbe() }
	}
	return probe.result
}
