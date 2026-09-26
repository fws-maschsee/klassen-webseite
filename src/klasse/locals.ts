import type { Session } from '../server/auth/oidc.ts'

declare global {
	namespace App {
		interface Locals {
			user?: Session
		}
	}
}
