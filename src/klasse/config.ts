import { listKeyIdFromPem } from '../lib/lists/signatureEd25519.ts'

// Kalender-Apps und der Listen-Dispatcher bringen kein Cookie mit; /api/lists/ prüft stattdessen die Ed25519-Signatur.
export const PUBLIC_PATHS = ['/public/', '/api/lists/'] as const

const SCHUL_VORGABEN = {
	// Muss in SES verifiziert sein, sonst weist SES die Mail ab.
	mailFrom: 'noreply@fws-maschsee-test.de',
	listBaseDomain: 'lists.fws-maschsee-test.de',
	authRole: 'mitglied',
	// Kein Geheimnis: Ed25519 statt HMAC, damit der Prüfschlüssel offen im Package stehen kann.
	listPublicKeyPem: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAjYOv8AXbp+JScJ653wMEtv6lARyphIakIIRKQ+OT4IQ=
-----END PUBLIC KEY-----
`,
	// Liste statt Einzelwert, damit beim Schlüsselwechsel die neue Id vorab aufgenommen werden kann.
	listKeyIds: ['bf2226d575ece8c8'] as readonly string[],
} as const

// Vollständige CSS-Farbwerte (daisyUI 5), keine zerlegten Kanäle wie in daisyUI 4.
export type KlassenFarben = {
	primary?: string
	secondary?: string
	accent?: string
	neutral?: string
}

export type Blatt = {
	pfad: string
	quelle: string
	dateiname: string
}

export type KlassenConfigInput = {
	slug: string
	label: string
	teacher?: string
	grade?: string
	// Nicht aus dem slug abgeleitet: DNS und Zertifikat hängen daran, und eine Klasse kann umziehen.
	domain: string
	repoUrl: string
	contactMail: string
	contactName?: string
	calendarPath: string | null

	blaetter?: readonly Blatt[]

	// Nur die alte Adresse leitet um; calendarPath selbst nie, Kalender-Clients (Apple: Fehler -1007) scheitern an 301.
	calendarLegacyPath?: string | null

	siteUrl?: string
	// Getrennt von domain, damit eine umgezogene Seite ihre Plausible-Statistik behält.
	analyticsDomain?: string
	authRole?: string
	zitadelProject?: string
	listBaseDomain?: string
	listDomain?: string
	listPublicKeyPem?: string
	listKeyIds?: readonly string[]
	mailFrom?: string
	dbPath?: string
	tagline?: string
	schuljahr?: string
	feedbackUrl?: string
	farben?: KlassenFarben
}

export type KlassenConfig = Required<
	Omit<KlassenConfigInput, 'calendarPath' | 'calendarLegacyPath' | 'farben'>
> & {
	calendarPath: string | null
	calendarLegacyPath: string | null
	farben: KlassenFarben
}

const SLUG_MUSTER = /^[a-z0-9]+(-[a-z0-9]+)*$/

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

	for (const blatt of input.blaetter ?? []) {
		if (!blatt.pfad.startsWith('/') || !blatt.pfad.endsWith('.pdf')) {
			fehler.push(
				`blaetter: pfad "${blatt.pfad}" muss mit "/" beginnen und auf ".pdf" enden`,
			)
		}
		// Beim Start prüfen, weil ein offen liegendes Blatt sonst nirgends auffällt.
		if (PUBLIC_PATHS.some((prefix) => blatt.pfad.startsWith(prefix))) {
			fehler.push(
				`blaetter: pfad "${blatt.pfad}" liegt unter einem oeffentlichen Pfad (${PUBLIC_PATHS.join(', ')}) — das Blatt waere ohne Anmeldung abrufbar`,
			)
		}
		if (!blatt.quelle.startsWith('src/') || !blatt.quelle.endsWith('.typ')) {
			fehler.push(
				`blaetter: quelle "${blatt.quelle}" muss eine .typ-Datei unter src/ sein — nur dieses Verzeichnis kommt ins Laufzeit-Image`,
			)
		}
	}

	const calendarLegacyPath = input.calendarLegacyPath ?? null
	if (calendarLegacyPath !== null) {
		if (input.calendarPath === null) {
			fehler.push(
				`calendarLegacyPath "${calendarLegacyPath}" ist gesetzt, calendarPath aber null — eine Umleitung ohne Ziel`,
			)
		}
		if (calendarLegacyPath === input.calendarPath) {
			fehler.push(
				`calendarLegacyPath "${calendarLegacyPath}" ist derselbe Pfad wie calendarPath — das leitet auf sich selbst um`,
			)
		}
	}

	// Leer heißt „ableiten“ und muss durchgehen, weil eine aufgelöste Config erneut hier durchlaufen darf.
	if (input.schuljahr) {
		const teile = /^(\d{4})\/(\d{4})$/.exec(input.schuljahr)
		if (!teile || Number(teile[2]) !== Number(teile[1]) + 1) {
			fehler.push(
				`schuljahr "${input.schuljahr}" muss "JJJJ/JJJJ" mit aufeinanderfolgenden Jahren sein, z.B. "2026/2027"`,
			)
		}
	}

	const listPublicKeyPem =
		input.listPublicKeyPem ?? SCHUL_VORGABEN.listPublicKeyPem
	const listKeyIds = input.listKeyIds ?? SCHUL_VORGABEN.listKeyIds

	// Passt die Id nicht zum PEM, bleibt jede Listenmail still beim Absender hängen — deshalb schon beim Start prüfen.
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
		teacher: input.teacher ?? '',
		grade: input.grade ?? '',
		domain: input.domain,
		repoUrl: input.repoUrl,
		contactMail: input.contactMail,
		contactName: input.contactName ?? '',
		calendarPath: input.calendarPath,
		blaetter: input.blaetter ?? [],
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
		schuljahr: input.schuljahr ?? '',
		feedbackUrl: input.feedbackUrl ?? `${input.repoUrl}/issues`,
		farben: input.farben ?? {},
	}
}

// Nimmt die Config als Argument: die Integration ruft das auf, bevor setKlassenConfig gelaufen ist.
export const bearbeitenUrl = (
	config: KlassenConfig,
	pfadImRepo: string,
): string => `${config.repoUrl}/edit/main/${pfadImRepo}`

// Kein Feld der KlassenConfig: für alle Klassen gleich, eine abweichende Klasse hätte nur einen toten Link.
const KONTO_BASIS = 'https://konto.fws-maschsee-test.de'

export const kontaktbuchUrl = (config: KlassenConfig): string =>
	`${KONTO_BASIS}/klasse/${config.slug}`

// Register statt Import: Astro-Server und Express-Entrypoint laden den Code getrennt, und die Config liegt in der Klassen-App.
let angemeldet: KlassenConfig | null = null

export const setKlassenConfig = (config: KlassenConfig): KlassenConfig => {
	angemeldet = config
	return config
}

export const resetKlassenConfig = (): void => {
	angemeldet = null
}

export const klassenConfig = (): KlassenConfig => {
	if (!angemeldet) {
		throw new Error(
			'Keine KlassenConfig hinterlegt. Die Astro-App bekommt sie ueber die Integration `fwsKlasse({ config })` in astro.config.mjs, der Express-Entrypoint ueber `startServer(config)` bzw. `setKlassenConfig(config)`, Tests ueber ihre Setup-Datei.',
		)
	}
	return angemeldet
}

// Funktion statt Konstante, sonst bindet schon der Import an eine hinterlegte Config.
export const zustaendigkeit = (): string => {
	const { contactName, contactMail } = klassenConfig()
	return contactName ? `${contactName} (${contactMail})` : contactMail
}

export const wemGehoertDieSeite = (): string => {
	const { teacher, grade, label } = klassenConfig()
	if (teacher && grade) return `${teacher}, ${grade}`
	return teacher || grade || label
}
