/**
 * Die Auskunft von `/public/health`: WELCHER Stand läuft hier gerade?
 *
 * Der Anlass ist eine Frage, die sich vom Schreibtisch aus nicht beantworten
 * ließ: Ob in Produktion schon der Stand läuft, der Listenmails mit Ed25519
 * annimmt. Zu sehen war nur, dass `main` weitergelaufen ist — nicht, was das
 * Cluster davon hat. Zwischen beidem lagen fünf Tage, in denen jeder Deploy im
 * Checkout scheiterte, ohne dass es jemandem auffiel.
 *
 * Deshalb nennt diese Auskunft nicht nur „ok", sondern den Commit. Ein
 * Gesundheitsendpunkt, der immer „ok" sagt, beantwortet die einzige Frage
 * nicht, die man ihm im Ernstfall stellt.
 *
 * **Die Feldnamen sind englisch, die Kommentare deutsch.** Das ist kein
 * Versehen: Die Nutzlast liest ein Programm — eine Probe, ein Skript, ein
 * Monitoring —, und für Maschinen wird englisch benannt. Die Begründungen
 * daneben liest ein Mensch.
 *
 * Zwei Dinge stehen NICHT drin, obwohl sie hierher passen würden:
 *
 * - **Keine Zahlen aus der Datenbank.** Der Endpunkt liegt unter `/public/` und
 *   ist damit ohne Anmeldung erreichbar (`PUBLIC_PATHS` in `config.ts`, dort
 *   schon für den Kalender). Wie viele Eltern eine Klasse hat, ist niemandes
 *   Sache außer ihrer eigenen — und der Grund, warum `PUBLIC_PATHS` selbst
 *   unverändert bleiben durfte: Der Endpunkt fügt keinen neuen offenen Pfad
 *   hinzu, er nutzt den, der es schon ist.
 * - **Kein Zustand des Mailversands.** Ein Rückstau in der Warteschlange ist
 *   kein Grund, den Pod neu zu starten — und genau das täte Kubernetes, wenn
 *   eine Probe darauf zeigt.
 *
 * Die Commits kommen aus der Umgebung, nicht aus git: Im Image gibt es kein
 * `.git`. Sie werden beim Bauen als `ARG` hineingegeben (siehe `Dockerfile` und
 * `.github/workflows/deploy.yml` der Klasse). Fehlen sie, steht `unknown` dort —
 * und das ist die ehrliche Antwort, nicht ein Fehler: Ein Build von Hand hat
 * keinen Commit, den er nennen könnte.
 */

/** Was dort steht, wenn beim Bauen kein Commit mitgegeben wurde. */
export const UNKNOWN = 'unknown'

/**
 * Die Verfahren, mit denen eingehende Listenmails beglaubigt werden können. Es
 * ist genau eines — `hmac` stand hier, solange die alten Worker je Klasse noch
 * einlieferten (siehe `src/lib/lists/incomingAuth.ts`). Die Liste bleibt eine
 * Liste, weil ein Wechsel des Verfahrens wieder eine Übergangszeit mit zwei
 * Einträgen hätte, und weil ein leerer Eintrag die Aussage trägt, auf die es
 * hier ankommt: Dann kommt keine Listenmail durch.
 */
export type SignatureScheme = 'ed25519'

export type HealthReport = {
	status: 'ok'
	/** Klasse, zu der dieses Deployment gehört. */
	instance: string
	/** Commit des Klassen-Repos, aus dem das Image gebaut wurde. */
	commit: string
	/** Commit des geteilten Codes (Stand des Submodules `geteilt/`). */
	shared: string
	/** Zeitpunkt des Builds, ISO-8601, oder `null`. */
	builtAt: string | null
	lists: {
		/**
		 * Welche Signaturverfahren `/api/lists/incoming` annimmt.
		 *
		 * LEER heißt: Es kommt keine Listenmail durch. Das ist keine Störung des
		 * Betriebs, sondern eine fehlende Konfiguration — und der Grund, warum
		 * die Liste hier auftaucht statt in einem Log, das niemand liest.
		 */
		schemes: readonly SignatureScheme[]
		/**
		 * Die Kennungen der akzeptierten Ed25519-Schlüssel. Kein Geheimnis: Sie
		 * sind aus dem ÖFFENTLICHEN Schlüssel abgeleitet. Beim Schlüsselwechsel
		 * ist das die Stelle, an der man sieht, welche Klasse den neuen schon
		 * kennt.
		 */
		keyIds: readonly string[]
	}
}

/** Die Umgebungswerte, die beim Bauen gesetzt werden. */
export type BuildEnv = {
	BUILD_COMMIT?: string | undefined
	BUILD_SHARED?: string | undefined
	BUILD_TIME?: string | undefined
}

export type HealthInput = {
	instance: string
	env: BuildEnv
	/** Aus der `KlassenConfig`; leer, wenn kein Schlüssel konfiguriert ist. */
	listKeyIds: readonly string[]
	/** Ob ein öffentlicher Schlüssel hinterlegt ist. */
	hasPublicKey: boolean
}

const filled = (wert: string | undefined): string | undefined => {
	const getrimmt = wert?.trim()
	return getrimmt ? getrimmt : undefined
}

/**
 * Baut die Auskunft. Reine Funktion — kein `process.env`, keine Datenbank, kein
 * Astro. Die Route darunter ist deshalb ein Dreizeiler, und die Regeln oben
 * sind ohne laufende Anwendung prüfbar.
 */
export const healthReport = (input: HealthInput): HealthReport => {
	const schemes: SignatureScheme[] = []
	// Dieselbe Bedingung wie in `incomingAuth.ts`: ein Verfahren gilt erst als
	// vorhanden, wenn es auch etwas hat, womit es prüfen kann. Sonst meldete
	// dieser Endpunkt „ed25519" und die Mail bekäme trotzdem ein 401.
	if (input.hasPublicKey && input.listKeyIds.length > 0) {
		schemes.push('ed25519')
	}

	return {
		status: 'ok',
		instance: input.instance,
		commit: filled(input.env.BUILD_COMMIT) ?? UNKNOWN,
		shared: filled(input.env.BUILD_SHARED) ?? UNKNOWN,
		builtAt: filled(input.env.BUILD_TIME) ?? null,
		lists: {
			schemes,
			keyIds: input.listKeyIds,
		},
	}
}
