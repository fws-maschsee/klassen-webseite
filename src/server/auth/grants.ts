export class GrantsConfigError extends Error {}

export class GrantsUnavailableError extends Error {}

const readEnv = (name: string): string => (process.env[name] ?? '').trim()

export type GrantsConfig = {
	issuer: string
	orgId: string
	projectId: string
	token: string
}

let cachedConfig: GrantsConfig | null = null

export const getGrantsConfig = (): GrantsConfig => {
	if (cachedConfig) return cachedConfig
	const issuer =
		readEnv('ZITADEL_ISSUER') ||
		readEnv('OIDC_ISSUER') ||
		'https://id.fws-maschsee-test.de'
	const orgId = readEnv('ZITADEL_ORG_ID')
	const projectId = readEnv('ZITADEL_PROJECT_ID')
	const token = readEnv('ZITADEL_SERVICE_TOKEN')

	const missing = [
		orgId ? null : 'ZITADEL_ORG_ID',
		projectId ? null : 'ZITADEL_PROJECT_ID',
		token ? null : 'ZITADEL_SERVICE_TOKEN',
	].filter(Boolean)
	if (missing.length > 0) {
		throw new GrantsConfigError(
			`Berechtigungspruefung nicht konfiguriert, es fehlt: ${missing.join(', ')}`,
		)
	}
	cachedConfig = {
		issuer: issuer.replace(/\/$/, ''),
		orgId,
		projectId,
		token,
	}
	return cachedConfig
}

export const resetGrantsConfig = (): void => {
	cachedConfig = null
	cache = null
}

const ACTIVE_STATE = 'USER_GRANT_STATE_ACTIVE'

type GrantRow = {
	userId?: string
	email?: string
	roleKeys?: string[]
	state?: string
}

const isActive = (row: GrantRow): boolean =>
	(row.state ?? ACTIVE_STATE) === ACTIVE_STATE

const post = async <T>(pfad: string, rumpf: unknown): Promise<T> => {
	const config = getGrantsConfig()
	let response: Response
	try {
		response = await fetch(`${config.issuer}${pfad}`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${config.token}`,
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
	if (!response.ok) {
		throw new GrantsUnavailableError(
			`ZITADEL antwortete mit HTTP ${response.status}`,
		)
	}
	return (await response.json()) as T
}

const search = async (
	queries: unknown[],
	limit = 1000,
): Promise<GrantRow[]> => {
	const body = await post<{ result?: GrantRow[] }>(
		'/management/v1/users/grants/_search',
		{ query: { limit }, queries },
	)
	return body.result ?? []
}

const CACHE_TTL_MS = 5000
let cache: { at: number; rows: GrantRow[] } | null = null

const projectGrants = async (): Promise<GrantRow[]> => {
	if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows
	const config = getGrantsConfig()
	const rows = (
		await search([{ projectIdQuery: { projectId: config.projectId } }])
	).filter(isActive)
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
				.flatMap((row) => row.roleKeys ?? []),
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

export type KnownAccount = { userId: string; email: string }

export const knownAccounts = async (): Promise<KnownAccount[]> => {
	type UserRow = {
		id?: string
		userName?: string
		preferredLoginName?: string
		human?: { email?: { email?: string } }
	}
	const body = await post<{ result?: UserRow[] }>(
		'/management/v1/users/_search',
		{ query: { limit: 1000 } },
	)
	return (body.result ?? []).flatMap((row) => {
		if (!row.id) return []
		const email = (
			row.human?.email?.email ??
			row.preferredLoginName ??
			row.userName ??
			''
		)
			.trim()
			.toLowerCase()
		return [{ userId: row.id, email }]
	})
}
