import {
	createHash,
	createPublicKey,
	type KeyObject,
	verify as verifySignature,
} from 'node:crypto'
import { Resolver } from 'node:dns/promises'

export type ResolveTxt = (name: string) => Promise<string[][]>

export type DkimErgebnis =
	| { kind: 'pass'; domain: string }
	| { kind: 'fail'; reason: string }
	| { kind: 'temperror'; reason: string }

type RohHeader = { name: string; raw: string }

const MAX_SIGNATUREN = 5

const dnsResolver = new Resolver({ timeout: 3000, tries: 2 })
export const systemResolveTxt: ResolveTxt = (name) =>
	dnsResolver.resolveTxt(name)

// latin1 bildet jedes Byte 1:1 auf ein Zeichen ab; nur so bleibt `c=simple` byte-genau.
const zerlegeNachricht = (
	raw: Buffer,
): { header: RohHeader[]; body: Buffer } => {
	const text = raw.toString('latin1').replace(/\r?\n/g, '\r\n')
	const trenner = text.indexOf('\r\n\r\n')
	const kopf = trenner === -1 ? text : text.slice(0, trenner + 2)
	const body = trenner === -1 ? '' : text.slice(trenner + 4)
	const header: RohHeader[] = []
	for (const zeile of kopf.split(/\r\n(?![ \t])/)) {
		if (zeile === '') continue
		const doppelpunkt = zeile.indexOf(':')
		if (doppelpunkt <= 0) continue
		header.push({
			name: zeile.slice(0, doppelpunkt).trim().toLowerCase(),
			raw: `${zeile}\r\n`,
		})
	}
	return { header, body: Buffer.from(body, 'latin1') }
}

const tags = (wert: string): Map<string, string> => {
	const ergebnis = new Map<string, string>()
	for (const teil of wert.split(';')) {
		const gleich = teil.indexOf('=')
		if (gleich === -1) continue
		const name = teil.slice(0, gleich).trim()
		if (name === '' || ergebnis.has(name)) continue
		ergebnis.set(name, teil.slice(gleich + 1).replace(/\s+/g, ''))
	}
	return ergebnis
}

const headerWert = (raw: string): string => raw.slice(raw.indexOf(':') + 1)

const relaxedHeader = (raw: string): string => {
	const doppelpunkt = raw.indexOf(':')
	const name = raw.slice(0, doppelpunkt).trim().toLowerCase()
	const wert = raw
		.slice(doppelpunkt + 1)
		.replace(/\r\n/g, '')
		.replace(/[ \t]+/g, ' ')
		.trim()
	return `${name}:${wert}\r\n`
}

const kanonischerBody = (body: Buffer, verfahren: string): Buffer => {
	let text = body.toString('latin1')
	if (verfahren === 'relaxed') {
		text = text
			.split('\r\n')
			.map((zeile) => zeile.replace(/[ \t]+/g, ' ').replace(/ $/, ''))
			.join('\r\n')
	}
	text = text.replace(/(\r\n)*$/, '')
	if (text !== '' || verfahren === 'simple') text += '\r\n'
	return Buffer.from(text, 'latin1')
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

const publicKey = (algorithmus: string, p: string): KeyObject => {
	const der = Buffer.from(p, 'base64')
	if (algorithmus === 'ed25519-sha256') {
		return createPublicKey({
			key: Buffer.concat([ED25519_SPKI_PREFIX, der]),
			format: 'der',
			type: 'spki',
		})
	}
	try {
		return createPublicKey({ key: der, format: 'der', type: 'spki' })
	} catch {
		return createPublicKey({ key: der, format: 'der', type: 'pkcs1' })
	}
}

const pruefeSignatur = async (
	signatur: RohHeader,
	alle: RohHeader[],
	body: Buffer,
	erwarteteDomain: string,
	resolveTxt: ResolveTxt,
	jetzt: Date,
): Promise<DkimErgebnis> => {
	const t = tags(headerWert(signatur.raw))
	const domain = t.get('d')?.toLowerCase()
	const selector = t.get('s')
	const algorithmus = t.get('a')?.toLowerCase()
	const b = t.get('b')
	const bh = t.get('bh')
	const signierteHeader = (t.get('h') ?? '')
		.toLowerCase()
		.split(':')
		.filter((h) => h !== '')
	if (t.get('v') !== '1' || !domain || !selector || !b || !bh)
		return { kind: 'fail', reason: 'unvollständige Signatur' }
	// Strikt statt DMARC-relaxed: ohne Public-Suffix-Liste ist die Organisationsdomain nicht sicher bestimmbar.
	if (domain !== erwarteteDomain)
		return { kind: 'fail', reason: `d=${domain} passt nicht zum From` }
	if (algorithmus !== 'rsa-sha256' && algorithmus !== 'ed25519-sha256')
		return { kind: 'fail', reason: `Algorithmus ${algorithmus} nicht erlaubt` }
	if (!signierteHeader.includes('from'))
		return { kind: 'fail', reason: 'From ist nicht signiert' }
	// Mit l= ließe sich an eine echte Mail beliebiger Text anhängen.
	if (t.has('l')) return { kind: 'fail', reason: 'l= wird nicht akzeptiert' }
	const ablauf = t.get('x')
	if (ablauf && Number(ablauf) * 1000 < jetzt.getTime())
		return { kind: 'fail', reason: 'Signatur abgelaufen' }

	const [headerVerfahren = 'simple', bodyVerfahren = 'simple'] = (
		t.get('c') ?? 'simple/simple'
	)
		.toLowerCase()
		.split('/')
	const kanonisch = (raw: string): string =>
		headerVerfahren === 'relaxed' ? relaxedHeader(raw) : raw

	const bodyHash = createHash('sha256')
		.update(kanonischerBody(body, bodyVerfahren))
		.digest('base64')
	if (bodyHash !== bh) return { kind: 'fail', reason: 'Body-Hash stimmt nicht' }

	const verbraucht = new Map<string, number>()
	let daten = ''
	for (const name of signierteHeader) {
		const kandidaten = alle.filter((h) => h.name === name && h !== signatur)
		const schon = verbraucht.get(name) ?? 0
		const treffer = kandidaten[kandidaten.length - 1 - schon]
		verbraucht.set(name, schon + 1)
		if (treffer) daten += kanonisch(treffer.raw)
	}
	const ohneB = signatur.raw.replace(
		/((?:^|;)\s*b\s*=)[^;]*/,
		(_, anfang: string) => anfang,
	)
	daten += kanonisch(ohneB).replace(/\r\n$/, '')

	let eintraege: string[][]
	try {
		eintraege = await resolveTxt(`${selector}._domainkey.${domain}`)
	} catch (fehler) {
		const code = (fehler as { code?: string }).code
		if (code === 'ENOTFOUND' || code === 'ENODATA')
			return { kind: 'fail', reason: 'kein DKIM-Schlüssel im DNS' }
		return {
			kind: 'temperror',
			reason: `DNS-Abfrage fehlgeschlagen (${code ?? String(fehler)})`,
		}
	}
	const schluessel = eintraege
		.map((teile) => tags(teile.join('')))
		.find((k) => k.has('p'))
	const p = schluessel?.get('p')
	if (!schluessel || !p)
		return { kind: 'fail', reason: 'DKIM-Schlüssel fehlt oder widerrufen' }
	const keyTyp = (schluessel.get('k') ?? 'rsa').toLowerCase()
	if ((algorithmus === 'ed25519-sha256') !== (keyTyp === 'ed25519'))
		return { kind: 'fail', reason: 'Schlüsseltyp passt nicht' }

	let gueltig: boolean
	try {
		const key = publicKey(algorithmus, p)
		const signaturBytes = Buffer.from(b, 'base64')
		const datenBytes = Buffer.from(daten, 'latin1')
		gueltig =
			algorithmus === 'ed25519-sha256'
				? verifySignature(
						null,
						createHash('sha256').update(datenBytes).digest(),
						key,
						signaturBytes,
					)
				: verifySignature('sha256', datenBytes, key, signaturBytes)
	} catch (fehler) {
		return {
			kind: 'fail',
			reason: `Schlüssel unbrauchbar (${fehler instanceof Error ? fehler.message : String(fehler)})`,
		}
	}
	return gueltig
		? { kind: 'pass', domain }
		: { kind: 'fail', reason: 'Signatur ungültig' }
}

export const pruefeDkimFuerDomain = async (
	raw: Buffer,
	domain: string,
	{
		resolveTxt = systemResolveTxt,
		jetzt = new Date(),
	}: { resolveTxt?: ResolveTxt; jetzt?: Date } = {},
): Promise<DkimErgebnis> => {
	const { header, body } = zerlegeNachricht(raw)
	const signaturen = header
		.filter((h) => h.name === 'dkim-signature')
		.slice(0, MAX_SIGNATUREN)
	if (signaturen.length === 0)
		return { kind: 'fail', reason: 'keine DKIM-Signatur' }
	// DKIM signiert den untersten From, Mailprogramme zeigen den obersten: mit zwei From ließe sich ein fremder voranstellen.
	if (header.filter((h) => h.name === 'from').length !== 1)
		return { kind: 'fail', reason: 'nicht genau ein From-Header' }
	const gruende: string[] = []
	let temperror: DkimErgebnis | null = null
	for (const signatur of signaturen) {
		const ergebnis = await pruefeSignatur(
			signatur,
			header,
			body,
			domain.toLowerCase(),
			resolveTxt,
			jetzt,
		)
		if (ergebnis.kind === 'pass') return ergebnis
		if (ergebnis.kind === 'temperror') temperror = ergebnis
		gruende.push(ergebnis.reason)
	}
	return temperror ?? { kind: 'fail', reason: gruende.join('; ') }
}
