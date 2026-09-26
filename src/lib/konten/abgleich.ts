import type { Database } from 'better-sqlite3'
import { klassenConfig } from '../../klasse/config.ts'
import { grantedAccounts } from '../../server/auth/grants.ts'
import { canRead } from '../../server/auth/roles.ts'
import { openDb } from '../db/index.ts'
import { getMitgliedGroups } from '../db/members.ts'
import { type CutReason, pruefeKonten } from '../versand/kontopruefung.ts'

export type EntryWithoutAccount = {
	mitglied_id: string
	name: string
	email: string
	user_sub: string | null
	groups: string[]
	reason: CutReason
}

export type AccountWithoutEntry = {
	user_id: string
	email: string
	roles: string[]
}

export type AbgleichBericht = {
	instance: string
	role: string
	entries: number
	entries_with_account: number
	entries_without_account: EntryWithoutAccount[]
	accounts_without_entry: AccountWithoutEntry[]
}

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

export const abgleichen = async (
	optionen: AbgleichOptionen = {},
): Promise<AbgleichBericht> => {
	const db = optionen.db ?? openDb()
	const alle = eintraege(db)

	const pruefung = await pruefeKonten(
		alle,
		(eintrag) => ({
			email: normalize(eintrag.email),
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

export const hatAbweichungen = (bericht: AbgleichBericht): boolean =>
	bericht.entries_without_account.length > 0 ||
	bericht.accounts_without_entry.length > 0

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
