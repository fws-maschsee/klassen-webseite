import type { Server } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js'
import express from 'express'
import { type KlassenConfig, setKlassenConfig } from '../klasse/config.ts'
import { openDb } from '../lib/db/index.ts'
import { assertInstanceMatches, instanceLabel } from '../lib/db/instance.ts'
import { loescheFaellige } from '../lib/db/mitbringen.ts'
import { seedDemoData } from '../lib/db/saatdaten.ts'
import { loescheFaellige as loescheFaelligeSchichtplaene } from '../lib/db/schichten.ts'
import { runMigrations } from '../migrations.ts'
import { port, publicBaseUrl } from './config.ts'
import { mcpAuthMiddleware, mcpRequestHandler } from './mcp/handler.ts'
import { mcpOAuthProvider } from './oauth/provider.ts'
import { startErinnerungsdienst } from './putzplan-worker.ts'
import { startQueueWorker } from './queue-worker.ts'
import { nurAngemeldet } from './statisch.ts'

export type StartServerOptions = {
	config: KlassenConfig
	migrationsDirs?: readonly string[]
	migrate?: boolean
	astroEntry?: string
	staticDir?: string
}

export const startServer = async (
	options: StartServerOptions,
): Promise<Server> => {
	// Muss zuerst laufen: alles darunter liest `klassenConfig()`.
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

	// Vor `assertInstanceMatches`: danach steht die Identitaet in `app_meta`, und die Datei gilt nicht mehr als frisch.
	if (process.env.SEED_DEMO_DATA === 'true') {
		const saat = seedDemoData(db, new Date(), options.migrationsDirs ?? [])
		if (saat.gesaet) {
			console.log(
				`[saat] Vorschau befuellt: ${saat.familien} erfundene Familien, ` +
					`${saat.mitglieder} Personen, ${saat.termine} Putztermine, ` +
					`${saat.verteiler} Verteiler`,
			)
		} else {
			console.warn(
				`[saat] SEED_DEMO_DATA ist gesetzt, aber die Datenbank ist nicht ` +
					`frisch (Tabelle "${saat.grund?.tabelle}": ${saat.grund?.ist} statt ` +
					`${saat.grund?.soll} Zeilen) — es wurde NICHTS geschrieben. Genau ` +
					`so ist die Sicherung gedacht: eine Datenbank mit Inhalt wird nie ` +
					`besaet.`,
			)
		}
	}

	const instance = assertInstanceMatches(db)

	const app = express()

	// Hinter dem Reverse-Proxy: sonst sehen Express und das Rate-Limiting des MCP-SDK nur die Proxy-IP.
	app.set('trust proxy', 1)

	app.use(
		mcpAuthRouter({
			provider: mcpOAuthProvider,
			issuerUrl: new URL(publicBaseUrl()),
			resourceName: `${instanceLabel()} MCP`,
			scopesSupported: ['mcp'],
		}),
	)

	app.use('/mcp', express.json(), mcpAuthMiddleware, mcpRequestHandler)

	// Nur die alte Adresse wird umgeleitet (Kalender-Clients folgen 301 schlecht, Apple: -1007);
	// vor `express.static`, damit sie auch greift, falls dort wieder eine Datei liegt.
	const { calendarLegacyPath, calendarPath } = options.config
	if (calendarLegacyPath !== null && calendarPath !== null) {
		app.get(calendarLegacyPath, (_req, res) => {
			res.redirect(301, calendarPath)
		})
	}

	const staticDir = options.staticDir ?? 'dist/client'
	app.use(nurAngemeldet(staticDir))
	app.use(express.static(staticDir))

	// Gegen das Arbeitsverzeichnis der Klasse aufgeloest: ein relativer `import()` gaelte relativ zu diesem Modul in `geteilt/`.
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
		const abraeumen = () => {
			try {
				const n = loescheFaellige(db)
				if (n > 0)
					console.log(`[mitbringen] ${n} abgelaufene Liste(n) geloescht`)
				const s = loescheFaelligeSchichtplaene(db)
				if (s > 0)
					console.log(`[schichten] ${s} abgelaufene(r) Plan/Plaene geloescht`)
			} catch (fehler) {
				console.error(
					`[mitbringen] Abraeumen fehlgeschlagen: ${fehler instanceof Error ? fehler.message : String(fehler)}`,
				)
			}
		}
		abraeumen()
		setInterval(abraeumen, 24 * 60 * 60 * 1000).unref()
		startErinnerungsdienst()
	})
}
