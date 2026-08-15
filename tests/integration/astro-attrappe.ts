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

/**
 * Steht für `dist/server/entry.mjs` aus dem Astro-Build einer Klasse — aber
 * nur für den BAU, nicht für den Inhalt.
 *
 * Was hier eine Attrappe ist: Astros Routenauflösung und das Rendern von
 * `.astro`-Dateien. Was hier ECHT ist und genau deshalb geprüft wird:
 *
 *   - `createKlassenMiddleware()` aus `src/klasse/middleware.ts`,
 *   - über sie `authenticate()` und `resolveSession()` aus
 *     `src/server/auth/oidc.ts`,
 *   - über die wiederum `rolesForUser()` aus `src/server/auth/grants.ts`,
 *   - die drei Anmelderouten und `/public/health` als die Module, die in
 *     `GETEILTE_ROUTEN` eingetragen sind.
 *
 * Der Grund für die Attrappe steht in `tests/fixtures/astro-entry.mjs` schon
 * für den Starttest: Ein echter Astro-Build ist eine zweite Toolchain. Hier
 * kommt ein zweiter Grund dazu — dieses Repository ist gar keine Astro-App. Es
 * ist der geteilte Code, den die Klassen als Submodule einbinden; `astro.config.mjs`
 * und `src/content/` liegen dort. Ein Build wäre also nicht bloss teuer, er
 * wäre der Build einer Anwendung, die es hier nicht gibt.
 *
 * Die Grenze ist damit klar gezogen: Alles vom Cookie bis zum Urteil ist echt,
 * das Aussehen der Seite dahinter nicht. Was die Attrappe NICHT beweisen kann,
 * steht in der README neben den fünf Nachweisen.
 */

/**
 * Der Satz, an dem ein Test erkennt, dass er wirklich hinter der Anmeldung
 * gelandet ist.
 *
 * Er ist absichtlich unverwechselbar: Ein Test, der auf „200" prüft, ist auch
 * dann grün, wenn die Anwendung eine Fehlerseite mit Status 200 ausliefert. Ein
 * Test, der DIESEN Satz sucht, ist es nicht.
 */
export const GESCHUETZTER_INHALT = 'Klasseninterner Inhalt dieser Testklasse'

/** Astros `next()` ohne Rewrite — mehr braucht die Middleware nicht. */
type Weiter = () => Promise<Response>

type Route = (kontext: {
	request: Request
	url: URL
	locals: App.Locals
}) => Response | Promise<Response>

/**
 * Die Routen, die in `GETEILTE_ROUTEN` stehen und für die Anmeldung zählen.
 *
 * Bewusst eine Tabelle und keine `if`-Kette: Die Regel „Astro ruft seine
 * Middleware nur für Pfade auf, zu denen es eine Route gibt" (siehe
 * `src/routes/auth/callback.ts`) ist der Grund, warum `/auth/callback`
 * überhaupt eine Datei ist. Eine Tabelle bildet genau das ab.
 */
const ROUTEN: Record<string, Route> = {
	'/auth/login': (kontext) => authLogin(kontext as unknown as APIContext),
	'/auth/callback': (kontext) => authCallback(kontext as unknown as APIContext),
	'/auth/logout': (kontext) =>
		kontext.request.method === 'POST'
			? authLogoutPost(kontext as unknown as APIContext)
			: authLogoutGet(kontext as unknown as APIContext),
	'/public/health': (kontext) => healthRoute(kontext as unknown as APIContext),
}

/** Die geschützte Seite — steht für alles, was hinter der Anmeldung liegt. */
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
		// `Uint8Array` und nicht `Buffer`: Der Typ von `BodyInit` kennt keinen
		// Buffer, und `new Uint8Array(...)` kopiert hier nichts — es ist
		// dieselbe Sicht auf denselben Speicher.
		body: ohneKoerper ? undefined : new Uint8Array(await koerperLesen(req)),
	})
}

const antwortSchreiben = async (
	antwort: Response,
	res: ServerResponse,
): Promise<void> => {
	res.statusCode = antwort.status
	for (const [name, wert] of antwort.headers) {
		// `Set-Cookie` NICHT über diese Schleife: Beim Iterieren fasst `Headers`
		// mehrere Cookies zu einem kommagetrennten Wert zusammen, und der Browser
		// sieht dann ein einziges, kaputtes Cookie. Der Rücksprung von ZITADEL
		// setzt genau zwei (Sitzung setzen, Anmeldevorgang abräumen) — hier wäre
		// also der erste Ort, an dem eine Attrappe still etwas anderes täte als
		// der Node-Adapter.
		if (name.toLowerCase() === 'set-cookie') continue
		res.setHeader(name, wert)
	}
	const cookies = antwort.headers.getSetCookie()
	if (cookies.length > 0) res.setHeader('set-cookie', cookies)
	res.end(Buffer.from(await antwort.arrayBuffer()))
}

let middleware: MiddlewareHandler | null = null

/**
 * Baut den Handler, den `startServer({ astroEntry })` lädt.
 *
 * Die Konfiguration kommt über `globalThis`, weil `startServer()` den Entry per
 * `import()` eines Dateipfads lädt — ein Argument gibt es auf diesem Weg nicht.
 * Genau so wenig hat der Astro-Build eines: Er bekommt seine Konfiguration über
 * die Integration.
 */
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
