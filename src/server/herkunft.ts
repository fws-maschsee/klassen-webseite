import type { RequestHandler } from 'express'

const SICHERE_METHODEN = new Set(['GET', 'HEAD', 'OPTIONS'])

// Genau diese Pfade dürfen von fremden Seiten POSTen: Sie weisen sich selbst aus (Signatur, Bearer,
// OAuth-Client) und werden per Spezifikation von Servern oder Browser-Clients anderer Herkunft gerufen.
export const SELBST_AUSGEWIESENE_PFADE: ReadonlySet<string> = new Set([
	'/token',
	'/register',
	'/revoke',
	'/mcp',
	'/auth/backchannel-logout',
	'/auth/zitadel-events',
	'/api/lists/incoming',
])

export type Herkunftsurteil =
	| { erlaubt: true; ausnahme: boolean }
	| { erlaubt: false; grund: string }

export type HerkunftsAnfrage = {
	method: string
	pfad: string
	secFetchSite: string | undefined
	origin: string | undefined
}

export const pruefeHerkunft = (
	anfrage: HerkunftsAnfrage,
	eigeneOrigin: string,
): Herkunftsurteil => {
	if (SELBST_AUSGEWIESENE_PFADE.has(anfrage.pfad)) {
		return { erlaubt: true, ausnahme: true }
	}
	if (SICHERE_METHODEN.has(anfrage.method.toUpperCase())) {
		return { erlaubt: true, ausnahme: false }
	}

	if (anfrage.secFetchSite !== undefined) {
		if (
			anfrage.secFetchSite === 'same-origin' ||
			anfrage.secFetchSite === 'none'
		) {
			return { erlaubt: true, ausnahme: false }
		}
		return { erlaubt: false, grund: `Sec-Fetch-Site: ${anfrage.secFetchSite}` }
	}

	// Ohne beide Köpfe stammt die Anfrage nicht aus einem Browser, trägt also keinen Keks mit — wie Go's CrossOriginProtection.
	if (anfrage.origin === undefined) return { erlaubt: true, ausnahme: false }
	if (anfrage.origin === eigeneOrigin) return { erlaubt: true, ausnahme: false }
	return { erlaubt: false, grund: `Origin: ${anfrage.origin}` }
}

const einKopf = (wert: string | string[] | undefined): string | undefined =>
	Array.isArray(wert) ? wert.join(',') : wert

export const nurEigeneHerkunft =
	(eigeneBasisUrl: () => string): RequestHandler =>
	(req, res, next) => {
		const urteil = pruefeHerkunft(
			{
				method: req.method,
				pfad: req.path,
				secFetchSite: einKopf(req.headers['sec-fetch-site']),
				origin: einKopf(req.headers.origin),
			},
			new URL(eigeneBasisUrl()).origin,
		)

		if (!urteil.erlaubt) {
			console.warn(
				`[herkunft] ${req.method} ${req.path} abgewiesen (${urteil.grund})`,
			)
			res
				.status(403)
				.type('text/plain; charset=utf-8')
				.send(
					'Abgewiesen: Diese Anfrage kam nicht von dieser Seite. Bitte die Seite neu laden und es dort noch einmal versuchen.',
				)
			return
		}

		// Die Ausnahme gilt nur, solange diese Endpunkte keine Sitzung sehen können — also nehmen wir sie ihnen.
		if (urteil.ausnahme) delete req.headers.cookie

		next()
	}

export const nichtEinbettbar: RequestHandler = (_req, res, next) => {
	res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
	res.setHeader('X-Frame-Options', 'DENY')
	next()
}
