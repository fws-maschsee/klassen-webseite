import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TestProject } from 'vitest/node'

/**
 * Startet ZITADEL und Postgres, bevor irgendein Test läuft, und räumt danach
 * auf.
 *
 * Warum das hier steht und nicht im Workflow: Ein Aufbau, den nur GitHub
 * Actions starten kann, wird lokal nicht benutzt — und was lokal nicht benutzt
 * wird, ist beim nächsten Fehlschlag genau die Stelle, an der niemand
 * nachsieht. `npm run test:integration` genügt; der Workflow ruft denselben
 * Befehl.
 *
 * `docker compose up --wait` wartet auf die Healthchecks aus
 * `docker-compose.yml` und nicht auf eine geschätzte Anzahl Sekunden. Ein
 * `sleep` wäre hier doppelt falsch: zu kurz gewählt ergibt es rote Läufe ohne
 * Fehler im Code, zu lang gewählt zahlt jeder Pull Request die Differenz.
 */

const hier = path.dirname(fileURLToPath(import.meta.url))
const COMPOSE = path.join(hier, 'docker-compose.yml')
const PAT_VERZEICHNIS = path.join(hier, 'pat')
const PAT_DATEI = path.join(PAT_VERZEICHNIS, 'ci-admin.pat')

const compose = (...argumente: string[]): void => {
	execFileSync('docker', ['compose', '-f', COMPOSE, ...argumente], {
		stdio: 'inherit',
		env: process.env,
	})
}

/**
 * Der Aufbau bleibt nach dem Lauf stehen, wenn `INTEGRATION_ZITADEL_KEEP=1`
 * gesetzt ist. Beim Suchen eines Fehlers ist die Instanz mit den angelegten
 * Konten das Nützlichste, was es gibt — und ein zweiter Lauf legt seine eigene
 * Organisation an, stört also nicht.
 */
const stehenlassen = (): boolean => process.env.INTEGRATION_ZITADEL_KEEP === '1'

export const setup = async (projekt: TestProject): Promise<void> => {
	// ZITADEL schreibt das Token des Maschinen-Benutzers in dieses Verzeichnis.
	// Der Prozess im Container läuft als Benutzer `zitadel`, der Testlauf als
	// jemand anderem — deshalb weite Rechte auf ein Verzeichnis, in dem nichts
	// steht ausser einem Token für eine Instanz, die den Testlauf nicht
	// überlebt.
	fs.mkdirSync(PAT_VERZEICHNIS, { recursive: true })
	fs.chmodSync(PAT_VERZEICHNIS, 0o777)

	const begonnen = Date.now()
	compose('up', '-d', '--wait', '--wait-timeout', '300')
	const sekunden = ((Date.now() - begonnen) / 1000).toFixed(1)
	console.log(`[integration] ZITADEL bereit nach ${sekunden} s`)

	if (!fs.existsSync(PAT_DATEI)) {
		throw new Error(
			`ZITADEL hat kein Token unter ${PAT_DATEI} hinterlegt. Läuft der Container mit einer Datenbank von vorher, in der die Ersteinrichtung schon gelaufen ist? Dann hilft "docker compose -f ${COMPOSE} down -v".`,
		)
	}

	const port = process.env.ZITADEL_PORT ?? '8080'
	projekt.provide('zitadelIssuer', `http://localhost:${port}`)
	projekt.provide('zitadelToken', fs.readFileSync(PAT_DATEI, 'utf8').trim())
}

export const teardown = async (): Promise<void> => {
	if (stehenlassen()) {
		console.log(
			`[integration] Aufbau bleibt stehen. Abräumen mit: docker compose -f ${COMPOSE} down -v`,
		)
		return
	}
	compose('down', '-v', '--remove-orphans')
	fs.rmSync(PAT_VERZEICHNIS, { recursive: true, force: true })
}

declare module 'vitest' {
	interface ProvidedContext {
		zitadelIssuer: string
		zitadelToken: string
	}
}
