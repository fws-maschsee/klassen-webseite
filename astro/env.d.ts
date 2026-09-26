/// <reference types="astro/client" />

// Script, kein Modul: kein Top-Level-import, sonst wird das declare module unten zur Erweiterung (TS2307).
declare namespace App {
	interface Locals {
		user?: import('../src/server/auth/oidc.ts').Session
	}
}

declare module 'virtual:fws-klasse/config' {
	export const klasse: import('../src/klasse/config.ts').KlassenConfig
	export default klasse
}
