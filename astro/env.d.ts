/// <reference types="astro/client" />

import type { KlassenConfig } from '@fws-maschsee/klassen-webseite/klasse/config'
import type { Session } from '@fws-maschsee/klassen-webseite/server/auth/oidc'

/**
 * Die Typen, die die geteilten Seiten brauchen. Eine Klassen-App holt sie mit
 * einer Zeile in ihrer `src/env.d.ts` ab:
 *
 *     /// <reference types="@fws-maschsee/klassen-webseite/env" />
 */

declare global {
	namespace App {
		interface Locals {
			/**
			 * Angemeldete Person. Von der Middleware des Packages gesetzt, sobald
			 * die Anmeldung gegen ZITADEL erfolgreich war und der Grant aus
			 * `KlassenConfig.authRole` im ZITADEL-Projekt der Klasse vorliegt.
			 */
			user?: Session
		}
	}
}

declare module 'virtual:fws-klasse/config' {
	/** Die aufgelöste Konfiguration der laufenden Klasse. */
	export const klasse: KlassenConfig
	export default klasse
}
