import {
	handleZitadelEvent,
	verifyWebhookSignature,
	type ZitadelEvent,
} from './revocation.ts'

const json = (body: unknown, status: number): Response =>
	Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

export const handleZitadelWebhook = async (
	request: Request,
): Promise<Response> => {
	const signingKey = (process.env.ZITADEL_WEBHOOK_SIGNING_KEY ?? '').trim()
	if (!signingKey) return new Response('Not Found', { status: 404 })

	const rawBody = Buffer.from(await request.arrayBuffer())
	const check = verifyWebhookSignature(
		rawBody,
		request.headers.get('zitadel-signature'),
		signingKey,
	)
	if (!check.ok) {
		console.warn(`[zitadel-events] Signatur abgelehnt: ${check.reason}`)
		return json({ error: 'invalid_signature', reason: check.reason }, 401)
	}

	let event: ZitadelEvent
	try {
		event = JSON.parse(rawBody.toString('utf8')) as ZitadelEvent
	} catch {
		return json({ error: 'invalid_json' }, 400)
	}
	if (!event || typeof event !== 'object') {
		return json({ error: 'invalid_json' }, 400)
	}

	const outcome = handleZitadelEvent(
		event,
		(process.env.ZITADEL_PROJECT_ID ?? '').trim(),
	)
	if (outcome.action !== 'ignored') {
		console.log(`[zitadel-events] ${JSON.stringify(outcome)}`)
	}
	return json(outcome, 200)
}
