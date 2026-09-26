import type { MiddlewareHandler } from 'astro'
import './locals.ts'
import { merkeAnmeldung } from '../lib/db/users.ts'
import { authenticate, OidcConfigError } from '../server/auth/oidc.ts'
import {
	type KlassenConfig,
	klassenConfig,
	setKlassenConfig,
	wemGehoertDieSeite,
} from './config.ts'
import { brauchtKeineAnmeldung, normalisierterPfad } from './pfad.ts'

export const createKlassenMiddleware = (
	config: KlassenConfig,
): MiddlewareHandler => {
	setKlassenConfig(config)

	return async (context, next) => {
		if (process.env.DISABLE_AUTH === 'true') {
			return next()
		}

		const path = normalisierterPfad(new URL(context.request.url).pathname)
		if (path === null) {
			return new Response('Ungültiger Pfad', {
				status: 400,
				headers: { 'Content-Type': 'text/plain; charset=utf-8' },
			})
		}

		if (brauchtKeineAnmeldung(path)) {
			return next()
		}

		const { contactMail } = klassenConfig()

		try {
			const { response, session } = await authenticate(context.request, {
				siteOwner: wemGehoertDieSeite(),
				contactMail,
			})

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

			return next()
		} catch (error) {
			if (error instanceof OidcConfigError) {
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
