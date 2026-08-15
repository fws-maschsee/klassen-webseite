import type { Database } from 'better-sqlite3'
import { berlinZeitpunkt } from '../lib/berlinZeit.ts'
import { getGroup } from '../lib/db/groups.ts'
import { openDb } from '../lib/db/index.ts'
import {
	beanspruchtErinnerung,
	gibErinnerungFrei,
	schliesstErinnerungAb,
} from '../lib/db/putzplanReminders.ts'
import { globallySuppressedAddresses } from '../lib/db/suppressions.ts'
import { mailFrom, mailFromName, siteUrl } from '../lib/email/config.ts'
import type { EmailTransport, SendInput } from '../lib/email/transport.ts'
import { sesTransport } from '../lib/email/transport.ts'
import type { AccountCheckReport } from '../lib/versand/kontopruefung.ts'
import {
	berichtAlsText,
	hatBefund,
	pruefeKonten,
} from '../lib/versand/kontopruefung.ts'
import { klassenConfig } from './config.ts'
import { datumIso } from './putzplan.ts'

/**
 * Die Erinnerung an den Putzdienst: Sonntags um 17 Uhr erfahren die Familien,
 * die am kommenden Freitag dran sind, dass sie dran sind.
 *
 * Der Putzplan steht seit jeher auf der Seite. Trotzdem stand schon mehr als
 * einmal freitags niemand da — nicht aus Unwillen, sondern weil ein Termin,
 * den man im August gelesen hat, im Oktober nicht mehr im Kopf ist. Eine
 * Erinnerung ist deshalb kein Komfort, sondern der Unterschied zwischen einem
 * Plan und einem geputzten Klassenraum.
 *
 * DREI DINGE ENTSCHEIDEN DEN BAU, und alle drei stehen unten im Code:
 *
 *  1. Es wird nicht „um 17 Uhr geweckt", sondern REGELMAESSIG GEFRAGT, ob
 *     etwas faellig ist. Ein Wecker, der genau einmal klingelt, klingelt ins
 *     Leere, wenn der Prozess in dieser Minute gerade neu startet — und
 *     genau dann wird deployt, sonntagabends.
 *  2. Faelligkeit ist ein ZEITFENSTER, kein Zeitpunkt. Es beginnt sonntags um
 *     17 Uhr und endet, wenn der Termintag anbricht. Alles dazwischen ist
 *     Nachholen.
 *  3. Verschickt wird GENAU EINMAL je Termin, gesichert ueber einen
 *     bedingten INSERT (siehe `../lib/db/putzplanReminders.ts`) und nicht
 *     ueber ein Nachsehen.
 */

/** Ein Termin des Putzplans, wie ihn `naechsterPutztermin` liefert. */
export type PutzTermin = {
	/** Reines Datum, Mitternacht UTC — so wie es aus dem Putzplan kommt. */
	datum: Date
	/** Schluessel der Familien-Gruppen, die an diesem Termin dran sind. */
	gruppen: string[]
}

/** Eine erreichbare Adresse einer Familie. */
export type FamilienEmpfaenger = {
	email: string
	name: string | null
}

/**
 * Woher Termine und Adressen kommen.
 *
 * Ein Port und kein direkter Import, damit die Tests die Uhr UND die Daten in
 * der Hand haben: Ein Test, der erst einen Putzplan in die Datenbank schreiben
 * muss, prueft am Ende das Schreiben und nicht die Erinnerung.
 *
 * Im Betrieb kommt hier `putzplanQuelle()` an — und die liest aus
 * `src/klasse/putzplan.ts`, also aus derselben Quelle, aus der auch die Seite
 * ihre Tabelle nimmt. Zwei Quellen fuer denselben Plan waeren zwei Plaene.
 */
export type PutzplanQuelle = {
	naechsterPutztermin(ab: Date, db: Database): PutzTermin | null
	familienEmpfaenger(groupKey: string, db: Database): FamilienEmpfaenger[]
}

/**
 * Wann die Erinnerung rausgeht: sonntags um 17 Uhr Ortszeit.
 *
 * Sonntagabend, weil die Woche dann geplant wird und bis Freitag noch Zeit
 * bleibt, mit einer anderen Familie zu tauschen. Eine Erinnerung am
 * Donnerstag waere eine Nachricht, gegen die man nichts mehr machen kann.
 */
const SENDESTUNDE = 17

/** Wochentage und Monate ausgeschrieben, wie sie in der Mail stehen. */
const WOCHENTAGE = [
	'Sonntag',
	'Montag',
	'Dienstag',
	'Mittwoch',
	'Donnerstag',
	'Freitag',
	'Samstag',
] as const

const MONATE = [
	'Januar',
	'Februar',
	'März',
	'April',
	'Mai',
	'Juni',
	'Juli',
	'August',
	'September',
	'Oktober',
	'November',
	'Dezember',
] as const

/**
 * Das Kalenderdatum eines Termins, in UTC-Gettern gelesen.
 *
 * Dieselbe Entscheidung wie in `putzplan.ts`: `datum` ist ein reines Datum und
 * liegt auf Mitternacht UTC. Wer es mit lokalen Gettern liest, bekommt in einer
 * Zeitzone westlich von UTC den Vortag — und die Zeitzone eines Containers ist
 * nicht verlaesslich.
 */
const kalendertag = (datum: Date) => ({
	jahr: datum.getUTCFullYear(),
	monat: datum.getUTCMonth() + 1,
	tag: datum.getUTCDate(),
	/** 0 = Sonntag. */
	wochentag: datum.getUTCDay(),
})

/**
 * Der Sonntag VOR dem Termin, 17 Uhr Berliner Zeit.
 *
 * Fuer den Regelfall — Termin ist ein Freitag — sind das fuenf Tage zurueck.
 * Die Rechnung steht trotzdem allgemein da, weil der Plan Ausnahmen kennt: ein
 * Termin kann auf einen Donnerstag vorgezogen sein, wenn der Freitag ein
 * Feiertag ist. „Der Sonntag davor" gilt dann immer noch; „minus fuenf Tage"
 * waere ein Montag.
 *
 * Faellt der Termin selbst auf einen Sonntag, ist es der Sonntag der Vorwoche
 * und nicht der Termintag: eine Erinnerung um 17 Uhr fuer denselben Vormittag
 * ist keine.
 */
export const sendezeitFuer = (datum: Date): Date => {
	const { jahr, monat, tag, wochentag } = kalendertag(datum)
	const tageZurueck = wochentag === 0 ? 7 : wochentag
	return berlinZeitpunkt(jahr, monat, tag - tageZurueck, SENDESTUNDE)
}

/**
 * Wann es zu spaet ist: mit dem Anbruch des Termintages.
 *
 * Die Grenze ist nicht Vorsicht, sondern Wortlaut. Die Mail sagt „am kommenden
 * Freitag" — am Freitag selbst waere dieser Satz falsch, und eine Mail, die
 * einen falschen Tag nennt, ist schlimmer als keine: Wer sie morgens liest,
 * denkt an nächste Woche und kommt heute Abend nicht.
 */
export const spaetestensBis = (datum: Date): Date => {
	const { jahr, monat, tag } = kalendertag(datum)
	return berlinZeitpunkt(jahr, monat, tag)
}

/**
 * Ist die Erinnerung zu diesem Termin gerade faellig?
 *
 * Ein Fenster und kein Zeitpunkt — das ist die Antwort auf „der Prozess lief
 * sonntags um 17 Uhr nicht". Wer erst dienstags hochkommt, findet den Termin
 * noch faellig vor und holt die Erinnerung nach.
 */
export const istFaellig = (datum: Date, jetzt: Date): boolean =>
	jetzt.getTime() >= sendezeitFuer(datum).getTime() &&
	jetzt.getTime() < spaetestensBis(datum).getTime()

/** `21.08.` — im Betreff, wo es kurz sein muss. */
const kurzdatum = (datum: Date): string => {
	const { monat, tag } = kalendertag(datum)
	const zweistellig = (zahl: number) => String(zahl).padStart(2, '0')
	return `${zweistellig(tag)}.${zweistellig(monat)}.`
}

/** `21. August` — im Fliesstext, wo es lesbar sein muss. */
const langdatum = (datum: Date): string => {
	const { monat, tag } = kalendertag(datum)
	return `${tag}. ${MONATE[monat - 1]}`
}

const wochentagName = (datum: Date): string =>
	WOCHENTAGE[kalendertag(datum).wochentag] ?? ''

/**
 * `A und B`, bei dreien `A, B und C`.
 *
 * Dieselbe Regel wie in `familienSpalte` der Putzplan-Seite, und aus demselben
 * Grund: Ein Schraegstrich gehoert zu EINER Familie mit zwei Nachnamen
 * (`Dziallas/Kretschmer`) und trennt keine zwei Familien. Wer hier mit `/`
 * verbindet, macht aus zwei Familien eine.
 */
const undVerbunden = (namen: readonly string[]): string => {
	const letzter = namen.at(-1)
	if (namen.length <= 1 || letzter === undefined) return namen.join('')
	return `${namen.slice(0, -1).join(', ')} und ${letzter}`
}

/**
 * Der Anzeigename einer Familie: das Label ihrer Gruppe.
 *
 * Das `Familie `-Praefix setzt die Mail selbst, deshalb wird ein bereits im
 * Label stehendes abgeschnitten — sonst steht dort „Familie Familie Sommer",
 * je nachdem wie die Gruppe angelegt wurde.
 *
 * Ohne Gruppe bleibt der Schluessel stehen. Das ist kein schoener Name, aber
 * ein eindeutiger: Dieser Fall geht ohnehin als Meldung an den Betrieb, und
 * dort wird der Schluessel gebraucht, um die Gruppe anzulegen.
 */
const familienName = (groupKey: string, db: Database): string => {
	const label = getGroup(groupKey, db)?.label?.trim()
	if (!label) return groupKey
	return label.replace(/^Familie\s+/i, '')
}

/** Was eine Familie am Ende bekommen hat — oder eben nicht. */
type FamilienStand = {
	groupKey: string
	name: string
	empfaenger: FamilienEmpfaenger[]
	/** Gesetzt, wenn niemand erreichbar ist. Steht wortgleich in der Meldung. */
	grund?: string
}

export type Erinnerungstext = {
	subject: string
	text: string
}

/**
 * Betreff und Rumpf der Erinnerung. Rein, damit der Wortlaut prüfbar ist —
 * dieser Text geht an dreißig Familien, ohne dass jemand ihn vorher liest.
 *
 * Die Mail nennt ALLE Familien des Termins, auch eine, die gerade nicht
 * erreichbar ist. Wer sie liest, soll sehen, mit wem er zusammen dran ist; wer
 * fehlt, soll auffallen.
 */
export const baueErinnerungstext = (
	datum: Date,
	familienNamen: readonly string[],
): Erinnerungstext => {
	const { contactName, contactMail } = klassenConfig()
	const basis = siteUrl().replace(/\/+$/, '')
	// Ohne hinterlegten Namen bleibt die Adresse allein stehen. Einen Namen zu
	// erfinden hiesse, in der einen Klasse den Namen der anderen zu nennen.
	const ansprache = contactName
		? `sagt ${contactName} Bescheid (${contactMail})`
		: `sagt unter ${contactMail} Bescheid`

	const text = [
		'Hallo,',
		'',
		`am kommenden ${wochentagName(datum)}, dem ${langdatum(datum)}, seid ihr mit dem Putzen dran:`,
		'',
		...familienNamen.map((name) => `    Familie ${name}`),
		'',
		'Was zu tun ist, steht in der Checkliste; Schlüssel und Zeitfenster in der Vorbereitung:',
		`    ${basis}/docs/putzen/checkliste`,
		`    ${basis}/docs/putzen/vorbereitung`,
		'',
		`Wer nicht kann, tauscht bitte direkt mit einer anderen Familie und ${ansprache}. Der Plan wird dann geändert.`,
		'',
		`Der ganze Putzplan: ${basis}/docs/putzen/putzplan`,
	].join('\n')

	return {
		subject: `Putzen am ${wochentagName(datum)}, ${kurzdatum(datum)} — ${undVerbunden(familienNamen)}`,
		text: `${text}\n`,
	}
}

/**
 * Die versendbare Erinnerung an EINE Adresse.
 *
 * Eine Mail je Adresse und nicht eine an alle: Ein gemeinsames `To` verteilt
 * die Adressen beider Familien an beide Familien, und das ist nicht unsere
 * Entscheidung.
 *
 * `Auto-Submitted: auto-generated` gehoert dazu (RFC 3834). Ohne den Header
 * antwortet die erste Abwesenheitsnotiz auf die Erinnerung, und die Antwort
 * landet bei der Kontaktadresse der Klasse.
 *
 * `Reply-To` ist die Kontaktadresse und nicht `noreply@`: „Wir koennen am
 * Freitag nicht" ist die haeufigste Reaktion auf diese Mail, und sie muss
 * irgendwo ankommen.
 */
export const baueErinnerungsMail = (
	empfaenger: string,
	datum: Date,
	inhalt: Erinnerungstext,
): SendInput => ({
	from: `"${mailFromName()}" <${mailFrom()}>`,
	to: empfaenger,
	replyTo: klassenConfig().contactMail,
	subject: inhalt.subject,
	text: inhalt.text,
	html: '',
	headers: {
		'Auto-Submitted': 'auto-generated',
		'X-Putzplan-Reminder': datumIso(datum),
	},
})

/**
 * Die Meldung an den Betrieb, wenn eine Familie NICHT erreicht wurde.
 *
 * Das ist der wichtigste Weg in dieser Datei. Eine Familie ohne Gruppe oder
 * ohne hinterlegte Adresse liefert eine leere Empfaengerliste — und eine leere
 * Empfaengerliste ist im Versand nicht von „alles erledigt" zu unterscheiden.
 * Ohne diese Meldung glaubt die Familie, sie sei nicht dran, der Betrieb
 * glaubt, die Erinnerung sei raus, und am Freitag steht niemand da. Die
 * Erinnerung an die ANDERE Familie geht trotzdem raus: Eine fehlende Adresse
 * ist kein Grund, auch noch die Familie im Dunkeln zu lassen, die man
 * erreichen kann.
 */
export const baueMeldung = (
	datum: Date,
	unerreicht: readonly FamilienStand[],
	erreicht: readonly FamilienStand[],
	/**
	 * Der Bericht der Konten-Prüfung, falls er etwas zu sagen hat. Er steht in
	 * DIESER Meldung und nicht in einer eigenen: Wer sie liest, soll den Stand
	 * eines Termins an einer Stelle sehen — zwei Mails am selben Sonntagabend
	 * werden zu einer gelesen und einer übersehenen.
	 */
	kontenBericht?: string,
): SendInput => {
	const { contactMail } = klassenConfig()
	const zeilen =
		unerreicht.length === 0
			? [
					`Die Putz-Erinnerung für ${wochentagName(datum)}, den ${langdatum(datum)}, ist raus.`,
				]
			: [
					`Die Putz-Erinnerung für ${wochentagName(datum)}, den ${langdatum(datum)}, konnte nicht an alle Familien gehen.`,
					'',
					unerreicht.length === 1
						? 'Diese Familie hat KEINE Erinnerung bekommen:'
						: 'Diese Familien haben KEINE Erinnerung bekommen:',
					...unerreicht.map(
						({ name, groupKey, grund }) =>
							`    Familie ${name} (Gruppe "${groupKey}"): ${grund ?? 'keine Empfänger'}`,
					),
					'',
					'Solange das so bleibt, erfährt sie nichts von ihrem Einsatz — auf der Putzplan-Seite steht sie aber drin.',
					'',
					'Was hilft: die Gruppe anlegen bzw. der Familie eine Adresse eintragen (Verwaltung → Gruppen), und die Familie kurz von Hand anschreiben. Die Erinnerung selbst wird für diesen Termin nicht noch einmal verschickt.',
				]

	if (kontenBericht) zeilen.push('', kontenBericht)

	if (erreicht.length > 0) {
		zeilen.push(
			'',
			'Erreicht wurden:',
			...erreicht.map(
				({ name, empfaenger }) =>
					`    Familie ${name}: ${empfaenger.length} Adresse(n)`,
			),
		)
	}

	return {
		from: `"${mailFromName()}" <${mailFrom()}>`,
		to: contactMail,
		replyTo: contactMail,
		subject: `Putzplan: Erinnerung für ${kurzdatum(datum)} unvollständig`,
		text: `${zeilen.join('\n')}\n`,
		html: '',
		headers: {
			'Auto-Submitted': 'auto-generated',
			'X-Putzplan-Reminder': datumIso(datum),
		},
	}
}

/**
 * Wohin die QUITTUNG geht — „habe gerade soundso erinnert".
 *
 * Sie ist das Gegenteil der Meldung darueber: Die Meldung kommt, wenn etwas
 * schiefging; die Quittung kommt, WEIL nichts schiefging. Der Betreiber hat sie
 * ausdruecklich bestellt, um zu sehen, dass der Dienst laeuft — dieser Dienst
 * hat bis heute keine einzige echte Erinnerung verschickt, und ein Sonntag ohne
 * Nachricht ist bis dahin nicht von einem Sonntag mit stillem Fehlschlag zu
 * unterscheiden.
 *
 * Und sie ist AUSDRUECKLICH VORLAEUFIG. Deshalb haengt sie an einer
 * Umgebungsvariablen und nicht an einer Konstante im Code: Ist sie leer oder
 * nicht gesetzt, gibt es keine Quittung. Sie wieder loszuwerden ist damit ein
 * Handgriff im Deployment und kein Pull Request — genau so war sie bestellt
 * („lösche ich dann gleich").
 *
 * Sie widerspricht der Regel „nur Fehler melden" (siehe `hatBefund()` in
 * `kontopruefung.ts`) nicht, sondern bestaetigt sie: Was jemanden ungefragt
 * erreicht, braucht einen Anlass. Hier IST der Anlass bestellt worden, und wer
 * ihn abbestellt, leert eine Zeile.
 */
const quittungAn = (): string => (process.env.REMINDER_RECEIPT_TO ?? '').trim()

/**
 * Die Quittung: was gerade rausgegangen ist, in zwei Sekunden auf dem Telefon
 * erfassbar.
 *
 * Die Klasse steht im Betreff und nicht nur im Rumpf: Dieselbe Adresse bekommt
 * die Quittungen BEIDER Klassen, und zwar am selben Sonntag um 17 Uhr. Ohne den
 * Namen im Betreff liegen dort zwei Mails, die sich erst beim Aufklappen
 * unterscheiden.
 */
export const baueQuittung = (
	empfaenger: string,
	datum: Date,
	familienNamen: readonly string[],
	zugestellt: number,
	unerreicht: readonly FamilienStand[],
	gescheitert: readonly string[],
): SendInput => {
	const { label: klasse, contactMail } = klassenConfig()
	const zeilen = [
		`Die Putz-Erinnerung der ${klasse} ist raus.`,
		'',
		`    Termin:     ${wochentagName(datum)}, ${langdatum(datum)}`,
		`    Familien:   ${undVerbunden(familienNamen)}`,
		`    Zugestellt: ${zugestellt} Adresse(n)`,
	]

	if (unerreicht.length > 0) {
		zeilen.push(
			'',
			'NICHT erreicht:',
			...unerreicht.map(
				({ name, groupKey, grund }) =>
					`    Familie ${name} (Gruppe "${groupKey}"): ${grund ?? 'keine Empfänger'}`,
			),
		)
	}
	if (gescheitert.length > 0) {
		// Die Adressen im Klartext, wie in der Meldung daneben: Hier soll jemand
		// nachfassen koennen, und dafuer braucht er die Adresse und nicht ihren
		// Umriss.
		zeilen.push(
			'',
			'Versand gescheitert an:',
			...gescheitert.map((adresse) => `    ${adresse}`),
		)
	}

	return {
		from: `"${mailFromName()}" <${mailFrom()}>`,
		to: empfaenger,
		replyTo: contactMail,
		subject: `${klasse}: Erinnerung raus an ${undVerbunden(familienNamen)} (${kurzdatum(datum)})`,
		text: `${zeilen.join('\n')}\n`,
		html: '',
		headers: {
			// Ohne diesen Header antwortet die erste Abwesenheitsnotiz auf die
			// Quittung — und zwar an die Kontaktadresse der Klasse.
			'Auto-Submitted': 'auto-generated',
			'X-Putzplan-Reminder': datumIso(datum),
		},
	}
}

export type ErinnerungsOptionen = {
	/**
	 * Pflicht und ohne Vorgabewert. Eine Vorgabe muesste `putzplan.ts` schon
	 * beim IMPORT dieses Moduls aufloesen — und dann haenge jeder Test dieser
	 * Datei an einem Modul, das ein anderer Zweig gerade umbaut.
	 */
	quelle: PutzplanQuelle
	db?: Database
	transport?: EmailTransport
	/** Gestellte Uhr fuer Tests. Im Betrieb: jetzt. */
	jetzt?: Date
}

export type ErinnerungsErgebnis =
	/** Kein Termin steht an. */
	| { kind: 'no_termin' }
	/** Der naechste Termin ist noch nicht dran. Der Normalfall. */
	| { kind: 'not_due'; terminDate: string }
	/** Ein anderer Tick (oder eine fruehere Inkarnation) war schneller. */
	| { kind: 'already_sent'; terminDate: string }
	| {
			kind: 'sent'
			terminDate: string
			/** Angeschriebene Adressen. */
			recipients: number
			/** Gruppen ohne erreichbare Adresse — gemeldet, nicht uebergangen. */
			unreached: string[]
			/** Adressen, bei denen der Versand scheiterte. Ebenfalls gemeldet. */
			failed: string[]
			/** Bericht der Konten-Pruefung, siehe `src/lib/versand/kontopruefung.ts`. */
			account_check: AccountCheckReport
	  }
	/** Keine einzige Mail ging raus; der Termin ist wieder freigegeben. */
	| { kind: 'retry_later'; terminDate: string; error: string }

const log = (nachricht: string): void => {
	console.log(`[putzplan-erinnerung] ${nachricht}`)
}

/**
 * Der ganze Dienst in einem Aufruf: nachsehen, ob etwas faellig ist, und wenn
 * ja, es genau einmal verschicken.
 *
 * Die Reihenfolge ist Absicht. Beansprucht wird VOR dem Versand — ein Absturz
 * mitten im Versenden darf keine zweite Runde ausloesen; die Familien, die die
 * Mail schon haben, bekaemen sie sonst erneut. Freigegeben wird nur der eine
 * Fall, in dem nachweislich NIEMAND etwas bekommen hat.
 */
export const sendeFaelligeErinnerung = async (
	optionen: ErinnerungsOptionen,
): Promise<ErinnerungsErgebnis> => {
	const db = optionen.db ?? openDb()
	const jetzt = optionen.jetzt ?? new Date()
	const transport = optionen.transport ?? sesTransport()

	const termin = optionen.quelle.naechsterPutztermin(jetzt, db)
	if (!termin) return { kind: 'no_termin' }

	const terminDate = datumIso(termin.datum)
	if (!istFaellig(termin.datum, jetzt)) return { kind: 'not_due', terminDate }

	// Ab hier gehoert der Termin diesem Aufruf — oder eben nicht.
	if (!beanspruchtErinnerung(terminDate, db))
		return { kind: 'already_sent', terminDate }

	const gesperrt = globallySuppressedAddresses(db)
	const staende: FamilienStand[] = termin.gruppen.map((groupKey) => {
		const roh = optionen.quelle.familienEmpfaenger(groupKey, db)
		const empfaenger = roh.filter(
			(e) => !gesperrt.has(e.email.trim().toLowerCase()),
		)
		const grund =
			roh.length === 0
				? 'keine Adresse hinterlegt (oder die Gruppe fehlt)'
				: empfaenger.length === 0
					? 'alle Adressen gesperrt (Bounce oder Beschwerde)'
					: undefined
		return { groupKey, name: familienName(groupKey, db), empfaenger, grund }
	})

	const erreicht = staende.filter((s) => s.empfaenger.length > 0)
	const unerreicht = staende.filter((s) => s.empfaenger.length === 0)

	const inhalt = baueErinnerungstext(
		termin.datum,
		staende.map((s) => s.name),
	)

	// Eine Adresse kann in zwei Familien stehen (Patchwork, geteiltes Postfach).
	// Zweimal dieselbe Mail waere kein Schaden, aber ein Grund fuer eine
	// Rueckfrage, die niemand beantworten will.
	const adressen = [
		...new Set(
			erreicht.flatMap((s) => s.empfaenger.map((e) => e.email.trim())),
		),
	]

	// OHNE KONTO, KEINE E-MAIL. Ein entzogener Grant loest kein Ereignis aus, auf
	// das man hoeren koennte: ZITADEL meldet hoechstens das geloeschte Konto,
	// nicht die entzogene Rolle. Ohne diese Pruefung erinnerte diese
	// Datei eine Familie noch Jahre nach ihrem Weggang an den Putzdienst.
	// Begruendung im Langen: `src/lib/versand/kontopruefung.ts`.
	//
	// Bei einer Stoerung von ZITADEL in `enforce` wird der Termin WIEDER
	// FREIGEGEBEN und spaeter erneut versucht — derselbe Weg wie bei einer
	// Stoerung der Zustellung weiter unten, und aus demselben Grund: Bis Freitag
	// ist Zeit, und ein Tick alle paar Minuten holt es nach.
	let pruefung: Awaited<ReturnType<typeof pruefeKonten<string>>>
	try {
		pruefung = await pruefeKonten(
			adressen,
			(adresse) => ({ email: adresse, from_address_book: true }),
			{ db, occasion: `Putz-Erinnerung ${terminDate}` },
		)
	} catch (fehler) {
		gibErinnerungFrei(terminDate, db)
		const grund = `Konten-Pruefung nicht moeglich: ${fehler instanceof Error ? fehler.message : String(fehler)}`
		log(`Erinnerung ${terminDate} zurueckgestellt: ${grund}`)
		return { kind: 'retry_later', terminDate, error: grund }
	}

	const gescheitert: string[] = []
	let zugestellt = 0
	for (const adresse of pruefung.recipients) {
		try {
			await transport.send(baueErinnerungsMail(adresse, termin.datum, inhalt))
			zugestellt++
		} catch (fehler) {
			gescheitert.push(adresse)
			log(
				`Erinnerung ${terminDate} an ${adresse} gescheitert: ${fehler instanceof Error ? fehler.message : String(fehler)}`,
			)
		}
	}

	// Es gab zustellbare Adressen, aber keine einzige Mail kam durch: Das ist die
	// Warteschlange und nicht der Putzplan — SMTP weg, Zugangsdaten abgelaufen.
	// Solche Stoerungen gehen vorueber, und bis Freitag ist Zeit. Also den
	// Termin wieder hergeben, damit der naechste Tick es erneut versucht.
	//
	// Gezaehlt werden die Adressen NACH der Konten-Pruefung. Sonst waere ein
	// vollstaendiger Schnitt in `enforce` von einem SMTP-Ausfall nicht zu
	// unterscheiden, und der Dienst versuchte bis Freitag alle paar Minuten
	// erneut, was er gerade bewusst nicht getan hat.
	if (pruefung.recipients.length > 0 && zugestellt === 0) {
		gibErinnerungFrei(terminDate, db)
		const fehler = `keine der ${pruefung.recipients.length} Adressen erreicht`
		log(`Erinnerung ${terminDate} zurueckgestellt: ${fehler}`)
		return { kind: 'retry_later', terminDate, error: fehler }
	}

	schliesstErinnerungAb(terminDate, zugestellt, db)
	log(
		`Erinnerung ${terminDate} verschickt: ${zugestellt} Adresse(n), ${unerreicht.length} Familie(n) nicht erreichbar`,
	)

	// Der Bericht der Konten-Pruefung haengt der Meldung an — ABER NUR, WENN ER
	// ETWAS ZU MELDEN HAT. Was das heisst und warum, steht bei `hatBefund()` in
	// `kontopruefung.ts`; kurz: Diese Erinnerung laeuft jeden Sonntag, und eine
	// woechentliche Mail mit lauter Nullen lernt man wegzuklicken. Am
	// Rueckgabewert haengt der Bericht weiterhin immer — den liest nur, wer
	// fragt.
	const kontenBericht = hatBefund(pruefung.report)
		? berichtAlsText(pruefung.report)
		: undefined

	if (unerreicht.length > 0 || gescheitert.length > 0 || kontenBericht) {
		const meldung = baueMeldung(
			termin.datum,
			unerreicht,
			erreicht,
			kontenBericht,
		)
		try {
			await transport.send({
				...meldung,
				text:
					gescheitert.length > 0
						? `${meldung.text}\nBei diesen Adressen ist der Versand gescheitert:\n${gescheitert
								.map((a) => `    ${a}`)
								.join('\n')}\n`
						: meldung.text,
			})
		} catch (fehler) {
			// Die Erinnerung selbst ist raus. Eine geplatzte Meldung darf sie nicht
			// nachtraeglich als gescheitert dastehen lassen — aber sie muss im Log
			// stehen, sonst ist die unerreichte Familie zweimal unsichtbar.
			log(
				`MELDUNG NICHT ZUGESTELLT (${terminDate}): ${fehler instanceof Error ? fehler.message : String(fehler)} — nicht erreicht: ${unerreicht
					.map((s) => s.groupKey)
					.join(', ')}`,
			)
		}
	}

	// Die Quittung ganz zuletzt, und in ihrem eigenen `try`: Sie ist eine
	// Nachricht UEBER den Versand und darf ihn unter keinen Umstaenden
	// gefaehrden. Scheitert sie, haben die Familien ihre Mail laengst — dann
	// bleibt nur das Protokoll, und `kind: 'sent'` bleibt wahr.
	//
	// Sie geht ausschliesslich hier raus, also nur auf dem Weg, der wirklich
	// verschickt hat. „Noch nicht faellig", „hat schon ein anderer Tick
	// gemacht", „kein Termin" und „spaeter erneut versuchen" kehren weiter oben
	// um — jeder Tick quittieren zu lassen waere alle paar Minuten eine Mail.
	const quittungsziel = quittungAn()
	if (quittungsziel) {
		try {
			await transport.send(
				baueQuittung(
					quittungsziel,
					termin.datum,
					staende.map((s) => s.name),
					zugestellt,
					unerreicht,
					gescheitert,
				),
			)
		} catch (fehler) {
			log(
				`QUITTUNG NICHT ZUGESTELLT (${terminDate}): ${fehler instanceof Error ? fehler.message : String(fehler)} — die Erinnerung selbst ist raus (${zugestellt} Adresse(n)).`,
			)
		}
	}

	return {
		kind: 'sent',
		terminDate,
		recipients: zugestellt,
		unreached: unerreicht.map((s) => s.groupKey),
		failed: gescheitert,
		account_check: pruefung.report,
	}
}
