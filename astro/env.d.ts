/// <reference types="astro/client" />

declare namespace App {
	interface Locals {
		user?: import('../src/server/auth/oidc.ts').Session
	}
}

declare module 'virtual:fws-klasse/config' {
	export const klasse: import('../src/klasse/config.ts').KlassenConfig
	export default klasse
}
