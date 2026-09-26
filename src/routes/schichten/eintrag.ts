import type { APIRoute } from 'astro'
import {
	aendereEintrag,
	eintragLesen,
	loescheEintrag,
	trageEin,
} from '../../lib/db/schichten.ts'
import { besucherLesen, handelnde, nameFuer } from '../besucher.ts'

export const prerender = false

export const POST: APIRoute = async ({ params, request }) => {
	const listId = params.id ?? ''
	const form = await request.formData()
	const feld = (name: string): string | null => {
		const v = form.get(name)
		return typeof v === 'string' ? v : null
	}
	const willJson = (request.headers.get('accept') ?? '').includes(
		'application/json',
	)
	const zurueck = (fehler?: string) =>
		new Response(null, {
			status: 303,
			headers: {
				Location: `/public/schichten/${listId}${fehler ? `?fehler=${encodeURIComponent(fehler)}` : ''}`,
			},
		})
	const antwort = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: {
				'Content-Type': 'application/json; charset=utf-8',
				'Cache-Control': 'no-store',
			},
		})

	const besucher = await besucherLesen(request)
	const wer = handelnde(besucher, feld('edit_token'))

	try {
		switch (feld('aktion') ?? 'eintragen') {
			case 'eintragen': {
				const e = trageEin(
					listId,
					{
						name: nameFuer(besucher, feld('name'), undefined) ?? '',
						shift: feld('shift') ?? '',
						note: feld('note'),
					},
					wer,
				)
				return willJson ? antwort({ ok: true, entry: e }) : zurueck()
			}
			case 'ändern': {
				const vorher = eintragLesen(feld('entry_id') ?? '')
				const e = aendereEintrag(
					feld('entry_id') ?? '',
					{
						name: nameFuer(besucher, feld('name'), vorher?.owner_sub ?? null),
						shift: feld('shift') ?? undefined,
						note: feld('note'),
					},
					wer,
				)
				return willJson ? antwort({ ok: true, entry: e }) : zurueck()
			}
			case 'löschen': {
				loescheEintrag(feld('entry_id') ?? '', wer)
				return willJson ? antwort({ ok: true }) : zurueck()
			}
			default:
				return willJson
					? antwort({ ok: false, fehler: 'Unbekannte Aktion.' }, 400)
					: zurueck('Unbekannte Aktion.')
		}
	} catch (fehler) {
		const text =
			fehler instanceof Error ? fehler.message : 'Das hat nicht geklappt.'
		return willJson ? antwort({ ok: false, fehler: text }, 400) : zurueck(text)
	}
}
