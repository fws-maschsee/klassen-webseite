/// <reference types="astro/client" />

/**
 * Die Typen, die die geteilten Seiten brauchen. Eine Klassen-App holt sie mit
 * einer Zeile in ihrer `src/env.d.ts` ab — über einen PFAD, nicht über
 * `types=`: `types=` sucht in `node_modules`, und dort liegt der geteilte Code
 * nicht mehr.
 *
 *     /// <reference path="../geteilt/astro/env.d.ts" />
 *
 * Diese Datei ist ein SCRIPT und kein Modul: kein `import` auf oberster Ebene,
 * die Typen kommen als Inline-`import(...)`-Typen herein. Das ist die
 * Bedingung dafür, dass `declare module 'virtual:fws-klasse/config'` unten eine
 * AMBIENTE Deklaration ist. In einem Modul wäre es eine Modul-ERWEITERUNG, und
 * die setzt ein Modul voraus, das es bereits gibt — das virtuelle Modul entsteht
 * aber erst im Vite-Plugin der Integration. `astro check` der Klasse meldete
 * dann `ts(2307): Cannot find module 'virtual:fws-klasse/config'` an
 * `astro/pages/index.astro`.
 *
 * Aufgefallen ist das erst mit dem Submodule, und zwar nicht zufällig: solange
 * diese Dateien unter `node_modules` lagen, hat `astro check` der Klasse sie
 * ausgeblendet und die geteilten Seiten überhaupt nicht geprüft.
 */

declare namespace App {
	interface Locals {
		/**
		 * Angemeldete Person. Von `createKlassenMiddleware` gesetzt, sobald die
		 * Anmeldung gegen ZITADEL erfolgreich war und der Grant aus
		 * `KlassenConfig.authRole` im ZITADEL-Projekt der Klasse vorliegt.
		 */
		user?: import('../src/server/auth/oidc.ts').Session
	}
}

declare module 'virtual:fws-klasse/config' {
	/** Die aufgelöste Konfiguration der laufenden Klasse. */
	export const klasse: import('../src/klasse/config.ts').KlassenConfig
	export default klasse
}
