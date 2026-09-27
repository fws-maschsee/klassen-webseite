import type { RequestHandler } from 'express'
import { migrateSessionCookie } from './auth/oidc.ts'
import { kopfAlsWebRequest } from './webRequest.ts'

export const sitzungsKeksUmziehen: RequestHandler = (req, res, next) => {
	if (req.headers.cookie === undefined) {
		next()
		return
	}
	const { cookieHeader, setCookies } = migrateSessionCookie(
		kopfAlsWebRequest(req),
	)
	if (setCookies.length > 0) {
		if (cookieHeader === null) delete req.headers.cookie
		else req.headers.cookie = cookieHeader
		for (const keks of setCookies) res.append('Set-Cookie', keks)
	}
	next()
}
