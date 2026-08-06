import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { publicBaseUrl } from '../config.ts'
import { mcpOAuthProvider } from '../oauth/provider.ts'
import { authFromInfo } from './guard.ts'
import { buildMcpServer } from './server.ts'

/**
 * Baut die Bearer-Auth fuer `/mcp`: prueft den Authorization-Header gegen
 * unseren OAuth-Provider (Tokens in der lokalen SQLite) und antwortet bei
 * Fehlern mit 401 plus korrektem `WWW-Authenticate`-Header, damit der Client
 * den Discovery-/Login-Flow starten kann.
 *
 * Als Nebenwirkung haengt die Middleware das gepruefte Token als `req.auth`
 * an — daraus entstehen unten die Rollen des Aufrufers.
 *
 * Eine FUNKTION und keine Konstante, weil `publicBaseUrl()` ohne
 * `PUBLIC_BASE_URL` auf `klassenConfig()` zurueckfaellt. Als Konstante liefe
 * dieser Aufruf beim IMPORT dieses Moduls — und ESM wertet Importe vollstaendig
 * aus, bevor der Rumpf des importierenden Moduls laeuft. `startServer()` in
 * `../app.ts` importiert diese Datei, ruft `setKlassenConfig()` aber erst in
 * seinem Rumpf: die Konfiguration kam damit immer zu spaet, und jeder Start
 * ohne `PUBLIC_BASE_URL` starb mit "Keine KlassenConfig hinterlegt" — gemessen
 * in den Image-Smoke-Tests von `klasse-wiesen` und `klasse-christophers`, die
 * das Image absichtlich ohne Cluster-Env starten.
 */
export const createMcpAuthMiddleware = (): RequestHandler =>
	requireBearerAuth({
		verifier: mcpOAuthProvider,
		resourceMetadataUrl: `${publicBaseUrl()}/.well-known/oauth-protected-resource`,
	})

let gebaut: RequestHandler | null = null

/**
 * Dieselbe Middleware, aber erst beim ERSTEN Request gebaut.
 *
 * Der Umweg ueber diesen Wrapper haelt `app.use('/mcp', ..., mcpAuthMiddleware,
 * ...)` als Wert benutzbar, ohne dass der Import etwas auswertet. Gemerkt wird
 * das Ergebnis, weil `requireBearerAuth` pro Aufruf einen eigenen Rate-Limiter
 * anlegt — ein Neubau pro Request haette das Limit stillschweigend abgeschaltet.
 */
export const mcpAuthMiddleware: RequestHandler = (
	req: Request,
	res: Response,
	next: NextFunction,
) => {
	if (!gebaut) gebaut = createMcpAuthMiddleware()
	gebaut(req, res, next)
}

/** Nur fuer Tests: den gemerkten Aufbau verwerfen. */
export const resetMcpAuthMiddleware = (): void => {
	gebaut = null
}

export const mcpRequestHandler = async (
	req: Request,
	res: Response,
): Promise<void> => {
	// Stateless: jeder Request bekommt einen frischen Transport + Server. Der
	// Server wird mit den Rollen GENAU DIESES Tokens gebaut; die
	// Schreib-Pruefung sitzt damit an derselben Stelle wie in der
	// Weboberflaeche (src/lib/roles.ts) und nicht in einem zweiten Regelwerk.
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
