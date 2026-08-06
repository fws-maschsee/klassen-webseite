import { listKeyIdFromPem } from '../lib/lists/signatureEd25519.ts'

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
 *   NICHT ungeschützt, sondern signaturgeprüft — beim zonenweiten Dispatcher
 *   per Ed25519 gegen `listPublicKeyPem`, bei den alten Workern je Klasse per
 *   HMAC gegen `LIST_WEBHOOK_SECRET` (siehe `src/lib/lists/incomingAuth.ts`).
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
	/**
	 * Öffentlicher Ed25519-Schlüssel des zonenweiten Dispatchers, mit dem die
	 * eingehende Listenmail geprüft wird (`src/lib/lists/signatureEd25519.ts`).
	 *
	 * Steht hier im Klartext, weil er KEIN Geheimnis ist: Damit lassen sich
	 * Aufrufe prüfen, aber keine erzeugen — genau das ist der Grund für Ed25519
	 * statt HMAC. Den Privatschlüssel hat allein der Dispatcher. Derselbe Wert
	 * für alle Klassen, also gehört er ins Package und nicht in n Repositories:
	 * ein Schlüsselwechsel ist damit eine Paketversion und kein Rundlauf durch
	 * alle Klassen-Repos.
	 */
	listPublicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAjYOv8AXbp+JScJ653wMEtv6lARyphIakIIRKQ+OT4IQ=
-----END PUBLIC KEY-----
`,
	/**
	 * Akzeptierte Key-Ids. Eine LISTE, damit ein Schlüsselwechsel möglich ist,
	 * ohne alle Klassen gleichzeitig anzufassen: Die neue Id kann vorab
	 * aufgenommen werden, und erst danach stellt der Dispatcher um.
	 *
	 * Die Id ist aus `listPublicKeyPem` abgeleitet und nicht frei gewählt;
	 * `defineKlassenConfig` rechnet sie nach.
	 */
	listKeyIds: ['bf2226d575ece8c8'] as readonly string[],
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
	 * Die Adresse, unter der die Instanz JETZT erreichbar ist — ohne Schema.
	 *
	 * Der Wert ist technisch und nicht historisch: aus ihm leitet sich `siteUrl`
	 * ab, und daraus die `redirect_uri` der Anmeldung. Er muss deshalb dem
	 * Ingress-Host entsprechen (`OIDC_PUBLIC_ORIGIN`, `PUBLIC_BASE_URL`), und die
	 * Adresse muss am OIDC-Client hinterlegt sein. Eine alte Domain, die nur noch
	 * `301` liefert, ergibt hier eine `redirect_uri`, die ZITADEL nicht kennt —
	 * die Anmeldung bricht dann mit einem Fehler von ZITADEL ab, nicht mit einer
	 * Meldung dieser App.
	 *
	 * Nicht vom `slug` abgeleitet, weil DNS und Zertifikat daran hängen und eine
	 * Klasse umziehen kann. Wo der alte Name ein SCHLÜSSEL ist und keine Adresse,
	 * lebt er in eigenen Feldern weiter: `analyticsDomain` (Plausible verwirft
	 * sonst jedes Ereignis) und `calendarPath` (die Abos der Eltern).
	 */
	domain: string
	/** GitHub-Repository der Klasse. Quelle für Edit- und Feedback-Links. */
	repoUrl: string
	/** Adresse für Eltern, die angemeldet, aber noch nicht freigeschaltet sind. */
	contactMail: string
	/**
	 * Name der Person hinter `contactMail` — wer Freigaben vergibt und
	 * Abmeldungen einträgt. Optional; ohne ihn nennen die Texte nur die Adresse.
	 *
	 * Steht neben `contactMail` und nicht im geteilten Code, weil das eine
	 * Zuständigkeit ist und keine Eigenschaft der Software: Sie wechselt, wenn
	 * jemand anderes die Klasse übernimmt, und sie kann je Klasse verschieden
	 * sein. Beide bestehenden Klassen tragen heute denselben Wert ein — genau
	 * das ist der Grund, den Namen NICHT fest zu verdrahten: sonst nennt die
	 * dritte Klasse den Namen der ersten neben der eigenen Adresse, und niemand
	 * bemerkt es, weil die Adresse ja stimmt.
	 */
	contactName?: string
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

	/**
	 * Eine frühere Adresse des Kalenders, die dauerhaft auf `calendarPath`
	 * umgeleitet wird. Vorgabe `null` — die meisten Klassen haben keine.
	 *
	 * `klasse-christophers` hat eine: Zwischen der Astro-Umstellung und deren
	 * Korrektur lag die Datei sieben Monate unter `/christophers.ics`. Wer in
	 * diesem Zeitraum abonniert hat, hängt an dieser Adresse und darf nicht ein
	 * zweites Mal stillschweigend herausfallen.
	 *
	 * Die Umleitung trägt bewusst NUR diese Seite. Der Pfad mit den echten Abos
	 * (`calendarPath`) wird direkt als Datei ausgeliefert, ohne Umleitung: Ein
	 * 301 ist für Kalender-Clients kein sicherer Weg — Apples Kalender quittiert
	 * Umleitungen dokumentiert mit Fehler -1007, und Googles Importer scheitert
	 * an ihnen ebenfalls. Ein 301 auf dem Pfad mit den echten Abos wäre also
	 * genau der Ausfall, den er verhindern soll.
	 *
	 * `startServer` mountet die Umleitung VOR `express.static`, damit sie auch
	 * dann greift, wenn wieder eine Datei an der alten Stelle landet.
	 */
	calendarLegacyPath?: string | null

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
	/**
	 * Öffentlicher Ed25519-Schlüssel des Dispatchers, SPKI-PEM. Vorgabe: der
	 * Schlüssel der Schule, siehe `SCHUL_VORGABEN`. Kein Geheimnis.
	 *
	 * Nur setzen, wenn eine Klasse an einem anderen Dispatcher hängt — oder in
	 * Tests, die selbst ein Schlüsselpaar erzeugen. Wer ihn setzt, muss
	 * `listKeyIds` mitsetzen: Die Id des Schlüssels muss darin vorkommen, sonst
	 * lehnt `defineKlassenConfig` ab.
	 */
	listPublicKeyPem?: string
	/**
	 * Akzeptierte Key-Ids des Dispatchers. Vorgabe: die Id des Schlüssels aus
	 * `SCHUL_VORGABEN`. Muss die Id von `listPublicKeyPem` enthalten.
	 */
	listKeyIds?: readonly string[]
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
	Omit<KlassenConfigInput, 'calendarPath' | 'calendarLegacyPath' | 'farben'>
> & {
	calendarPath: string | null
	calendarLegacyPath: string | null
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

	const calendarLegacyPath = input.calendarLegacyPath ?? null
	if (calendarLegacyPath !== null) {
		// Eine Umleitung braucht ein Ziel. Ohne `calendarPath` zeigte sie ins
		// Leere — und zwar fuer genau die Abos, die sie retten soll.
		if (input.calendarPath === null) {
			fehler.push(
				`calendarLegacyPath "${calendarLegacyPath}" ist gesetzt, calendarPath aber null — eine Umleitung ohne Ziel`,
			)
		}
		// Ein Pfad, der auf sich selbst umleitet, ist eine Endlosschleife und
		// keine Rettung.
		if (calendarLegacyPath === input.calendarPath) {
			fehler.push(
				`calendarLegacyPath "${calendarLegacyPath}" ist derselbe Pfad wie calendarPath — das leitet auf sich selbst um`,
			)
		}
	}

	const listPublicKeyPem =
		input.listPublicKeyPem ?? SCHUL_VORGABEN.listPublicKeyPem
	const listKeyIds = input.listKeyIds ?? SCHUL_VORGABEN.listKeyIds

	// Schlüssel und Id nachrechnen, statt beide nur nebeneinander zu glauben.
	// Ein PEM ohne die dazu passende Id in der Positivliste kann NIE eine
	// Signatur bestätigen: Jede Elternmail bliebe mit "Unbekannte Key-Id" beim
	// absendenden Server hängen, tagelang, ohne Fehlermeldung an irgendjemanden.
	// Das ist genau die Sorte Fehler, die beim Start auffallen muss.
	if (listKeyIds.length === 0) {
		fehler.push('listKeyIds ist leer — damit kommt keine Listenmail durch')
	} else {
		try {
			const abgeleitet = listKeyIdFromPem(listPublicKeyPem)
			if (!listKeyIds.includes(abgeleitet)) {
				fehler.push(
					`listKeyIds (${listKeyIds.join(', ')}) enthaelt nicht die Id des Schluessels in listPublicKeyPem (${abgeleitet}) — Schluessel und Id gehoeren zusammen`,
				)
			}
		} catch (error) {
			fehler.push((error as Error).message)
		}
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
		contactName: input.contactName ?? '',
		calendarPath: input.calendarPath,
		calendarLegacyPath,
		siteUrl: input.siteUrl ?? `https://${input.domain}`,
		analyticsDomain: input.analyticsDomain ?? input.domain,
		authRole: input.authRole ?? SCHUL_VORGABEN.authRole,
		zitadelProject: input.zitadelProject ?? input.slug,
		listBaseDomain,
		listDomain: input.listDomain ?? `${input.slug}.${listBaseDomain}`,
		listPublicKeyPem,
		listKeyIds,
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

/**
 * Wer für Freigaben und Abmeldungen zuständig ist, als Klartext für
 * Fehlermeldungen: `Name (adresse)`, oder nur die Adresse, wenn kein Name
 * hinterlegt ist.
 *
 * Eine Funktion und keine Konstante, weil die Konfiguration erst zur Laufzeit
 * im Register liegt — eine Modulkonstante würde jeden Import dieses Packages
 * an eine hinterlegte Config binden (siehe `tests/server/importzeit.test.ts`).
 *
 * Für Oberflächen, die einen `mailto:`-Link setzen wollen, ist sie das falsche
 * Werkzeug: die lesen `contactName` und `contactMail` einzeln aus
 * `klassenConfig()`, sonst steckt die Adresse im Linktext statt im Ziel.
 */
export const zustaendigkeit = (): string => {
	const { contactName, contactMail } = klassenConfig()
	return contactName ? `${contactName} (${contactMail})` : contactMail
}
