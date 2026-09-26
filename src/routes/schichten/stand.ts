import type { APIRoute } from 'astro'
import { eintraegeLesen, standLesen } from '../../lib/db/schichten.ts'
import { besucherLesen } from '../besucher.ts'

export const prerender = false

export const GET: APIRoute = async ({ params, url, request }) => {
	const stand = standLesen(params.id ?? '')
	if (!stand)
		return new Response('Diesen Schichtplan gibt es nicht.', { status: 404 })
	const ab = Number(url.searchParams.get('ab'))
	if (Number.isInteger(ab) && ab === stand.list.revision) {
		return new Response(null, {
			status: 304,
			headers: { 'Cache-Control': 'no-store' },
		})
	}
	const besucher = await besucherLesen(request)
	const eigene = new Set(
		besucher.sub
			? eintraegeLesen(stand.list.id)
					.filter((e) => e.owner_sub === besucher.sub)
					.map((e) => e.id)
			: [],
	)
	const antwort = {
		...stand,
		admin: besucher.admin,
		entries: stand.entries.map((e) => ({ ...e, own: eigene.has(e.id) })),
	}
	return new Response(JSON.stringify(antwort), {
		status: 200,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	})
}
