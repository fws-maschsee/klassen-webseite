import type { MiddlewareHandler } from 'astro'
import './locals.ts'
import { merkeAnmeldung } from '../lib/db/users.ts'
import {
	GrantsConfigError,
	GrantsUnavailableError,
} from '../server/auth/grants.ts'
import { authenticate, OidcConfigError } from '../server/auth/oidc.ts'
import {
	type KlassenConfig,
	klassenConfig,
	PUBLIC_PATHS,
	setKlassenConfig,
	wemGehoertDieSeite,
} from './config.ts'

const AUTH_PREFIX = '/auth/'

export const createKlassenMiddleware = (
	config: KlassenConfig,
): MiddlewareHandler => {
	setKlassenConfig(config)

	return async (context, next) => {
		if (process.env.DISABLE_AUTH === 'true') {
			return next()
		}

		const path = new URL(context.request.url).pathname

		if (PUBLIC_PATHS.some((prefix) => path.startsWith(prefix))) {
			return next()
		}

		if (path.startsWith(AUTH_PREFIX)) {
			return next()
		}

		const { contactMail } = klassenConfig()

		try {
			const { response, session, setCookie } = await authenticate(
				context.request,
				{ siteOwner: wemGehoertDieSeite(), contactMail },
			)

			if (response) {
				return response
			}

			context.locals.user = session ?? undefined

			if (session) {
				try {
					merkeAnmeldung({
						sub: session.sub,
						email: session.email,
						name: session.name,
					})
				} catch (fehler) {
					console.error(
						`[anmeldung] Bezug fuer ${session.sub} nicht festgehalten: ${
							fehler instanceof Error ? fehler.message : String(fehler)
						}`,
					)
				}
			}

			const pageResponse = await next()
			if (setCookie) {
				pageResponse.headers.append('Set-Cookie', setCookie)
			}
			return pageResponse
		} catch (error) {
			if (error instanceof GrantsUnavailableError) {
				return textResponse(
					'Die Berechtigungspruefung ist gerade nicht erreichbar. Bitte spaeter erneut versuchen.',
				)
			}
			if (
				error instanceof OidcConfigError ||
				error instanceof GrantsConfigError
			) {
				return textResponse(
					'Die Anmeldung ist auf diesem Server nicht konfiguriert.',
				)
			}
			throw error
		}
	}
}

const textResponse = (text: string): Response =>
	new Response(text, {
		status: 503,
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	})
