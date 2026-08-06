/**
 * Der Konfigurationsvertrag zwischen diesem Package und einer Klassen-App.
 *
 * Alles, was `klasse-wiesen` und `klasse-christophers` inhaltlich voneinander
 * unterscheidet, steht in diesem Typ — gemessen, nicht geschätzt: von 53
 * gemeinsamen `.ts`-Dateien wichen nur zehn voneinander ab, und in acht davon
 * war die Abweichung genau ein Wert aus dieser Liste. Wer hier ein Feld
 * hinzufügt, hat damit die Erlaubnis, den entsprechenden Wert aus dem
 * geteilten Code zu entfernen; wer im geteilten Code einen Klassennamen fest
 * verdrahtet, macht das Package für die nächste Klasse wertlos.
 */

/**
 * Pfade, die ohne Anmeldung erreichbar bleiben. Die Liste gehört ins Package
 * und nicht in die Klassen-App, weil beide Einträge Zusagen an Software sind,
 * die kein Cookie mitbringen kann:
 *
 * - `/public/` : Der Klassenkalender. Eine Kalender-App meldet sich nirgends
 *   an; wird dieser Pfad geschützt, brechen sämtliche Abos still — ohne
 *   Fehlermeldung bei irgendjemandem.
 * - `/api/lists/` : Die Endpunkte für den Cloudflare-Email-Worker. Sie sind
 *   NICHT ungeschützt, sondern authentifizieren sich über eine HMAC-Signatur
 *   mit dem geteilten `LIST_WEBHOOK_SECRET` (siehe `src/lib/lists/signature.ts`).
 *
 * Diese Liste zu erweitern heißt, Inhalte zu veröffentlichen: `astro build`
 * kompiliert `src/content/` der Klasse (Berichte, Protokolle, Unterlagen) mit
 * ins Image.
 */
export const PUBLIC_PATHS = ['/public/', '/api/lists/'] as const

/** Schulweite Vorgaben. Sie unterscheiden Klassen nicht, sondern Schulen. */
const SCHUL_VORGABEN = {
	/** Muss in SES verifiziert sein, sonst weist SES die Mail ab. */
	mailFrom: 'noreply@fws-maschsee-test.de',
	/**
	 * Basis-Domain der Mailinglisten OHNE Klassen-Label. Der Worker routet
	 * `<liste>@<klasse>.<listBaseDomain>`, siehe `email-worker/README.md`.
	 */
	listBaseDomain: 'lists.fws-maschsee-test.de',
	/** ZITADEL-Projektrolle, die Zugang zur Seite gewährt. */
	authRole: 'mitglied',
} as const

/**
 * Farben der Klasse. Überschreiben die CSS-Variablen des daisyUI-Themes;
 * erwartet werden daisyUI-4-Werte, also `oklch(...)`-Tripel ohne Funktion
 * (z.B. `0.7 0.15 250`) oder gültige CSS-Farben.
 *
 * Optional, weil beide bestehenden Klassen das Standard-Theme benutzen. Das
 * Feld steht trotzdem im Vertrag, damit die dritte Klasse ihr Aussehen nicht
 * über einen Fork des Packages ändern muss.
 */
export type KlassenFarben = {
	primary?: string
	secondary?: string
	accent?: string
	neutral?: string
}

/** Was eine Klassen-App mindestens angeben muss. */
export type KlassenConfigInput = {
	/**
	 * Technischer Name der Klasse, z.B. `klasse-wiesen`. Trägt gleichzeitig
	 * vier Dinge, die zwingend zusammenpassen müssen: Name des
	 * ZITADEL-Projekts, Vorgabe für `MCP_INSTANCE_NAME`, Präfix der
	 * Listen-Domain und Dateiname der SQLite-Datei. Ein Wert statt vier, weil
	 * ein Auseinanderlaufen dieser vier bedeutet, dass Post in der falschen
	 * Klasse landet.
	 */
	slug: string
	/** Anzeigename, z.B. `Klasse Wiesen`. Seitentitel, Kopfzeile, Mails. */
	label: string
	/**
	 * Live-Domain ohne Schema. Daran hängen DNS, Zertifikat und die
	 * Kalender-Abos der Eltern — der Wert ist deshalb nicht vom `slug`
	 * abgeleitet: `klasse-wiesen` läuft bis heute unter `klasse-poellmann.de`.
	 */
	domain: string
	/** GitHub-Repository der Klasse. Quelle für Edit- und Feedback-Links. */
	repoUrl: string
	/** Adresse für Eltern, die angemeldet, aber noch nicht freigeschaltet sind. */
	contactMail: string
	/**
	 * Pfad des Klassenkalenders unterhalb von `public/`, z.B.
	 * `/public/poellmann.ics`; `null`, wenn die Klasse keinen Kalender anbietet.
	 *
	 * Muss unter einem Pfad aus `PUBLIC_PATHS` liegen — sonst verlangt die
	 * Middleware eine Anmeldung und jedes bestehende Abo hört still auf zu
	 * aktualisieren. Genau das ist in `klasse-christophers` sieben Monate lang
	 * unbemerkt passiert, weshalb `defineKlassenConfig` es hier ablehnt statt
	 * es zu dokumentieren.
	 */
	calendarPath: string | null

	/** Vorgabe: `https://${domain}`. */
	siteUrl?: string
	/**
	 * Domain, unter der die Seite in Plausible angelegt ist. Vorgabe:
	 * `domain`. Bewusst getrennt, weil eine umgezogene Seite ihre Statistik
	 * behalten soll.
	 */
	analyticsDomain?: string
	/** Vorgabe: `mitglied`. Muss im ZITADEL-Projekt `zitadelProject` existieren. */
	authRole?: string
	/** Vorgabe: `slug`. Nur dann setzen, wenn das Projekt anders heißt. */
	zitadelProject?: string
	/** Vorgabe: `lists.fws-maschsee-test.de`. */
	listBaseDomain?: string
	/** Vorgabe: `${slug}.${listBaseDomain}`. */
	listDomain?: string
	/** Vorgabe: `noreply@fws-maschsee-test.de` (in SES verifiziert). */
	mailFrom?: string
	/**
	 * Vorgabe: `./data/${slug}.db`. Der Dateiname trägt den Slug, damit schon
	 * im Dateisystem sichtbar ist, zu welcher Klasse die Daten gehören.
	 */
	dbPath?: string
	/** Untertitel in der Kopfzeile. Vorgabe: `Unterlagen und Berichte`. */
	tagline?: string
	/**
	 * Wohin die Startseite für Rückmeldungen verweist. Vorgabe:
	 * `${repoUrl}/issues`. `klasse-christophers` zeigt auf `/discussions`.
	 */
	feedbackUrl?: string
	/** Optionale Farbabweichung vom Standard-Theme. */
	farben?: KlassenFarben
}

/** Aufgelöste Konfiguration: keine Vorgaben mehr offen. */
export type KlassenConfig = Required<
	Omit<KlassenConfigInput, 'calendarPath' | 'farben'>
> & {
	calendarPath: string | null
	farben: KlassenFarben
}

const SLUG_MUSTER = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Prüft und vervollständigt die Konfiguration einer Klasse.
 *
 * Die Prüfungen sind alle gegen echte Vorfälle geschrieben, nicht gegen
 * denkbare: der verschobene Kalender, der Slug mit Großbuchstaben, der als
 * Domain eingetragene URL-String.
 */
export const defineKlassenConfig = (
	input: KlassenConfigInput,
): KlassenConfig => {
	const fehler: string[] = []

	if (!SLUG_MUSTER.test(input.slug)) {
		fehler.push(
			`slug "${input.slug}" muss aus Kleinbuchstaben, Ziffern und Bindestrichen bestehen — er wird als Teil einer Mail-Domain und eines Dateinamens benutzt`,
		)
	}
	if (input.domain.includes('/') || input.domain.includes(':')) {
		fehler.push(
			`domain "${input.domain}" ist eine Domain, keine URL — ohne Schema und ohne Pfad angeben`,
		)
	}
	if (!input.contactMail.includes('@')) {
		fehler.push(`contactMail "${input.contactMail}" ist keine Mailadresse`)
	}
	if (!/^https?:\/\//.test(input.repoUrl)) {
		fehler.push(`repoUrl "${input.repoUrl}" muss mit http(s):// beginnen`)
	}
	if (
		input.calendarPath !== null &&
		!PUBLIC_PATHS.some((prefix) => input.calendarPath?.startsWith(prefix))
	) {
		fehler.push(
			`calendarPath "${input.calendarPath}" liegt nicht unter einem oeffentlichen Pfad (${PUBLIC_PATHS.join(', ')}) — dort verlangt die Middleware eine Anmeldung, und Kalender-Abos brechen still ab`,
		)
	}

	if (fehler.length > 0) {
		throw new Error(
			`Ungueltige KlassenConfig:\n  - ${fehler.join('\n  - ')}\n(siehe src/site.config.ts der Klassen-App)`,
		)
	}

	const listBaseDomain = input.listBaseDomain ?? SCHUL_VORGABEN.listBaseDomain

	return {
		slug: input.slug,
		label: input.label,
		domain: input.domain,
		repoUrl: input.repoUrl,
		contactMail: input.contactMail,
		calendarPath: input.calendarPath,
		siteUrl: input.siteUrl ?? `https://${input.domain}`,
		analyticsDomain: input.analyticsDomain ?? input.domain,
		authRole: input.authRole ?? SCHUL_VORGABEN.authRole,
		zitadelProject: input.zitadelProject ?? input.slug,
		listBaseDomain,
		listDomain: input.listDomain ?? `${input.slug}.${listBaseDomain}`,
		mailFrom: input.mailFrom ?? SCHUL_VORGABEN.mailFrom,
		dbPath: input.dbPath ?? `./data/${input.slug}.db`,
		tagline: input.tagline ?? 'Unterlagen und Berichte',
		feedbackUrl: input.feedbackUrl ?? `${input.repoUrl}/issues`,
		farben: input.farben ?? {},
	}
}

let angemeldet: KlassenConfig | null = null

/**
 * Hinterlegt die Konfiguration der laufenden Klasse.
 *
 * Es gibt zwei Prozesse, die den geteilten Code laden, und sie teilen keinen
 * Modulzustand: der Astro-Server (dort ruft `fwsKlasse()` über sein virtuelles
 * Modul auf) und der Express-Entrypoint `server.ts` (dort ruft `startServer()`
 * auf). Deshalb ein Register statt eines Imports — ein Import müsste in beiden
 * Prozessen auf dieselbe Datei zeigen, und die liegt in der Klassen-App, die
 * dieses Package nicht kennt.
 */
export const setKlassenConfig = (config: KlassenConfig): KlassenConfig => {
	angemeldet = config
	return config
}

/** Nur für Tests: Register leeren. */
export const resetKlassenConfig = (): void => {
	angemeldet = null
}

/**
 * Die Konfiguration der laufenden Klasse.
 *
 * Wirft, wenn sie fehlt, statt eine Vorgabe zu erfinden: eine erfundene
 * Vorgabe wäre ein Klassenname, und ein falscher Klassenname bedeutet Versand
 * an die falsche Elternschaft.
 */
export const klassenConfig = (): KlassenConfig => {
	if (!angemeldet) {
		throw new Error(
			'Keine KlassenConfig hinterlegt. Die Astro-App bekommt sie ueber die Integration `fwsKlasse({ config })` in astro.config.mjs, der Express-Entrypoint ueber `startServer(config)` bzw. `setKlassenConfig(config)`, Tests ueber ihre Setup-Datei.',
		)
	}
	return angemeldet
}
