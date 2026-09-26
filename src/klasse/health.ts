import type { ServiceAccessStatus } from '../server/auth/grants.ts'

export const UNKNOWN = 'unknown'

export type SignatureScheme = 'ed25519'

export type HealthReport = {
	status: 'ok' | 'degraded'
	instance: string
	commit: string
	shared: string
	builtAt: string | null
	lists: {
		schemes: readonly SignatureScheme[]
		keyIds: readonly string[]
	}
	serviceAccess: ServiceAccessStatus
}

export type BuildEnv = {
	BUILD_COMMIT?: string | undefined
	BUILD_SHARED?: string | undefined
	BUILD_TIME?: string | undefined
}

export type HealthInput = {
	instance: string
	env: BuildEnv
	listKeyIds: readonly string[]
	hasPublicKey: boolean
	serviceAccess?: ServiceAccessStatus
}

const filled = (wert: string | undefined): string | undefined => {
	const getrimmt = wert?.trim()
	return getrimmt ? getrimmt : undefined
}

export const healthReport = (input: HealthInput): HealthReport => {
	const schemes: SignatureScheme[] = []
	// Dieselbe Bedingung wie in incomingAuth.ts, sonst meldet health „ed25519“, während die Mail ein 401 bekommt.
	if (input.hasPublicKey && input.listKeyIds.length > 0) {
		schemes.push('ed25519')
	}

	const serviceAccess: ServiceAccessStatus = input.serviceAccess ?? {
		status: 'not_configured',
		credential: null,
		checkedAt: null,
		error: null,
	}

	return {
		status: serviceAccess.status === 'failing' ? 'degraded' : 'ok',
		instance: input.instance,
		commit: filled(input.env.BUILD_COMMIT) ?? UNKNOWN,
		shared: filled(input.env.BUILD_SHARED) ?? UNKNOWN,
		builtAt: filled(input.env.BUILD_TIME) ?? null,
		lists: {
			schemes,
			keyIds: input.listKeyIds,
		},
		serviceAccess,
	}
}

export const healthStatusCode = (report: HealthReport): number =>
	report.status === 'ok' ? 200 : 503
