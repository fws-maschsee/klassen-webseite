import { createRemoteJWKSet } from 'jose'

export interface Discovery {
	issuer?: string
	authorization_endpoint: string
	token_endpoint: string
	jwks_uri: string
	userinfo_endpoint?: string
	revocation_endpoint?: string
	end_session_endpoint?: string
}

const DISCOVERY_TTL_MS = 60 * 60 * 1000

const discoveryCache = new Map<string, { at: number; doc: Discovery }>()

export const discover = async (issuer: string): Promise<Discovery> => {
	const cached = discoveryCache.get(issuer)
	if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.doc
	const response = await fetch(`${issuer}/.well-known/openid-configuration`)
	if (!response.ok) {
		throw new Error(
			`OIDC-Discovery fehlgeschlagen (HTTP ${response.status}) bei ${issuer}`,
		)
	}
	const doc = (await response.json()) as Discovery
	discoveryCache.set(issuer, { at: Date.now(), doc })
	return doc
}

export type KeySet = ReturnType<typeof createRemoteJWKSet>

const jwksCache = new Map<string, KeySet>()

export const remoteKeySet = (uri: string): KeySet => {
	let keySet = jwksCache.get(uri)
	if (!keySet) {
		keySet = createRemoteJWKSet(new URL(uri))
		jwksCache.set(uri, keySet)
	}
	return keySet
}

export const resetDiscovery = (): void => {
	discoveryCache.clear()
	jwksCache.clear()
}
