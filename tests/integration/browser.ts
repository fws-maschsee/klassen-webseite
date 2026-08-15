/**
 * Ein Browser, so weit die Anmeldung ihn braucht: ein Keksglas und keine
 * automatischen Umleitungen.
 *
 * Ein echter Browser (Playwright) wäre hier die falsche Wahl, und zwar nicht
 * aus Sparsamkeit: Die Anmeldung dieser Anwendung besteht aus Umleitungen und
 * Cookies, und genau die will ein Test EINZELN sehen. Folgt `fetch` von selbst,
 * ist am Ende nur zu erkennen, dass irgendetwas 200 geworden ist — nicht, ob
 * unterwegs ein `Set-Cookie` fehlte oder eine Umleitung ins Falsche zeigte.
 *
 * Das Keksglas ist absichtlich schlicht: kein Pfad, keine Domain, kein
 * `Secure`. Es gibt genau einen Ursprung (die Testanwendung auf 127.0.0.1), und
 * Regeln, die kein Test benutzt, wären eine zweite, ungetestete
 * Cookie-Implementierung.
 */
export type Browser = {
	/**
	 * Eine Anfrage OHNE automatisches Folgen. `ziel` darf ein Pfad oder eine
	 * vollständige URL auf denselben Ursprung sein — der Rücksprung von ZITADEL
	 * kommt als vollständige URL zurück.
	 */
	gehe: (
		ziel: string,
		optionen?: { accept?: string; method?: string },
	) => Promise<Response>
	/** Der Cookie-Header, den der Browser gerade mitschicken würde. */
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
			// Vorgabe wie bei einem Browser, der eine Seite aufruft. Sie
			// entscheidet mit: `wantsHtml()` in `oidc.ts` schickt eine Seite in die
			// Anmeldung und alles andere in ein 401.
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

/**
 * Wiederholt eine Anfrage, bis sie die erwartete Antwort gibt — oder die Frist
 * abläuft.
 *
 * Gebraucht für den Entzug: `grants.ts` hält die Grants des Projekts fünf
 * Sekunden im Speicher (bewusst, gegen Bündel paralleler Anfragen). Ein festes
 * `sleep(6000)` wäre gleich zweimal falsch — es machte den Testlauf sechs
 * Sekunden lang, egal wie schnell die Wirkung eintritt, und es wäre stumm
 * kaputt, sobald jemand die Haltezeit erhöht. Diese Schleife misst stattdessen,
 * was sie behauptet: dass der Entzug OHNE Zutun des Nutzers wirkt.
 */
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
