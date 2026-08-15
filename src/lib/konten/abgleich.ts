import type { Database } from 'better-sqlite3'
import { klassenConfig } from '../../klasse/config.ts'
import { grantedAccounts } from '../../server/auth/grants.ts'
import { canRead } from '../../server/auth/roles.ts'
import { openDb } from '../db/index.ts'
import { getMitgliedGroups } from '../db/members.ts'
import { type CutReason, pruefeKonten } from '../versand/kontopruefung.ts'

/**
 * DER ABGLEICH: das Adressbuch dieser Klasse gegen die Grants ihres
 * ZITADEL-Projekts — und zwar in BEIDE Richtungen.
 *
 * WARUM ES IHN GIBT, und warum an dieser Stelle vorher ein Webhook stand.
 *
 * Bis zum 15.08. hing hier ein Empfaenger fuer ZITADEL Actions v2: `user.removed`
 * kam herein, die Loesch-Kaskade lief los. Er ist entfernt, und der Grund ist
 * nicht Geschmack — in der Instanz gibt es ueberhaupt keine Actions-v2-Targets
 * (`Target not found`). Das Target, das ihn haette rufen sollen, wurde nie
 * angelegt; der Endpunkt hat in seiner ganzen Lebenszeit keinen einzigen Aufruf
 * gesehen. Ein Ereignis, das nie kommt, ist keine Absicherung.
 *
 * Und selbst verdrahtet haette er das Falsche gemeldet. `user.removed` ist das
 * GELOESCHTE KONTO. Der Normalfall aber ist „austragen statt loeschen": Wer die
 * Schule verlaesst, verliert die Rollen, das Konto bleibt (allenfalls
 * deaktiviert) stehen. EIN ENTZOGENER GRANT LOEST KEIN EREIGNIS AUS.
 *
 * DIE MESSUNG, aus der das folgt: Genau dieser Abgleich, am 15.08. von Hand
 * durchgefuehrt, fand DREI ABWEICHUNGEN — zwei Konten einer weggezogenen
 * Familie, die noch Zugang hatten, und eine Person ohne Konto. Der Webhook
 * haette von keiner der drei etwas gemeldet: zweimal, weil ein entzogener Grant
 * kein Ereignis ist, und einmal, weil „hat nie ein Konto gehabt" erst recht
 * keines ist. Deshalb steht hier jetzt nichts, worauf man wartet, sondern etwas,
 * das FRAGT.
 *
 * MELDEN, NICHT LOESCHEN. Dieses Modul fasst nichts an, in keiner Betriebsart —
 * es gibt keine. Die Fehlerrichtung ist der Grund: Eine Stoerung bei ZITADEL
 * sieht aus wie „alle ausgetreten", und ein Aufraeumen, das darauf hereinfaellt,
 * loescht den ganzen Verteiler. Deshalb WIRFT der Abgleich bei einer Stoerung
 * (`GrantsUnavailableError`, `GrantsConfigError`), statt eine leere Grant-Menge
 * als Ergebnis auszugeben. Ein Bericht, der nichts gefunden hat, und ein
 * Bericht, der nichts fragen konnte, duerfen nicht gleich aussehen.
 *
 * Wer nach dem Lesen wirklich loeschen will, ruft `delete_account` (Konto samt
 * Eintrag — der DSGVO-Weg) oder `delete_mitglied` (nur der Eintrag). Beides
 * benennt eine Person, und beides tut ein Mensch.
 *
 * ES IST KEIN UEBERTRAG, und der Waechter
 * (`tests/auth/getrennte-datenschichten.test.ts`) laesst auch keinen zu: Hier
 * wird aus ZITADEL GELESEN und mit dem Adressbuch VERGLICHEN. Geschrieben wird
 * nichts — kein Eintrag angelegt, keiner geaendert, keiner entfernt.
 */

/**
 * Die Regel „gibt es zu diesem Eintrag ein Konto mit Rolle" steht NICHT hier.
 *
 * Sie steht in `pruefeKonten()` (`src/lib/versand/kontopruefung.ts`), weil sie
 * dort vor jedem Versand ohnehin gebraucht wird: erst der stabile `user_sub`,
 * dann die normalisierte Adresse, und der Grund fuer einen Schnitt in der
 * Reihenfolge, in der er einem Menschen etwas sagt. Der Abgleich stellt genau
 * dieselbe Frage — nur fuer ALLE Eintraege statt fuer die Empfaenger EINES
 * Versands. Zwei Kopien derselben Regel waeren zwei Regeln, und eine davon waere
 * irgendwann die falsche.
 */

/** Ein Adressbuch-Eintrag, zu dem es kein Konto mit Leserolle gibt. */
export type EntryWithoutAccount = {
	mitglied_id: string
	name: string
	/** Leer, wenn im Adressbuch keine Adresse steht. */
	email: string
	/** Der hinterlegte `sub`, falls sich die Person schon einmal angemeldet hat. */
	user_sub: string | null
	/** Gruppen des Eintrags — ohne Gruppe bekaeme er ohnehin keine Post. */
	groups: string[]
	reason: CutReason
}

/** Ein Konto mit Leserolle, zu dem es keinen Adressbuch-Eintrag gibt. */
export type AccountWithoutEntry = {
	user_id: string
	/** Anmeldeadresse aus ZITADEL. Leer, wenn ZITADEL keine mitliefert. */
	email: string
	roles: string[]
}

/**
 * Der Bericht. Feldnamen und Werte englisch — das liest ein Programm; die
 * Begruendungen daneben liest ein Mensch.
 */
export type AbgleichBericht = {
	instance: string
	/** Rolle, die als „gehoert dazu" gilt (`authRole` der Klasse). */
	role: string
	/** Adressbuch-Eintraege insgesamt. */
	entries: number
	/** Davon mit Konto und Leserolle. */
	entries_with_account: number
	entries_without_account: EntryWithoutAccount[]
	accounts_without_entry: AccountWithoutEntry[]
}

/** Eintraege mit ihrem `sub` — `listMitglieder()` gibt den nicht heraus. */
type EintragRow = {
	id: string
	first_name: string
	last_name: string
	email: string | null
	user_sub: string | null
}

const eintraege = (db: Database): EintragRow[] =>
	db
		.prepare<[], EintragRow>(
			`SELECT id, first_name, last_name, email, user_sub
         FROM mitglieder ORDER BY last_name, first_name`,
		)
		.all()

const normalize = (email: string | null): string =>
	(email ?? '').trim().toLowerCase()

export type AbgleichOptionen = {
	db?: Database
}

/**
 * Der Abgleich. EINE Abfrage gegen ZITADEL (dieselbe, die auch die
 * Versandpruefung benutzt, mitsamt ihrem kurzen Zwischenspeicher), plus eine
 * zweite nur dann, wenn ueberhaupt jemand herausfaellt.
 *
 * Wirft bei einer Stoerung. Das ist die ganze Absicht — siehe oben.
 */
export const abgleichen = async (
	optionen: AbgleichOptionen = {},
): Promise<AbgleichBericht> => {
	const db = optionen.db ?? openDb()
	const alle = eintraege(db)

	/**
	 * `enforce` heisst hier NICHT, dass etwas geschnitten wird — es wird nichts
	 * versendet und nichts geloescht. Es heisst nur: Bei einer Stoerung will
	 * dieser Aufrufer den FEHLER sehen und nicht den blinden Bericht, den
	 * `report` fuer den Versand ausgibt. Ein Abgleich, der „alle fehlen" meldet,
	 * weil ZITADEL huestet, waere schlimmer als gar keiner.
	 */
	const pruefung = await pruefeKonten(
		alle,
		(eintrag) => ({
			email: normalize(eintrag.email),
			// Jeder Eintrag wird geprueft. Die Ausnahme fuer `extra_recipients`
			// (Einzeladressen einer Liste ohne Adressbuch-Eintrag) gibt es hier
			// nicht: Was hier hereinkommt, IST das Adressbuch.
			from_address_book: true,
		}),
		{ db, mode: 'enforce', occasion: 'Abgleich Adressbuch/ZITADEL' },
	)

	const ohneKonto: EntryWithoutAccount[] = pruefung.cut.map(
		({ recipient, reason }) => ({
			mitglied_id: recipient.id,
			name: `${recipient.first_name} ${recipient.last_name}`.trim(),
			email: normalize(recipient.email),
			user_sub: recipient.user_sub,
			groups: getMitgliedGroups(recipient.id, db),
			reason,
		}),
	)

	/**
	 * Die andere Richtung wird hier ausgerechnet und nicht aus dem Versandbericht
	 * uebernommen, obwohl der sie auch kennt: Dort stehen die Adressen
	 * OBFUSKIERT, weil dieser Bericht ueber Protokolle und Meldungen laeuft.
	 * Dieses Werkzeug antwortet einer Person mit der Rolle `admin`, die den
	 * Fehler abstellen soll — mit `p***@***eller.de` kann sie niemanden
	 * einladen und keinen Eintrag anlegen.
	 */
	const rolle = klassenConfig().authRole
	const berechtigt = (await grantedAccounts()).filter((konto) =>
		canRead(konto.roles, rolle),
	)
	const bekannteSubs = new Set(
		alle.map((e) => e.user_sub).filter((sub): sub is string => sub !== null),
	)
	const bekannteMails = new Set(
		alle.map((e) => normalize(e.email)).filter((mail) => mail !== ''),
	)
	const ohneEintrag: AccountWithoutEntry[] = berechtigt
		.filter(
			(konto) =>
				!bekannteSubs.has(konto.userId) &&
				(konto.email === '' || !bekannteMails.has(konto.email)),
		)
		.map((konto) => ({
			user_id: konto.userId,
			email: konto.email,
			roles: konto.roles,
		}))

	return {
		instance: klassenConfig().slug,
		role: rolle,
		entries: alle.length,
		entries_with_account: alle.length - ohneKonto.length,
		entries_without_account: ohneKonto,
		accounts_without_entry: ohneEintrag,
	}
}

/**
 * Der Bericht als Text fuer einen Menschen. Deutsch, und mit dem Handgriff
 * dabei: Ein Befund ohne den naechsten Schritt laesst den Leser genau dort
 * stehen, wo er vorher stand.
 */
export const abgleichAlsText = (bericht: AbgleichBericht): string => {
	const zeilen = [
		`Abgleich fuer ${bericht.instance}: ${bericht.entries} Adressbuch-Eintraege, davon ${bericht.entries_with_account} mit Konto und Rolle "${bericht.role}".`,
	]
	if (bericht.entries_without_account.length > 0) {
		zeilen.push(
			`${bericht.entries_without_account.length} Eintrag/Eintraege OHNE Konto — sie bekommen nach dem Scharfschalten (LIST_ACCOUNT_CHECK=enforce) keine Post mehr:`,
			...bericht.entries_without_account.map(
				(e) =>
					`    ${e.name} <${e.email || 'ohne Adresse'}> — ${e.reason}${e.groups.length > 0 ? ` (Gruppen: ${e.groups.join(', ')})` : ' (in keiner Gruppe)'}`,
			),
		)
	}
	if (bericht.accounts_without_entry.length > 0) {
		zeilen.push(
			`${bericht.accounts_without_entry.length} Konto/Konten MIT Rolle ohne Adressbuch-Eintrag — sie gehoeren dazu, bekommen aber nichts:`,
			...bericht.accounts_without_entry.map(
				(k) => `    ${k.email || `sub:${k.user_id}`} (${k.roles.join(', ')})`,
			),
		)
	}
	if (
		bericht.entries_without_account.length === 0 &&
		bericht.accounts_without_entry.length === 0
	) {
		zeilen.push('Keine Abweichung.')
	}
	return zeilen.join('\n')
}
