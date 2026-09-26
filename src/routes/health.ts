import type { APIRoute } from 'astro'
import { klassenConfig } from '../klasse/config.ts'
import { healthReport, healthStatusCode } from '../klasse/health.ts'
import { instanceName } from '../lib/db/instance.ts'
import { serviceAccessStatus } from '../server/auth/grants.ts'

export const prerender = false

export const GET: APIRoute = async () => {
	const config = klassenConfig()

	const report = healthReport({
		instance: instanceName(),
		env: process.env,
		listKeyIds: config.listKeyIds,
		hasPublicKey: Boolean(config.listPublicKeyPem?.trim()),
		serviceAccess: await serviceAccessStatus(),
	})

	return new Response(JSON.stringify(report, null, 2), {
		// Bewusst ohne DB-/Mail-Pruefung; 503 nur, wenn der Dienstzugang zu ZITADEL kaputt ist, damit der Smoke-Check rot wird.
		status: healthStatusCode(report),
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	})
}
