import type { Database } from 'better-sqlite3'
import { klassenConfig } from '../../klasse/config.ts'
import {
	type GrantedAccount,
	GrantsConfigError,
	GrantsUnavailableError,
	grantedAccounts,
	knownAccounts,
} from '../../server/auth/grants.ts'
import { canRead } from '../../server/auth/roles.ts'
import { openDb } from '../db/index.ts'

/**
 * OHNE KONTO, KEINE E-MAIL — die Pruefung vor jedem Versand.
 *
 * WARUM ES SIE GIBT. Ein entzogener Grant loest kein Ereignis aus. Der Webhook
 * aus ZITADEL kennt nur `user.removed` (`src/routes/api/zitadel/events.ts`) —
 * er meldet also das GELOESCHTE KONTO, nicht die entzogene Rolle. Wer die
 * Klasse verlaesst, verliert in der Praxis aber den Grant und behaelt das
 * Konto. Ohne diese Pruefung bekaeme diese Person unbegrenzt weiter Post: Der
 * Versand nimmt seine Empfaenger allein aus dem Adressbuch, und im Adressbuch
 * aendert ein Rollenentzug nichts. Genau das gab es schon einmal — in der
 * abgeloesten PocketBase-Gruppe hatten sechs Personen weiterhin Zugriff, die
 * laengst nicht mehr dazugehoerten.
 *
 * Die Pruefung ersetzt das Adressbuch NICHT und schreibt es nicht. Sie legt
 * eine zweite Bedingung darueber: Wer Post bekommt, muss im Adressbuch stehen
 * (ein Mensch hat ihn eingetragen) UND in ZITADEL ein Konto mit Leserolle im
 * Projekt dieser Klasse haben. Adressbuch und ZITADEL bleiben getrennte
 * Datenschichten; hier werden sie verglichen, nicht abgeglichen.
 *
 * ZWEI BETRIEBSARTEN, gesteuert ueber `LIST_ACCOUNT_CHECK`:
 *
 *   `report`  (Vorgabe) Es wird NICHTS geschnitten. Die Pruefung laeuft
 *             trotzdem und protokolliert, wer geschnitten WUERDE und warum.
 *   `enforce` Es wird geschnitten — und dieselbe Meldung geht heraus. Still
 *             schneiden ist verboten: Eine Mail, die niemanden mehr erreicht,
 *             muss als solche erkennbar sein und nicht wie „zugestellt"
 *             aussehen.
 *
 * WARUM `report` DIE VORGABE IST, obwohl `enforce` heute realistisch waere:
 * Nachgemessen am 15.08. decken sich Adressbuch und Grants in `klasse-wiesen`
 * exakt (59 zu 59) und in `klasse-christophers` bis auf drei Faelle. `enforce`
 * wuerde dort also drei Adressen betreffen und nicht sechzig. Trotzdem bleibt
 * die Vorgabe `report`: Diese Zahlen sind eine Momentaufnahme aus zwei
 * Klassen, und eine Voreinstellung, die beim ersten Einsatz in einer dritten
 * Klasse still den halben Verteiler abschneidet, waere die falsche. Wer
 * umstellt, hat den Bericht vorher einmal gelesen — und das ist genau der
 * Handgriff, den diese Vorgabe erzwingt.
 *
 * VERBUNDEN WIRD UEBER ZWEI SCHLUESSEL, und es braucht beide:
 *
 *   `mitglieder.user_sub` ist der stabilere — er ueberlebt eine
 *   Adressaenderung. Er entsteht aber erst beim ERSTEN LOGIN
 *   (`src/lib/db/users.ts`), und deshalb ist er heute bei fast allen leer. Eine
 *   Pruefung allein auf ihn haette jeden Verteiler auf eine Handvoll Adressen
 *   zusammengestrichen.
 *
 *   Die normalisierte E-MAIL-ADRESSE traegt dagegen heute. Sie ist der
 *   schwaechere Schluessel — wer seine Adresse in ZITADEL aendert und im
 *   Adressbuch nicht (oder umgekehrt), faellt heraus —, aber genau dieser Fall
 *   steht dann als Meldung im Bericht, statt still zu wirken.
 *
 * Zuerst der `sub`, dann die Adresse. Wer sich einmal angemeldet hat, wird also
 * ueber den stabilen Schluessel wiedererkannt, auch wenn die Adressen
 * auseinanderlaufen.
 *
 * ZITADEL GESTOERT: In `report` wird normal versendet — die Pruefung ist dann
 * nur blind, und sie schneidet in dieser Betriebsart ohnehin nichts. In
 * `enforce` wird NICHT versendet, und der Fehler wird gemeldet. Das ist
 * dieselbe Entscheidung wie in `grants.ts` und aus demselben Grund: Wer nicht
 * weiss, ob jemand noch dazugehoert, verschickt lieber gar nichts als eine Mail
 * an Leute, die es nicht mehr tun. Eine Rundmail, die eine Stunde spaeter
 * herausgeht, ist ein Aergernis; eine Rundmail an eine Familie, die die Schule
 * verlassen hat, ist ein Datenschutzvorfall.
 */

/** Betriebsart der Pruefung. */
export type AccountCheckMode = 'report' | 'enforce'

/** Warum ein Empfaenger geschnitten wird (bzw. wuerde). */
export type CutReason =
	/** Kein Konto in ZITADEL — weder ueber `user_sub` noch ueber die Adresse. */
	| 'no_account'
	/** `user_sub` gesetzt, ZITADEL kennt dieses Konto nicht mehr. */
	| 'account_unknown'
	/** Konto vorhanden, aber ohne aktiven Grant mit Leserolle in diesem Projekt. */
	| 'role_missing'

/** Was die Pruefung ueber EINEN Empfaenger wissen muss. */
export type CheckCandidate = {
	email: string
	/**
	 * `false` fuer eine Einzeladresse einer Liste ohne Adressbuch-Eintrag
	 * (`extra_recipients`).
	 *
	 * DIESE ADRESSEN PASSIEREN DIE PRUEFUNG, IMMER. Sie haben per Definition
	 * kein Konto: Es sind die Sammeladressen der Schule, das Sekretariat, die
	 * Adresse eines Fachlehrers — jemand hat sie von Hand in die Liste
	 * eingetragen, und genau das ist ihre Berechtigung. Wuerde die Pruefung sie
	 * schneiden, verschwaenden sie aus den Verteilern, ohne dass es jemand
	 * merkt; im Bericht stehen sie deshalb als eigene Zahl.
	 */
	from_address_book: boolean
}

/** Der Bericht — maschinenlesbar, Adressen obfuskiert. */
export type AccountCheckReport = {
	mode: AccountCheckMode
	/** Wofuer geprueft wurde, z.B. `Liste eltern`. Fuer Protokoll und Meldung. */
	occasion: string
	/** Geprueft, also ohne die `extra_recipients`. */
	checked: number
	/** Bleiben in der Zustellung. */
	kept: number
	/** Geschnitten (`enforce`) bzw. wuerde geschnitten (`report`). */
	cut: { email: string; reason: CutReason }[]
	/** Einzeladressen ohne Adressbuch-Eintrag — bewusste Ausnahme. */
	extra_recipients: number
	/**
	 * Die andere Richtung: Konten MIT Leserolle, zu denen es keinen
	 * Adressbuch-Eintrag gibt. Diese Personen gehoeren dazu und bekommen
	 * trotzdem keine Post — ein Fehler, den keine Zustellung je meldet, weil
	 * dort niemand fehlt, den man vermissen koennte.
	 */
	accounts_without_entry: string[]
	/**
	 * Gesetzt, wenn ZITADEL nicht erreichbar war. Dann ist der Bericht blind und
	 * es wurde NICHTS geschnitten — moeglich nur in `report`.
	 */
	unavailable: string | null
}

export type AccountCheck<T> = {
	/** Was tatsaechlich versendet wird. */
	recipients: T[]
	/** Wer geschnitten wurde bzw. wuerde — mit dem urspruenglichen Empfaenger. */
	cut: { recipient: T; reason: CutReason }[]
	report: AccountCheckReport
}

const ENV = 'LIST_ACCOUNT_CHECK'

/**
 * Die eingestellte Betriebsart.
 *
 * Ein unbekannter Wert faellt LAUT auf `report` zurueck. Er ist ein Tippfehler
 * im Deployment, und die beiden moeglichen Fehlschluesse sind nicht
 * gleichwertig: Aus `enforc` still ein `enforce` zu machen hiesse, aufgrund
 * eines Tippfehlers Post nicht zuzustellen. Andersherum bleibt alles wie
 * vorher, und die Zeile im Protokoll sagt, was zu tun ist.
 */
export const accountCheckMode = (): AccountCheckMode => {
	const wert = (process.env[ENV] ?? '').trim().toLowerCase()
	if (wert === 'enforce' || wert === 'report') return wert
	if (wert !== '') {
		console.warn(
			`[kontopruefung] ${ENV}="${wert}" ist unbekannt — es gilt "report" (erlaubt: report, enforce).`,
		)
	}
	return 'report'
}

const normalize = (email: string): string => email.trim().toLowerCase()

/**
 * Eine Adresse, so wie sie ins Protokoll darf: `post@levinkeller.de` wird zu
 * `p***@***eller.de`.
 *
 * Genug, um eine Adresse wiederzuerkennen, wenn man sie kennt, und zu wenig,
 * um sie aus dem Protokoll abzuschreiben. Diese Berichte laufen ueber
 * Protokolle und Meldungen an die Kontaktadresse — dort haben Elternadressen
 * im Klartext nichts zu suchen, auch nicht die einer Person, die gerade
 * herausfaellt.
 */
export const obfuscate = (email: string): string => {
	const adresse = normalize(email)
	if (!adresse) return '(leer)'
	const at = adresse.lastIndexOf('@')
	if (at < 1) return `${adresse.slice(0, 1)}***`
	const lokal = adresse.slice(0, at)
	const domain = adresse.slice(at + 1)
	return `${lokal.slice(0, 1)}***@***${domain.slice(-8)}`
}

/** Alle Adressen des Adressbuchs, normalisiert. */
const adressbuchMails = (db: Database): Set<string> =>
	new Set(
		db
			.prepare<[], { email: string }>(
				"SELECT DISTINCT lower(trim(email)) AS email FROM mitglieder WHERE email IS NOT NULL AND trim(email) != ''",
			)
			.all()
			.map((zeile) => zeile.email),
	)

/** Alle im Adressbuch hinterlegten Konten: `sub` und, wo vorhanden, Adresse. */
const verknuepfteKonten = (
	db: Database,
): { subs: Set<string>; subJeMail: Map<string, string> } => {
	const zeilen = db
		.prepare<[], { user_sub: string; email: string | null }>(
			'SELECT user_sub, lower(trim(email)) AS email FROM mitglieder WHERE user_sub IS NOT NULL',
		)
		.all()
	const subs = new Set<string>()
	const subJeMail = new Map<string, string>()
	for (const zeile of zeilen) {
		subs.add(zeile.user_sub)
		// Der erste gewinnt. Zwei Eintraege mit derselben Adresse sind moeglich
		// (geteiltes Postfach); welcher von beiden das Konto haelt, aendert an
		// der Antwort „dieses Postfach gehoert zu einem Konto" nichts.
		if (zeile.email && !subJeMail.has(zeile.email)) {
			subJeMail.set(zeile.email, zeile.user_sub)
		}
	}
	return { subs, subJeMail }
}

export type AccountCheckOptions = {
	db?: Database
	/** Ueberschreibt `LIST_ACCOUNT_CHECK`. Fuer Tests und Vorschauen. */
	mode?: AccountCheckMode
	/** Wofuer wird geprueft — steht so im Protokoll. */
	occasion: string
}

/**
 * Die Pruefung. EIN Aufruf gegen ZITADEL je Versand, nicht einer je Empfaenger.
 *
 * Generisch ueber den Empfaengertyp, weil drei Versandwege drei verschiedene
 * Typen haben (Listen-Empfaenger, Adressbuch-Zeile, Familienadresse). Die
 * Pruefung braucht von allen dasselbe Wenige — `kandidat` sagt ihr, wo es
 * steht. So bleibt sie EINE Regel; drei Kopien waeren drei Regeln, und eine
 * davon waere irgendwann die falsche.
 */
export const pruefeKonten = async <T>(
	recipients: readonly T[],
	kandidat: (empfaenger: T) => CheckCandidate,
	optionen: AccountCheckOptions,
): Promise<AccountCheck<T>> => {
	const db = optionen.db ?? openDb()
	const mode = optionen.mode ?? accountCheckMode()
	const occasion = optionen.occasion

	const extra = recipients.filter((r) => !kandidat(r).from_address_book)
	const zuPruefen = recipients.filter((r) => kandidat(r).from_address_book)

	const blind = (fehler: Error): AccountCheck<T> => {
		const bericht: AccountCheckReport = {
			mode,
			occasion,
			checked: zuPruefen.length,
			kept: zuPruefen.length,
			cut: [],
			extra_recipients: extra.length,
			accounts_without_entry: [],
			unavailable: fehler.message,
		}
		console.warn(
			`[kontopruefung] ${occasion}: ZITADEL nicht erreichbar (${fehler.message}) — in "report" wird trotzdem verschickt, die Pruefung ist blind.`,
		)
		return { recipients: [...recipients], cut: [], report: bericht }
	}

	let konten: GrantedAccount[]
	try {
		konten = await grantedAccounts()
	} catch (fehler) {
		if (
			fehler instanceof GrantsUnavailableError ||
			fehler instanceof GrantsConfigError
		) {
			// In `enforce` faellt der Versand aus. Der Aufrufer muss das behandeln
			// und darf den Fehler NICHT verschlucken — jede Aufrufstelle tut das
			// sichtbar (Listen-Eingang: 503, Rundmail: Abbruch, Putz-Erinnerung:
			// Termin zurueckgeben und spaeter erneut versuchen).
			if (mode === 'enforce') throw fehler
			return blind(fehler)
		}
		throw fehler
	}

	const authRole = klassenConfig().authRole
	const berechtigt = konten.filter((konto) => canRead(konto.roles, authRole))
	const subsMitRolle = new Set(berechtigt.map((k) => k.userId))
	const mailsMitRolle = new Set(
		berechtigt.map((k) => k.email).filter((mail) => mail !== ''),
	)

	const { subs: verknuepfteSubs, subJeMail } = verknuepfteKonten(db)

	const behalten: T[] = []
	const geschnitten: { recipient: T; reason: CutReason }[] = []
	/** Adressen ohne Konto, deren Grund erst noch bestimmt wird. */
	const offen: { recipient: T; email: string; sub: string | undefined }[] = []

	for (const empfaenger of zuPruefen) {
		const email = normalize(kandidat(empfaenger).email)
		const sub = subJeMail.get(email)
		// Zuerst der stabile Schluessel: Wer sich einmal angemeldet hat, wird
		// darueber wiedererkannt, auch wenn die Adressen auseinandergelaufen sind.
		if (sub && subsMitRolle.has(sub)) {
			behalten.push(empfaenger)
			continue
		}
		if (mailsMitRolle.has(email)) {
			behalten.push(empfaenger)
			continue
		}
		offen.push({ recipient: empfaenger, email, sub })
	}

	// Erst jetzt, und nur wenn ueberhaupt jemand herausfaellt: die zweite
	// Abfrage. Im gruenen Fall bleibt es bei einer.
	let bekannt: { subs: Set<string>; mails: Set<string> } | null = null
	if (offen.length > 0) {
		try {
			const alle = await knownAccounts()
			bekannt = {
				subs: new Set(alle.map((k) => k.userId)),
				mails: new Set(alle.map((k) => k.email).filter((m) => m !== '')),
			}
		} catch (fehler) {
			if (
				fehler instanceof GrantsUnavailableError ||
				fehler instanceof GrantsConfigError
			) {
				if (mode === 'enforce') throw fehler
				return blind(fehler)
			}
			throw fehler
		}
	}

	/**
	 * Der Grund, in der Reihenfolge, in der er einem Menschen etwas sagt:
	 *
	 *   Ein hinterlegter `sub`, den ZITADEL nicht mehr kennt -> das Konto ist
	 *   geloescht. Der Adressbuch-Eintrag ist eine Leiche und gehoert weg.
	 *   Ein Konto ist da (ueber `sub` oder ueber die Adresse), aber ohne Rolle
	 *   -> der Grant wurde entzogen. Entweder war das Absicht, dann gehoert der
	 *   Eintrag ebenfalls weg; oder es war keine, dann fehlt der Grant.
	 *   Sonst -> es gibt zu dieser Adresse ueberhaupt kein Konto. Meist eine
	 *   Adresse, die nie eingeladen wurde.
	 */
	const grund = (email: string, sub: string | undefined): CutReason => {
		if (!bekannt) return 'no_account'
		if (sub) return bekannt.subs.has(sub) ? 'role_missing' : 'account_unknown'
		return bekannt.mails.has(email) ? 'role_missing' : 'no_account'
	}

	for (const { recipient, email, sub } of offen) {
		geschnitten.push({ recipient, reason: grund(email, sub) })
	}

	// Die andere Richtung: Wer dazugehoert, steht aber nicht im Adressbuch und
	// bekommt deshalb nichts. Das faellt sonst NIEMANDEM auf — in einer
	// Zustellung fehlt niemand, den man vermissen koennte.
	const imAdressbuch = adressbuchMails(db)
	const ohneEintrag = berechtigt.filter(
		(konto) =>
			!verknuepfteSubs.has(konto.userId) &&
			(konto.email === '' || !imAdressbuch.has(konto.email)),
	)

	const report: AccountCheckReport = {
		mode,
		occasion,
		checked: zuPruefen.length,
		kept: mode === 'enforce' ? behalten.length : zuPruefen.length,
		cut: geschnitten.map(({ recipient, reason }) => ({
			email: obfuscate(kandidat(recipient).email),
			reason,
		})),
		extra_recipients: extra.length,
		accounts_without_entry: ohneEintrag.map((konto) =>
			konto.email ? obfuscate(konto.email) : `sub:${konto.userId}`,
		),
		unavailable: null,
	}

	protokolliere(report)

	return {
		// In `report` wird NICHTS geschnitten — die urspruengliche Reihenfolge
		// bleibt damit auch erhalten. In `enforce` bleiben die Geprueften, die
		// bestanden haben, plus die Einzeladressen.
		recipients: mode === 'enforce' ? [...behalten, ...extra] : [...recipients],
		cut: geschnitten,
		report,
	}
}

/**
 * Eine Zeile je Versand. Sie steht auch dann da, wenn nichts zu beanstanden ist
 * — sonst laesst sich nicht unterscheiden, ob die Pruefung nichts gefunden hat
 * oder gar nicht gelaufen ist.
 */
const protokolliere = (report: AccountCheckReport): void => {
	const teile = [
		`${report.occasion}: ${report.checked} geprueft, ${report.kept} zugestellt`,
		`${report.extra_recipients} Einzeladresse(n) ohne Eintrag (Ausnahme)`,
	]
	if (report.cut.length > 0) {
		const verb = report.mode === 'enforce' ? 'geschnitten' : 'WUERDE schneiden'
		teile.push(
			`${report.cut.length} ${verb}: ${report.cut
				.map((e) => `${e.email} (${e.reason})`)
				.join(', ')}`,
		)
	}
	if (report.accounts_without_entry.length > 0) {
		teile.push(
			`${report.accounts_without_entry.length} Konto/Konten mit Rolle ohne Adressbuch-Eintrag: ${report.accounts_without_entry.join(', ')}`,
		)
	}
	console.log(`[kontopruefung] (${report.mode}) ${teile.join(' — ')}`)
}

/**
 * HAT DER BERICHT ETWAS ZU MELDEN?
 *
 * Die eine Stelle, die entscheidet, ob dieser Bericht jemanden UNGEFRAGT
 * erreichen darf. Wer ihn abruft — als Rueckgabewert, im Protokoll, im
 * MCP-Ergebnis —, bekommt ihn immer; das kostet niemanden etwas. Wer eine MAIL
 * bekommt, muss einen Anlass dafuer haben.
 *
 * Der Anlass ist eine ABWEICHUNG, und es gibt genau zwei:
 *
 *   `cut`                    Jemand wurde uebergangen (oder wuerde es).
 *   `accounts_without_entry` Jemandem fehlt der Adressbuch-Eintrag.
 *
 * Ausdruecklich KEIN Anlass ist das saubere Ergebnis. Die Putz-Erinnerung
 * laeuft jeden Sonntag; bei sauberer Lage — und die ist heute in beiden Klassen
 * sauber — waere das woechentlich eine Mail, in der nichts steht. Solche Mails
 * lernt man wegzuklicken, und danach klickt man die weg, in der etwas steht.
 * Der Wortlaut des Betreibers dazu: „das will ich nicht andauernd bekommen. ich
 * will nur fehler sehen."
 *
 * Ebenfalls kein Anlass ist eine BLINDE Pruefung (`unavailable`): Sie hat
 * niemanden uebergangen und niemanden vermisst. Eine Stoerung von ZITADEL ist
 * ein Betriebsereignis und gehoert ins Protokoll (`console.warn` oben) — in
 * `enforce` faellt sie ohnehin dadurch auf, dass nichts verschickt wird.
 */
export const hatBefund = (report: AccountCheckReport): boolean =>
	report.cut.length > 0 || report.accounts_without_entry.length > 0

/**
 * Der Bericht als Text fuer eine Meldung an die Kontaktadresse. Deutsch, weil
 * ihn ein Mensch liest.
 *
 * Ob er ueberhaupt verschickt wird, entscheidet `hatBefund()` — nicht diese
 * Funktion. Sie formuliert nur.
 */
export const berichtAlsText = (report: AccountCheckReport): string => {
	if (report.unavailable) {
		return `Konten-Pruefung (${report.mode}): ZITADEL war nicht erreichbar (${report.unavailable}). Es wurde ohne Pruefung verschickt.`
	}
	const zeilen = [
		`Konten-Pruefung (${report.mode}) fuer ${report.occasion}:`,
		`    ${report.checked} Empfaenger geprueft, ${report.kept} zugestellt, ${report.extra_recipients} Einzeladresse(n) ohne Adressbuch-Eintrag (bewusste Ausnahme).`,
	]
	if (report.cut.length > 0) {
		zeilen.push(
			report.mode === 'enforce'
				? 'Diese Adressen wurden GESCHNITTEN (kein Konto mit Rolle in dieser Klasse):'
				: 'Diese Adressen WUERDEN geschnitten, sobald die Pruefung scharf steht:',
			...report.cut.map((e) => `    ${e.email} — ${e.reason}`),
		)
	}
	if (report.accounts_without_entry.length > 0) {
		zeilen.push(
			'Diese Konten haben eine Rolle in dieser Klasse, aber KEINEN Adressbuch-Eintrag — sie bekommen keine Post:',
			...report.accounts_without_entry.map((e) => `    ${e}`),
		)
	}
	return zeilen.join('\n')
}
