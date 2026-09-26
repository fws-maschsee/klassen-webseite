import { createHash, randomBytes } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { dbTimestamp, openDb } from './index.ts'

export type AuthSession = {
	id: string
	sub: string
	sid: string | null
	email: string
	name: string
	roles: string[]
	refreshToken: string | null
	accessExpiresAt: number
	expiresAt: number
}

type AuthSessionRow = {
	id: string
	sub: string
	sid: string | null
	email: string
	name: string
	roles: string
	refresh_token: string | null
	access_expires_at: number
	expires_at: number
	revoked_at: string | null
}

export type NewAuthSession = Omit<AuthSession, 'id'>

export type SessionRefresh = {
	email: string
	name: string
	roles: string[]
	refreshToken: string | null
	accessExpiresAt: number
}

export const authSessionId = (handle: string): string =>
	createHash('sha256').update(handle).digest('hex')

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

const fromRow = (row: AuthSessionRow): AuthSession => ({
	id: row.id,
	sub: row.sub,
	sid: row.sid,
	email: row.email,
	name: row.name,
	roles: JSON.parse(row.roles) as string[],
	refreshToken: row.refresh_token,
	accessExpiresAt: row.access_expires_at,
	expiresAt: row.expires_at,
})

export const createAuthSession = (
	session: NewAuthSession,
	db: Database = openDb(),
): { handle: string; session: AuthSession } => {
	const handle = randomBytes(32).toString('base64url')
	const id = authSessionId(handle)
	db.prepare(
		`INSERT INTO auth_sessions
       (id, sub, sid, email, name, roles, refresh_token, access_expires_at, expires_at)
     VALUES
       (@id, @sub, @sid, @email, @name, @roles, @refresh_token, @access_expires_at, @expires_at)`,
	).run({
		id,
		sub: session.sub,
		sid: session.sid,
		email: session.email,
		name: session.name,
		roles: JSON.stringify(session.roles),
		refresh_token: session.refreshToken,
		access_expires_at: session.accessExpiresAt,
		expires_at: session.expiresAt,
	})
	return { handle, session: { id, ...session } }
}

export const activeAuthSession = (
	handle: string,
	db: Database = openDb(),
	now: number = nowSeconds(),
): AuthSession | null => {
	const row = db
		.prepare<[string], AuthSessionRow>(
			'SELECT * FROM auth_sessions WHERE id = ?',
		)
		.get(authSessionId(handle))
	if (!row || row.revoked_at !== null || row.expires_at <= now) return null
	return fromRow(row)
}

export const updateAuthSession = (
	id: string,
	refresh: SessionRefresh,
	db: Database = openDb(),
): boolean =>
	db
		.prepare(
			`UPDATE auth_sessions
          SET email = @email, name = @name, roles = @roles,
              refresh_token = @refresh_token, access_expires_at = @access_expires_at,
              refreshed_at = @refreshed_at
        WHERE id = @id AND revoked_at IS NULL`,
		)
		.run({
			id,
			email: refresh.email,
			name: refresh.name,
			roles: JSON.stringify(refresh.roles),
			refresh_token: refresh.refreshToken,
			access_expires_at: refresh.accessExpiresAt,
			refreshed_at: dbTimestamp(),
		}).changes > 0

export const deleteAuthSession = (
	id: string,
	db: Database = openDb(),
): boolean =>
	db.prepare<[string]>('DELETE FROM auth_sessions WHERE id = ?').run(id)
		.changes > 0

const revokeWhere = (where: string, value: string, db: Database): number =>
	db
		.prepare<[string, string]>(
			`UPDATE auth_sessions SET revoked_at = ?, refresh_token = NULL
        WHERE ${where} = ? AND revoked_at IS NULL`,
		)
		.run(dbTimestamp(), value).changes

export const revokeAuthSessionsBySub = (
	sub: string,
	db: Database = openDb(),
): number => revokeWhere('sub', sub, db)

export const revokeAuthSessionsBySid = (
	sid: string,
	db: Database = openDb(),
): number => revokeWhere('sid', sid, db)

export const subForSid = (
	sid: string,
	db: Database = openDb(),
): string | null =>
	db
		.prepare<[string], { sub: string }>(
			'SELECT sub FROM auth_sessions WHERE sid = ? LIMIT 1',
		)
		.get(sid)?.sub ?? null

export const expireAllAccessTokens = (db: Database = openDb()): number =>
	db
		.prepare(
			'UPDATE auth_sessions SET access_expires_at = 0 WHERE revoked_at IS NULL',
		)
		.run().changes

export const expireAccessTokensBySub = (
	sub: string,
	db: Database = openDb(),
): number =>
	db
		.prepare<[string]>(
			'UPDATE auth_sessions SET access_expires_at = 0 WHERE sub = ? AND revoked_at IS NULL',
		)
		.run(sub).changes

export const purgeAuthSessions = (
	db: Database = openDb(),
	now: Date = new Date(),
): number =>
	db
		.prepare<[number, string]>(
			`DELETE FROM auth_sessions
        WHERE expires_at <= ?
           OR (revoked_at IS NOT NULL AND revoked_at <= ?)`,
		)
		.run(
			Math.floor(now.getTime() / 1000),
			dbTimestamp(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)),
		).changes
