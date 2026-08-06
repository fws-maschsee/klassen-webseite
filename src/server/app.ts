import type { Server } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import express from 'express'
import { type KlassenConfig, setKlassenConfig } from '../klasse/config.ts'
import { openDb } from '../lib/db/index.ts'
import { assertInstanceMatches, instanceLabel } from '../lib/db/instance.ts'
import { runMigrations } from '../migrations.ts'
import { port, publicBaseUrl } from './config.ts'
import { mcpAuthMiddleware, mcpRequestHandler } from './mcp/handler.ts'
import { mcpOAuthProvider } from './oauth/provider.ts'
import { startQueueWorker } from './queue-worker.ts'

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
 * Diese Datei liegt im geteilten Code und nicht in der Klasse, weil sie in
 * beiden Klassen-Repos zeichengleich war (`diff -wB` = 0 Zeilen). In der Klasse
 * bleibt ein `server.ts` mit drei Zeilen — es muss dort bleiben, weil der Pfad
 * zum Astro-Build (`./dist/server/entry.mjs`) relativ zum Arbeitsverzeichnis
 * der KLASSE gilt. Gestartet wird es mit
 * `node --experimental-strip-types server.ts`.
 */

export type StartServerOptions = {
	config: KlassenConfig
	/**
	 * Zusätzliche Migrationsverzeichnisse der Klasse. Die des geteilten Codes
	 * laufen immer zuerst; klassen-eigene dürfen darauf aufbauen, nie umgekehrt.
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

/**
 * Startet die Express-App.
 *
 * Gibt den `http.Server` zurueck, damit ein Test den Start abschliessen und den
 * Port danach wieder freigeben kann. In `server.ts` einer Klasse bleibt das
 * `await startServer({ config })` davon unberuehrt.
 */
export const startServer = async (
	options: StartServerOptions,
): Promise<Server> => {
	// MUSS als erstes laufen: alles darunter liest die Konfiguration ueber
	// `klassenConfig()`. Deshalb darf oberhalb dieser Zeile auch kein IMPORT
	// etwas auswerten, das die Konfiguration braucht — siehe die Begruendung an
	// `createMcpAuthMiddleware` in `./mcp/handler.ts`.
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

	// Eine frueher benutzte Kalenderadresse dauerhaft auf die heutige umleiten.
	// Nur `klasse-christophers` hat eine: Dort lag die Datei sieben Monate unter
	// einem anderen Pfad, und wer in diesem Zeitraum abonniert hat, haengt daran.
	//
	// Die Umleitung traegt bewusst nur DIESE Seite — der Pfad mit den echten Abos
	// wird direkt als Datei ausgeliefert. Ein 301 ist fuer Kalender-Clients kein
	// sicherer Weg: Apples Kalender quittiert Umleitungen dokumentiert mit Fehler
	// -1007, Googles Importer scheitert an ihnen ebenfalls.
	//
	// Sie steht VOR `express.static`, damit sie auch dann greift, wenn wieder
	// eine Datei an der alten Stelle landet. `pruefeKalender` laesst das ohnehin
	// nicht durch die Tests, aber die Reihenfolge hier kostet nichts und macht
	// den Fall unmoeglich statt unwahrscheinlich.
	const { calendarLegacyPath, calendarPath } = options.config
	if (calendarLegacyPath !== null && calendarPath !== null) {
		app.get(calendarLegacyPath, (_req, res) => {
			res.redirect(301, calendarPath)
		})
	}

	app.use(express.static('dist/client'))

	// Der Astro-SSR-Entry entsteht erst beim Build, der Pfad liegt deshalb in
	// einer Variable — sonst wollte die Typpruefung ein Modul aufloesen, das im
	// Quellbaum gar nicht existiert.
	//
	// `pathToFileURL(resolve(...))` und nicht der relative String: dieses Modul
	// liegt bei der Klasse unter `geteilt/src/server/`, und ein relativer
	// `import()` wird gegen den Ort des IMPORTIERENDEN Moduls aufgeloest, nicht
	// gegen das Arbeitsverzeichnis. Der Astro-Build der Klasse liegt aber neben
	// ihrer `package.json`. Ohne diese Zeile sucht Node
	// `geteilt/src/server/dist/server/entry.mjs` — dasselbe Fehlerbild wie
	// vorher unter `node_modules`, nur mit anderem Pfad.
	const astroEntry = pathToFileURL(
		path.resolve(options.astroEntry ?? './dist/server/entry.mjs'),
	).href
	// biome-ignore lint/suspicious/noExplicitAny: der Astro-SSR-Handler ist untypisiert
	const { handler } = (await import(astroEntry)) as { handler: any }
	app.use(handler)

	return app.listen(port(), () => {
		console.log(
			`[server] ${instance.configured} laeuft auf http://localhost:${port()}`,
		)
		startQueueWorker()
	})
}
