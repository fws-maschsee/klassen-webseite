import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { exportJWK, SignJWT } from 'jose'

export const ISSUER = 'https://id.example.org'

export type Idp = {
	sign: (
		claims: Record<string, unknown>,
		options?: { kid?: string },
	) => Promise<string>
	jwks: () => Promise<{ keys: unknown[] }>
	discovery: Record<string, string>
}

export const rsaKeyPair = (): { privateKey: KeyObject; publicKey: KeyObject } =>
	generateKeyPairSync('rsa', { modulusLength: 2048 })

export const pem = (key: KeyObject): string =>
	key.export({ type: 'pkcs1', format: 'pem' }).toString()

export const createIdp = (): Idp => {
	const { privateKey, publicKey } = rsaKeyPair()
	return {
		sign: (claims, options = {}) =>
			new SignJWT(claims)
				.setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'idp-1' })
				.setIssuer(ISSUER)
				.setIssuedAt()
				.setExpirationTime('5m')
				.sign(privateKey),
		jwks: async () => ({
			keys: [
				{
					...(await exportJWK(publicKey)),
					kid: 'idp-1',
					alg: 'RS256',
					use: 'sig',
				},
			],
		}),
		discovery: {
			issuer: ISSUER,
			authorization_endpoint: `${ISSUER}/oauth/v2/authorize`,
			token_endpoint: `${ISSUER}/oauth/v2/token`,
			jwks_uri: `${ISSUER}/oauth/v2/keys`,
			userinfo_endpoint: `${ISSUER}/oidc/v1/userinfo`,
			revocation_endpoint: `${ISSUER}/oauth/v2/revoke`,
			end_session_endpoint: `${ISSUER}/oidc/v1/end_session`,
		},
	}
}
