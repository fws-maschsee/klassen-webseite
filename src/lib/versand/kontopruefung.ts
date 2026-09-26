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

export type AccountCheckMode = 'report' | 'enforce'

export type CutReason = 'no_account' | 'account_unknown' | 'role_missing'

export type CheckCandidate = {
	email: string
	// `false`: Einzeladresse einer Liste (Sekretariat, Fachlehrer) ohne Konto – passiert die Pruefung immer.
	from_address_book: boolean
}

export type AccountCheckReport = {
	mode: AccountCheckMode
	occasion: string
	checked: number
	kept: number
	cut: { email: string; reason: CutReason }[]
	extra_recipients: number
	accounts_without_entry: string[]
	unavailable: string | null
}

export type AccountCheck<T> = {
	recipients: T[]
	cut: { recipient: T; reason: CutReason }[]
	report: AccountCheckReport
}

const ENV = 'LIST_ACCOUNT_CHECK'

// `report` als Vorgabe, damit eine neue Klasse nicht still den halben Verteiler verliert;
// ein unbekannter Wert (Tippfehler) faellt deshalb auch auf `report` zurueck, nie auf `enforce`.
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

export const obfuscate = (email: string): string => {
	const adresse = normalize(email)
	if (!adresse) return '(leer)'
	const at = adresse.lastIndexOf('@')
	if (at < 1) return `${adresse.slice(0, 1)}***`
	const lokal = adresse.slice(0, at)
	const domain = adresse.slice(at + 1)
	return `${lokal.slice(0, 1)}***@***${domain.slice(-8)}`
}

const adressbuchMails = (db: Database): Set<string> =>
	new Set(
		db
			.prepare<[], { email: string }>(
				"SELECT DISTINCT lower(trim(email)) AS email FROM mitglieder WHERE email IS NOT NULL AND trim(email) != ''",
			)
			.all()
			.map((zeile) => zeile.email),
	)

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
		if (zeile.email && !subJeMail.has(zeile.email)) {
			subJeMail.set(zeile.email, zeile.user_sub)
		}
	}
	return { subs, subJeMail }
}

export type AccountCheckOptions = {
	db?: Database
	mode?: AccountCheckMode
	occasion: string
}

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
	const offen: { recipient: T; email: string; sub: string | undefined }[] = []

	for (const empfaenger of zuPruefen) {
		const email = normalize(kandidat(empfaenger).email)
		const sub = subJeMail.get(email)
		// Erst der stabile `sub`, dann die Adresse: `sub` entsteht erst beim ersten Login und fehlt meist noch.
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

	const grund = (email: string, sub: string | undefined): CutReason => {
		if (!bekannt) return 'no_account'
		if (sub) return bekannt.subs.has(sub) ? 'role_missing' : 'account_unknown'
		return bekannt.mails.has(email) ? 'role_missing' : 'no_account'
	}

	for (const { recipient, email, sub } of offen) {
		geschnitten.push({ recipient, reason: grund(email, sub) })
	}

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
		recipients: mode === 'enforce' ? [...behalten, ...extra] : [...recipients],
		cut: geschnitten,
		report,
	}
}

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

export const hatBefund = (report: AccountCheckReport): boolean =>
	report.cut.length > 0 || report.accounts_without_entry.length > 0

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
