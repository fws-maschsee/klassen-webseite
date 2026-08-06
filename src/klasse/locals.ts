import type { Session } from '../server/auth/oidc.ts'

/**
 * `Astro.locals.user` als Typ.
 *
 * Ein `.ts`-Modul und keine `.d.ts`-Datei, damit ein gewoehnlicher Import die
 * Erweiterung mitbringt — `import './locals.ts'` in der Middleware. Eine
 * `.d.ts` waere nur ueber `types`/`include` der Klasse zu erreichen, also ueber
 * Konfiguration statt ueber Code.
 */
declare global {
	namespace App {
		interface Locals {
			/**
			 * Angemeldete Person. Von `createKlassenMiddleware` gesetzt, sobald die
			 * Anmeldung gegen ZITADEL erfolgreich war und der Grant aus
			 * `KlassenConfig.authRole` im ZITADEL-Projekt der Klasse vorliegt.
			 */
			user?: Session
		}
	}
}
