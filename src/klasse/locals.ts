import type { Session } from '../server/auth/oidc.ts'

// Als .ts statt .d.ts, damit der Import in der Middleware die Erweiterung mitbringt, ohne tsconfig der Klasse.
declare global {
	namespace App {
		interface Locals {
			user?: Session
		}
	}
}
