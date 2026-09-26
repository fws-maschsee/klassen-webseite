import type { IncomingMessage, ServerResponse } from 'node:http'
import type { APIContext, MiddlewareHandler } from 'astro'
import type { KlassenConfig } from '../../src/klasse/config.ts'
import { createKlassenMiddleware } from '../../src/klasse/middleware.ts'
import { GET as authCallback } from '../../src/routes/auth/callback.ts'
import { GET as authLogin } from '../../src/routes/auth/login.ts'
import {
	GET as authLogoutGet,
	POST as authLogoutPost,
} from '../../src/routes/auth/logout.ts'
import { GET as healthRoute } from '../../src/routes/health.ts'

// Unverwechselbar statt Status 200: auch eine Fehlerseite kann mit 200 kommen.
export const GESCHUETZTER_INHALT = 'Klasseninterner Inhalt dieser Testklasse'

type Weiter = () => Promise<Response>

type Route = (kontext: {
	request: Request
	url: URL
	locals: App.Locals
}) => Response | Promise<Response>

const ROUTEN: Record<string, Route> = {
	'/auth/login': (kontext) => authLogin(kontext as unknown as APIContext),
	'/auth/callback': (kontext) => authCallback(kontext as unknown as APIContext),
	'/auth/logout': (kontext) =>
		kontext.request.method === 'POST'
			? authLogoutPost(kontext as unknown as APIContext)
			: authLogoutGet(kontext as unknown as APIContext),
	'/public/health': (kontext) => healthRoute(kontext as unknown as APIContext),
}

const geschuetzteSeite = (locals: App.Locals): Response =>
	new Response(
		`<!DOCTYPE html><html lang="de"><body><h1>${GESCHUETZTER_INHALT}</h1>` +
			`<p data-angemeldet-als="${locals.user?.email ?? ''}">${locals.user?.email ?? ''}</p>` +
			`</body></html>`,
		{ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
	)

const koerperLesen = async (req: IncomingMessage): Promise<Buffer> => {
	const teile: Buffer[] = []
	for await (const teil of req) teile.push(teil as Buffer)
	return Buffer.concat(teile)
}

const alsRequest = async (req: IncomingMessage): Promise<Request> => {
	const url = new URL(
		req.url ?? '/',
		`http://${req.headers.host ?? 'localhost'}`,
	)
	const kopfzeilen = new Headers()
	for (const [name, wert] of Object.entries(req.headers)) {
		if (wert === undefined) continue
		if (Array.isArray(wert))
			for (const eins of wert) kopfzeilen.append(name, eins)
		else kopfzeilen.set(name, wert)
	}
	const ohneKoerper = req.method === 'GET' || req.method === 'HEAD'
	return new Request(url, {
		method: req.method,
		headers: kopfzeilen,
		// `BodyInit` kennt keinen Buffer; `Uint8Array` ist dieselbe Sicht ohne Kopie.
		body: ohneKoerper ? undefined : new Uint8Array(await koerperLesen(req)),
	})
}

const antwortSchreiben = async (
	antwort: Response,
	res: ServerResponse,
): Promise<void> => {
	res.statusCode = antwort.status
	for (const [name, wert] of antwort.headers) {
		// Beim Iterieren fasst `Headers` mehrere Set-Cookie zu einem kaputten Wert zusammen.
		if (name.toLowerCase() === 'set-cookie') continue
		res.setHeader(name, wert)
	}
	const cookies = antwort.headers.getSetCookie()
	if (cookies.length > 0) res.setHeader('set-cookie', cookies)
	res.end(Buffer.from(await antwort.arrayBuffer()))
}

let middleware: MiddlewareHandler | null = null

// Konfiguration über globalThis: `startServer()` lädt den Entry per `import()` ohne Argumente.
declare global {
	var __fwsAttrappenConfig: KlassenConfig | undefined
}

export const handler = (
	req: IncomingMessage,
	res: ServerResponse,
	next?: (fehler?: unknown) => void,
): void => {
	void (async () => {
		try {
			const config = globalThis.__fwsAttrappenConfig
			if (!config) {
				throw new Error(
					'Keine KlassenConfig für die Astro-Attrappe hinterlegt — `globalThis.__fwsAttrappenConfig` setzen, bevor der Server startet.',
				)
			}
			if (!middleware) middleware = createKlassenMiddleware(config)

			const request = await alsRequest(req)
			const url = new URL(request.url)
			const locals: App.Locals = {}
			const route = ROUTEN[url.pathname]

			const weiter: Weiter = async () =>
				route ? await route({ request, url, locals }) : geschuetzteSeite(locals)

			const antwort = await middleware(
				{ request, url, locals } as unknown as APIContext,
				weiter as never,
			)
			await antwortSchreiben(antwort as Response, res)
		} catch (fehler) {
			if (next) next(fehler)
			else {
				res.statusCode = 500
				res.end(String(fehler))
			}
		}
	})()
}
