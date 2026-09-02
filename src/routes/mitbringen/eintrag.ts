import type { APIRoute } from 'astro'
import {
	aendereEintrag,
	loescheEintrag,
	trageEin,
} from '../../lib/db/mitbringen.ts'
import { besucherLesen, handelnde } from './gemeinsam.ts'

export const prerender = false

/**
 * `POST /public/mitbringen/<id>/eintrag` — eintragen, aendern, loeschen.
 *
 * Ein Endpunkt fuer alle drei, unterschieden ueber `aktion`
 * (`eintragen` | `aendern` | `loeschen`), weil ein HTML-Formular nur POST kann
 * und die Seite auch ohne JavaScript funktionieren soll. Mit JavaScript schickt
 * die Seite dasselbe Formular per `fetch` und bekommt JSON; ohne bekommt sie
 * eine Umleitung zurueck auf die Liste, mit `?fehler=` im schlimmsten Fall.
 *
 * Wer aendern darf, entscheidet `darfEintragAendern` in der Datenbankschicht —
 * hier wird nur eingesammelt, wer da ist: Sitzung (falls vorhanden) und der
 * Bearbeitungsschluessel aus dem Formular, den der Browser beim Eintragen
 * bekommen und behalten hat.
 */
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
				Location: `/public/mitbringen/${listId}${fehler ? `?fehler=${encodeURIComponent(fehler)}` : ''}`,
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
						name: feld('name') ?? '',
						item: feld('item') ?? '',
						category: feld('category'),
						amount: feld('amount'),
					},
					wer,
				)
				// Der Bearbeitungsschluessel geht GENAU EINMAL an den Browser, der
				// eingetragen hat. Ohne JavaScript geht er verloren — dann kann nur
				// noch ein admin den Eintrag aendern; das ist der Preis des
				// Formulars ohne Skript, nicht ein Fehler.
				return willJson ? antwort({ ok: true, entry: e }) : zurueck()
			}
			case 'aendern': {
				const e = aendereEintrag(
					feld('entry_id') ?? '',
					{
						name: feld('name') ?? undefined,
						item: feld('item') ?? undefined,
						category: feld('category'),
						amount: feld('amount'),
					},
					wer,
				)
				return willJson ? antwort({ ok: true, entry: e }) : zurueck()
			}
			case 'loeschen': {
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
