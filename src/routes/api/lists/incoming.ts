import type { APIRoute } from 'astro'
import {
	handleIncomingListMail,
	statusForResult,
} from '../../../lib/lists/incoming.ts'
import { authenticateListRequest } from '../../../lib/lists/incomingAuth.ts'

export const prerender = false

// Zweite Linie hinter `MAX_MESSAGE_BYTES` des Workers, für direkte Aufrufe am Worker vorbei.
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

const maxBytes = (): number =>
	Number.parseInt(process.env.MAX_MESSAGE_BYTES ?? `${DEFAULT_MAX_BYTES}`, 10)

const megabytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)

export const POST: APIRoute = async ({ request }) => {
	const rawBody = Buffer.from(await request.arrayBuffer())

	const auth = authenticateListRequest({ headers: request.headers, rawBody })
	if (!auth.ok) {
		return Response.json(
			auth.anAbsender ? { reason: auth.reason } : { error: auth.reason },
			{ status: auth.status },
		)
	}
	const { list, envelopeFrom, messageId } = auth.request

	const limit = maxBytes()
	if (rawBody.length > limit) {
		return Response.json(
			{
				reason: `Nachricht zu groß (${megabytes(rawBody.length)} MB, erlaubt sind ${megabytes(limit)} MB). Bitte große Anhänge verlinken statt anhängen.`,
			},
			{ status: 413 },
		)
	}

	try {
		const result = await handleIncomingListMail(rawBody, {
			listName: list,
			envelopeFrom,
			messageId,
		})
		return Response.json(result, { status: statusForResult(result) })
	} catch (err) {
		// 5xx heißt für den Worker „später erneut zustellen“ – richtig bei einem Fehler auf unserer Seite.
		console.error('[lists/incoming] unerwarteter Fehler', err)
		return Response.json(
			{ error: err instanceof Error ? err.message : String(err) },
			{ status: 500 },
		)
	}
}
