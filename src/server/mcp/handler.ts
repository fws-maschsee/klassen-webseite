import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { publicBaseUrl } from '../config.ts'
import { mcpOAuthProvider } from '../oauth/provider.ts'
import { authFromInfo } from './guard.ts'
import { buildMcpServer } from './server.ts'

// Funktion statt Konstante: `publicBaseUrl()` braucht die KlassenConfig, die beim Import noch nicht gesetzt ist.
export const createMcpAuthMiddleware = (): RequestHandler =>
	requireBearerAuth({
		verifier: mcpOAuthProvider,
		resourceMetadataUrl: `${publicBaseUrl()}/.well-known/oauth-protected-resource`,
	})

let gebaut: RequestHandler | null = null

export const mcpAuthMiddleware: RequestHandler = (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	// Gemerkt, weil `requireBearerAuth` je Aufruf einen eigenen Rate-Limiter anlegt.
	if (!gebaut) gebaut = createMcpAuthMiddleware()
	gebaut(req, res, next)
}

export const resetMcpAuthMiddleware = (): void => {
	gebaut = null
}

export const mcpRequestHandler = async (
	req: Request,
	res: Response,
): Promise<void> => {
	const server = buildMcpServer(authFromInfo(req.auth))
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
	})

	res.on('close', () => {
		transport.close().catch(() => {})
		server.close().catch(() => {})
	})

	await server.connect(transport)
	await transport.handleRequest(req, res, req.body)
}
