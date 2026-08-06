/// <reference types="astro/client" />

import type { KlassenConfig } from '../src/klasse/config.ts'
import type { Session } from '../src/server/auth/oidc.ts'

/**
 * Die Typen, die die geteilten Seiten brauchen. Eine Klassen-App holt sie mit
 * einer Zeile in ihrer `src/env.d.ts` ab — über einen PFAD, nicht über
 * `types=`: `types=` sucht in `node_modules`, und dort liegt der geteilte Code
 * nicht mehr.
 *
 *     /// <reference path="../geteilt/astro/env.d.ts" />
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
