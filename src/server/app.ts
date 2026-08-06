import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import express from 'express'
import { type KlassenConfig, setKlassenConfig } from '../klasse/config.js'
import { openDb } from '../lib/db/index.js'
import { assertInstanceMatches, instanceLabel } from '../lib/db/instance.js'
import { runMigrations } from '../migrations.js'
import { port, publicBaseUrl } from './config.js'
import { mcpAuthMiddleware, mcpRequestHandler } from './mcp/handler.js'
import { mcpOAuthProvider } from './oauth/provider.js'
import { startQueueWorker } from './queue-worker.js'

/**
 * Produktions-Entrypoint. Express umschliesst den Astro-SSR-Handler, weil zwei
 * Dinge ausserhalb von Astro leben muessen:
 *
 *  - Der MCP-Endpunkt `/mcp` braucht das Express-`req`/`res`-Paar fuer den
 *    Streamable-HTTP-Transport des SDK.
 *  - Die OAuth-Endpunkte (`/authorize`, `/token`, `/register`, `/revoke` und
 *    die `.well-known`-Metadaten) mountet `mcpAuthRouter` auf Root-Ebene.
 *
 * Alles andere — Seiten, Content, die Anmeldung — laeuft durch die
 * Astro-Middleware.
 *
 * Diese Datei liegt im Package und nicht in der Klasse, weil sie in beiden
 * Klassen-Repos zeichengleich war (`diff -wB` = 0 Zeilen). In der Klasse bleibt
 * ein `server.ts` mit drei Zeilen — es muss dort bleiben, weil der Pfad zum
 * Astro-Build (`./dist/server/entry.mjs`) relativ zum Arbeitsverzeichnis der
 * KLASSE gilt.
 */

export type StartServerOptions = {
	config: KlassenConfig
	/**
	 * Zusätzliche Migrationsverzeichnisse der Klasse. Die des Packages laufen
	 * immer zuerst; klassen-eigene dürfen darauf aufbauen, nie umgekehrt.
	 */
	migrationsDirs?: readonly string[]
	/**
	 * Migrationen beim Start anwenden. Vorgabe `true` und idempotent über
	 * `schema_migrations` — dieselbe Tabelle, die dbmate benutzt, damit ein
	 * bestehendes Deployment mit `dbmate up` im Container nicht doppelt
	 * migriert wird.
	 */
	migrate?: boolean
	/**
	 * Pfad des Astro-SSR-Entrypoints, relativ zum Arbeitsverzeichnis der
	 * Klassen-App.
	 */
	astroEntry?: string
}

export const startServer = async (
	options: StartServerOptions,
): Promise<void> => {
	setKlassenConfig(options.config)

	const db = openDb()

	if (options.migrate !== false) {
		const neu = runMigrations(db, options.migrationsDirs ?? [])
		if (neu.length > 0) {
			console.log(
				`[server] ${neu.length} Migration(en) angewendet: ${neu.join(', ')}`,
			)
		}
	}

	// Bevor irgendetwas laeuft: gehoert die gemountete Datenbank ueberhaupt zu
	// dieser Klasse? Ein Mismatch bedeutet, dass der naechste Versand an die
	// falsche Elternschaft ginge. Lieber gar nicht starten.
	const instance = assertInstanceMatches(db)

	const app = express()

	// Hinter einem Reverse-Proxy laufen wir mit X-Forwarded-*-Headern, damit
	// Express (und das Rate-Limiting des MCP-SDK) die echten Client-IPs sieht.
	app.set('trust proxy', 1)

	// OAuth-Endpunkte fuer den MCP-Client (Discovery, DCR, Token, Revoke).
	// `/authorize` leitet auf die Astro-Seite `/oauth/consent` weiter, die
	// hinter der normalen Anmeldung liegt.
	app.use(
		mcpAuthRouter({
			provider: mcpOAuthProvider,
			issuerUrl: new URL(publicBaseUrl()),
			resourceName: `${instanceLabel()} MCP`,
			scopesSupported: ['mcp'],
		}),
	)

	// MCP-Endpunkt mit eigenem Bearer-Auth-Layer.
	app.use('/mcp', express.json(), mcpAuthMiddleware, mcpRequestHandler)

	app.use(express.static('dist/client'))

	// Der Astro-SSR-Entry entsteht erst beim Build, der Pfad liegt deshalb in
	// einer Variable — sonst wollte die Typpruefung ein Modul aufloesen, das im
	// Quellbaum gar nicht existiert.
	//
	// `pathToFileURL(resolve(...))` und nicht der relative String: dieses Modul
	// liegt beim Verbraucher unter `node_modules/.../dist/server/`, und ein
	// relativer `import()` wird dagegen aufgeloest, nicht gegen das
	// Arbeitsverzeichnis. Der Build der Klasse liegt aber neben ihrer
	// `package.json`. Ohne diese Zeile sucht Node
	// `node_modules/.../dist/server/dist/server/entry.mjs` — hier passiert,
	// gemessen, nicht vermutet.
	const astroEntry = pathToFileURL(
		path.resolve(options.astroEntry ?? './dist/server/entry.mjs'),
	).href
	// biome-ignore lint/suspicious/noExplicitAny: der Astro-SSR-Handler ist untypisiert
	const { handler } = (await import(astroEntry)) as { handler: any }
	app.use(handler)

	app.listen(port(), () => {
		console.log(
			`[server] ${instance.configured} laeuft auf http://localhost:${port()}`,
		)
		startQueueWorker()
	})
}
