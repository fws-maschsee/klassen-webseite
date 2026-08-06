import type { Session } from '../server/auth/oidc.js'

/**
 * `Astro.locals.user` als Typ.
 *
 * Bewusst ein `.ts`-Modul und keine `.d.ts`-Datei: tsc kopiert
 * Deklarationsdateien nicht nach `dist/`, eine `.d.ts` waere im
 * ausgelieferten Package also nicht vorhanden. So entsteht
 * `dist/klasse/locals.d.ts` als echtes Build-Ergebnis, und die Klassen-App
 * bekommt die Erweiterung mit einem Import.
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
