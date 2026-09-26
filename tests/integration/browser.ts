export type Browser = {
	gehe: (
		ziel: string,
		optionen?: { accept?: string; method?: string },
	) => Promise<Response>
	kekse: () => string
}

const keksNamen = (setCookie: string): string =>
	setCookie.slice(0, setCookie.indexOf('=')).trim()

const abgelaufen = (setCookie: string): boolean =>
	/;\s*max-age=0\b/i.test(setCookie)

export const browserAufmachen = (basis: string): Browser => {
	const glas = new Map<string, string>()

	const kekse = (): string =>
		[...glas.entries()].map(([name, wert]) => `${name}=${wert}`).join('; ')

	const gehe = async (
		ziel: string,
		optionen: { accept?: string; method?: string } = {},
	): Promise<Response> => {
		const url = new URL(ziel, basis)
		const kopfzeilen: Record<string, string> = {
			accept: optionen.accept ?? 'text/html,application/xhtml+xml',
		}
		const vorhanden = kekse()
		if (vorhanden) kopfzeilen.cookie = vorhanden

		const antwort = await fetch(url, {
			method: optionen.method ?? 'GET',
			headers: kopfzeilen,
			redirect: 'manual',
		})

		for (const gesetzt of antwort.headers.getSetCookie()) {
			const name = keksNamen(gesetzt)
			if (!name) continue
			if (abgelaufen(gesetzt)) {
				glas.delete(name)
				continue
			}
			const wert = gesetzt.slice(gesetzt.indexOf('=') + 1).split(';')[0] ?? ''
			glas.set(name, decodeURIComponent(wert))
		}

		return antwort
	}

	return { gehe, kekse }
}

export const bisAntwort = async (
	anfrage: () => Promise<Response>,
	erfuellt: (antwort: Response) => boolean,
	frist = 30_000,
): Promise<Response> => {
	const ende = Date.now() + frist
	let letzte = await anfrage()
	while (!erfuellt(letzte) && Date.now() < ende) {
		await new Promise((fertig) => setTimeout(fertig, 250))
		letzte = await anfrage()
	}
	return letzte
}
