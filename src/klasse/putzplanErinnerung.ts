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
import { datumIso, undVerbunden } from './putzplan.ts'

export type PutzTermin = {
	datum: Date
	gruppen: string[]
}

export type FamilienEmpfaenger = {
	email: string
	name: string | null
}

export type PutzplanQuelle = {
	naechsterPutztermin(ab: Date, db: Database): PutzTermin | null
	familienEmpfaenger(groupKey: string, db: Database): FamilienEmpfaenger[]
}

// Sonntagabend, damit bis Freitag noch Zeit zum Tauschen bleibt.
const SENDESTUNDE = 17

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

// UTC-Getter: das Datum liegt auf Mitternacht UTC, lokale Getter liefern westlich davon den Vortag.
const kalendertag = (datum: Date) => ({
	jahr: datum.getUTCFullYear(),
	monat: datum.getUTCMonth() + 1,
	tag: datum.getUTCDate(),
	wochentag: datum.getUTCDay(),
})

export const sendezeitFuer = (datum: Date): Date => {
	const { jahr, monat, tag, wochentag } = kalendertag(datum)
	// „Sonntag davor“ statt „minus fünf Tage“, weil Termine auf andere Wochentage vorgezogen werden können.
	const tageZurueck = wochentag === 0 ? 7 : wochentag
	return berlinZeitpunkt(jahr, monat, tag - tageZurueck, SENDESTUNDE)
}

// Endet mit dem Termintag, weil die Mail „am kommenden …“ sagt und am Tag selbst falsch wäre.
export const spaetestensBis = (datum: Date): Date => {
	const { jahr, monat, tag } = kalendertag(datum)
	return berlinZeitpunkt(jahr, monat, tag)
}

export const istFaellig = (datum: Date, jetzt: Date): boolean =>
	jetzt.getTime() >= sendezeitFuer(datum).getTime() &&
	jetzt.getTime() < spaetestensBis(datum).getTime()

const kurzdatum = (datum: Date): string => {
	const { monat, tag } = kalendertag(datum)
	const zweistellig = (zahl: number) => String(zahl).padStart(2, '0')
	return `${zweistellig(tag)}.${zweistellig(monat)}.`
}

const langdatum = (datum: Date): string => {
	const { monat, tag } = kalendertag(datum)
	return `${tag}. ${MONATE[monat - 1]}`
}

const wochentagName = (datum: Date): string =>
	WOCHENTAGE[kalendertag(datum).wochentag] ?? ''

const familienName = (groupKey: string, db: Database): string => {
	const label = getGroup(groupKey, db)?.label?.trim()
	if (!label) return groupKey
	// Die Mail setzt „Familie “ selbst davor.
	return label.replace(/^Familie\s+/i, '')
}

type FamilienStand = {
	groupKey: string
	name: string
	empfaenger: FamilienEmpfaenger[]
	grund?: string
}

export type Erinnerungstext = {
	subject: string
	text: string
}

export const baueErinnerungstext = (
	datum: Date,
	familienNamen: readonly string[],
): Erinnerungstext => {
	const { contactName, contactMail } = klassenConfig()
	const basis = siteUrl().replace(/\/+$/, '')
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

// Eine Mail je Adresse, damit die Familien ihre Adressen nicht untereinander sehen;
// Reply-To ist die Kontaktadresse, weil Absagen irgendwo ankommen müssen.
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

export const baueMeldung = (
	datum: Date,
	unerreicht: readonly FamilienStand[],
	erreicht: readonly FamilienStand[],
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

// Bewusst per Env statt Konstante: vorläufig bestellt, abbestellen ohne Code-Änderung.
const quittungAn = (): string => (process.env.REMINDER_RECEIPT_TO ?? '').trim()

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
			'Auto-Submitted': 'auto-generated',
			'X-Putzplan-Reminder': datumIso(datum),
		},
	}
}

export type ErinnerungsOptionen = {
	// Ohne Vorgabe, sonst zöge schon der Import dieses Moduls putzplan.ts mit.
	quelle: PutzplanQuelle
	db?: Database
	transport?: EmailTransport
	jetzt?: Date
}

export type ErinnerungsErgebnis =
	| { kind: 'no_termin' }
	| { kind: 'not_due'; terminDate: string }
	| { kind: 'already_sent'; terminDate: string }
	| {
			kind: 'sent'
			terminDate: string
			recipients: number
			unreached: string[]
			failed: string[]
			account_check: AccountCheckReport
	  }
	| { kind: 'retry_later'; terminDate: string; error: string }

const log = (nachricht: string): void => {
	console.log(`[putzplan-erinnerung] ${nachricht}`)
}

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

	// Vor dem Versand beanspruchen: ein Absturz mittendrin darf keine zweite Runde auslösen.
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

	const adressen = [
		...new Set(
			erreicht.flatMap((s) => s.empfaenger.map((e) => e.email.trim())),
		),
	]

	// Ohne Konto keine Mail: ein entzogener Grant löst kein Ereignis aus, also vor jedem Versand prüfen.
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

	// Nur Totalausfall gibt frei; gezählt nach der Konten-Prüfung, damit ein bewusster Schnitt kein SMTP-Ausfall ist.
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

	// Nur mit Befund in die Meldung, sonst lernt man die wöchentliche Mail wegzuklicken.
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
			log(
				`MELDUNG NICHT ZUGESTELLT (${terminDate}): ${fehler instanceof Error ? fehler.message : String(fehler)} — nicht erreicht: ${unerreicht
					.map((s) => s.groupKey)
					.join(', ')}`,
			)
		}
	}

	// Eigenes try und ganz zuletzt: die Quittung darf den Versand nie gefährden.
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
