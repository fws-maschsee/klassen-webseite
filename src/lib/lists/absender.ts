import { normalizeEmail } from '../db/mailingLists.ts'

export const CLOUDFLARE_AUTHSERV_ID = 'mx.cloudflare.net'

export type HeaderLine = { key: string; line: string }

const AUTH_HEADER_KEYS = new Set([
	'authentication-results',
	'arc-authentication-results',
])

const ohneKommentare = (wert: string): string => {
	let vorher = wert
	for (;;) {
		const nachher = vorher.replace(/\([^()]*\)/g, ' ')
		if (nachher === vorher) return nachher
		vorher = nachher
	}
}

const headerWert = ({ line }: HeaderLine): string =>
	line
		.slice(line.indexOf(':') + 1)
		.replace(/\r?\n[ \t]+/g, ' ')
		.trim()

type AuthResults = { authservId: string; ergebnisse: string[] }

const parseAuthResults = (header: HeaderLine): AuthResults | null => {
	const teile = ohneKommentare(headerWert(header))
		.split(';')
		.map((t) => t.trim())
		.filter((t) => t.length > 0)
	if (header.key === 'arc-authentication-results') {
		if (!/^i=\d+$/i.test(teile[0] ?? '')) return null
		teile.shift()
	}
	const authservId = teile.shift()?.split(/\s+/)[0]?.toLowerCase()
	if (!authservId) return null
	return { authservId, ergebnisse: teile }
}

const dmarcPassDomain = (ergebnisse: string[]): string | null => {
	for (const ergebnis of ergebnisse) {
		const methode = ergebnis.match(/^dmarc\s*=\s*(\S+)/i)
		if (!methode) continue
		if (methode[1]?.toLowerCase() !== 'pass') return null
		const domain = ergebnis.match(/\bheader\.from\s*=\s*([^\s;]+)/i)?.[1]
		return domain ? domain.toLowerCase() : null
	}
	return null
}

// Nur der oberste Auth-Header zählt: Cloudflare stellt seinen vor alle anderen, ein vom Absender mitgeschickter liegt immer darunter.
export const dmarcGepruefteDomain = (
	headerLines: readonly HeaderLine[],
	authservId: string = CLOUDFLARE_AUTHSERV_ID,
): string | null => {
	const oberster = headerLines.find((h) => AUTH_HEADER_KEYS.has(h.key))
	if (!oberster) return null
	const parsed = parseAuthResults(oberster)
	if (!parsed || parsed.authservId !== authservId) return null
	return dmarcPassDomain(parsed.ergebnisse)
}

const domainVon = (email: string): string =>
	email.slice(email.lastIndexOf('@') + 1)

export const authentifizierterHeaderAbsender = (
	headerLines: readonly HeaderLine[],
	fromAdressen: readonly string[],
): string | null => {
	if (fromAdressen.length !== 1) return null
	const email = normalizeEmail(fromAdressen[0] ?? '')
	if (!email.includes('@')) return null
	const domain = dmarcGepruefteDomain(headerLines)
	return domain !== null && domain === domainVon(email) ? email : null
}
