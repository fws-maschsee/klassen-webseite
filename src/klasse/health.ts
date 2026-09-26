export const UNKNOWN = 'unknown'

export type SignatureScheme = 'ed25519'

export type HealthReport = {
	status: 'ok'
	instance: string
	commit: string
	shared: string
	builtAt: string | null
	lists: {
		schemes: readonly SignatureScheme[]
		keyIds: readonly string[]
	}
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
}

const filled = (wert: string | undefined): string | undefined => {
	const getrimmt = wert?.trim()
	return getrimmt ? getrimmt : undefined
}

export const healthReport = (input: HealthInput): HealthReport => {
	const schemes: SignatureScheme[] = []
	if (input.hasPublicKey && input.listKeyIds.length > 0) {
		schemes.push('ed25519')
	}

	return {
		status: 'ok',
		instance: input.instance,
		commit: filled(input.env.BUILD_COMMIT) ?? UNKNOWN,
		shared: filled(input.env.BUILD_SHARED) ?? UNKNOWN,
		builtAt: filled(input.env.BUILD_TIME) ?? null,
		lists: {
			schemes,
			keyIds: input.listKeyIds,
		},
	}
}
