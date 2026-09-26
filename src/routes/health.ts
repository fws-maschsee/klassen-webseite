import type { APIRoute } from 'astro'
import { klassenConfig } from '../klasse/config.ts'
import { healthReport } from '../klasse/health.ts'
import { instanceName } from '../lib/db/instance.ts'

export const prerender = false

export const GET: APIRoute = () => {
	const config = klassenConfig()

	const report = healthReport({
		instance: instanceName(),
		env: process.env,
		listKeyIds: config.listKeyIds,
		hasPublicKey: Boolean(config.listPublicKeyPem?.trim()),
	})

	return new Response(JSON.stringify(report, null, 2), {
		// Immer 200 und bewusst ohne DB-/Mail-Prüfung: eine volle Warteschlange soll den Pod nicht aus dem Service nehmen.
		status: 200,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	})
}
