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

/**
 * Die Anmelde-Middleware. Sie stand in beiden Klassen-Repos als eigene Datei
 * und wich dort auf 72 Zeilen voneinander ab — nachgesehen ist von diesen 72
 * Zeilen keine einzige echte Klassenlogik: es sind Kommentare, Einrückungen,
 * `.js`-Endungen in Importen und drei Werte (Klassenname, Kontaktadresse,
 * Kalenderpfad). Deshalb liegt der Ablauf hier und die drei Werte in der
 * `KlassenConfig`. In der Klassen-App bleibt ein Dreizeiler.
 *
 * Bewusst `MiddlewareHandler` aus `astro` statt `defineMiddleware` aus
 * `astro:middleware`: `astro:middleware` ist ein virtuelles Modul und existiert
 * nur innerhalb einer Astro-Kompilierung. `defineMiddleware` ist zur Laufzeit
 * die Identität, sein einziger Nutzen ist die Typisierung — und die liefert der
 * Typ direkt. So bleibt diese Datei auch ohne Astro ladbar, und `tsc` prueft
 * sie im Nodeteil mit.
 */

/**
 * Der Anmeldevorgang selbst. Diese Pfade dürfen nicht bewacht werden — sie
 * SIND die Anmeldung; eine Prüfung hier ergäbe eine Endlosschleife.
 *
 * Bedient werden sie von echten Routen (siehe `GETEILTE_ROUTEN`). Der
 * Node-Adapter läuft hinter Express im `middleware`-Modus und ruft die
 * Astro-Middleware nur für Pfade auf, zu denen es auch eine Route gibt — ein
 * reiner Sonderfall an dieser Stelle liefe deshalb ins Leere und Express
 * antwortete „Cannot GET /auth/callback", nachdem der Nutzer sein Passwort
 * schon eingegeben hat.
 */
const AUTH_PREFIX = '/auth/'

/**
 * Baut die Middleware für eine Klasse.
 *
 * Der Aufruf hinterlegt die Konfiguration gleich mit. Das ist kein
 * Nebeneffekt, den man auch weglassen könnte: die Middleware ist das erste
 * Modul der Astro-App, das bei einer Anfrage läuft, und die geteilten Seiten
 * fragen die Konfiguration erst in ihrer Frontmatter ab.
 */
export const createKlassenMiddleware = (
	config: KlassenConfig,
): MiddlewareHandler => {
	setKlassenConfig(config)

	return async (context, next) => {
		// In Tests komplett ohne Auth arbeiten.
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
				// Nicht `label`: Wer hier abgewiesen wird, hat meist den Link einer
				// fremden Klasse, und dem hilft „Frau Wiesen, 5A" weiter als der
				// Instanzname.
				{ siteOwner: wemGehoertDieSeite(), contactMail },
			)

			if (response) {
				return response
			}

			context.locals.user = session ?? undefined

			// Wer hier ankommt, hat eine gueltige Sitzung — genau der Moment, in
			// dem der Bezug zwischen Konto und Adressbuch-Eintrag entsteht (siehe
			// `src/lib/db/users.ts`). Er entsteht NUR fuer die Person, die gerade
			// selbst da ist, und er legt sie in KEINE Gruppe.
			//
			// Warum hier und nicht in `/auth/callback`: Eine Sitzung gilt 30 Tage.
			// Der Rueckweg vom IdP laeuft also hoechstens einmal im Monat durch,
			// und „zuletzt gesehen" waere ein Wert, der einmal im Monat stimmt.
			//
			// Warum das den Seitenaufruf nicht scheitern laesst: Der Bezug ist
			// Buchhaltung, kein Zugang. Eine gesperrte Datei oder eine kaputte
			// Zeile darf niemanden aussperren, der sich gerade richtig angemeldet
			// hat.
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
				// Die Sitzung wurde gerade beim IdP verlängert — ohne dieses Cookie
				// an der ausgelieferten Antwort würde bei JEDER Anfrage erneut ein
				// Refresh laufen.
				pageResponse.headers.append('Set-Cookie', setCookie)
			}
			return pageResponse
		} catch (error) {
			if (error instanceof GrantsUnavailableError) {
				// Die Berechtigung wird bei jeder Anfrage frisch bei ZITADEL erfragt
				// (src/server/auth/grants.ts). Antwortet ZITADEL nicht, wird
				// VERWEIGERT statt durchgewunken — es laeuft im selben Cluster, ist
				// es weg, ist das ein Ausfall und kein Normalfall.
				return textResponse(
					'Die Berechtigungspruefung ist gerade nicht erreichbar. Bitte spaeter erneut versuchen.',
				)
			}
			if (
				error instanceof OidcConfigError ||
				error instanceof GrantsConfigError
			) {
				// Fehlende Konfiguration ist ein Betriebsfehler, kein Nutzerfehler.
				// Bewusst 503 mit klarem Text statt eines Absturzes: der
				// CI-Smoke-Test startet das Image ohne Secrets und prüft, DASS der
				// Server antwortet — der Kalender ist da längst durch.
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
