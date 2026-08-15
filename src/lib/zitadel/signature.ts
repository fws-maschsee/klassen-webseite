import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Die Signatur, mit der ZITADEL seine Webhooks unterschreibt.
 *
 * ZITADEL Actions v2 rufen ein „Target" auf und legen den Beweis in einen
 * Header. Beim Anlegen des Targets faellt einmalig ein `signingKey` an — ein
 * geteiltes Geheimnis; beide Seiten rechnen damit dasselbe HMAC-SHA256 aus.
 *
 *   ZITADEL-Signature: t=1755244800,v1=3f9a...
 *
 * Unterschrieben wird `${t}.${rawBody}` — der Zeitstempel gehoert MIT in die
 * Rechnung. Ohne ihn koennte man einen mitgeschnittenen Aufruf beliebig oft und
 * beliebig spaet wiederholen; mit ihm ist die Wiederholung an ein Zeitfenster
 * gebunden (`TOLERANZ_SEKUNDEN`).
 *
 * WARUM HMAC UND NICHT ED25519 wie beim Listeneingang: Das gibt ZITADEL vor.
 * Der Unterschied ist real — wer den `signingKey` hat, kann Aufrufe nicht nur
 * pruefen, sondern auch erzeugen. Deshalb ist er ein Secret und steht, anders
 * als `listPublicKeyPem`, nicht in der Konfiguration im Repo.
 *
 * Der rohe Rumpf ist die Grundlage, nicht das geparste JSON. Zwei Programme
 * serialisieren dasselbe Objekt verschieden (Reihenfolge, Leerzeichen,
 * Unicode-Escapes); wer ueber das Ergebnis eines `JSON.stringify` rechnet,
 * prueft am Ende seine eigene Formatierung.
 */

/** Der Header, in dem die Unterschrift steht. HTTP-Header sind case-insensitiv. */
export const SIGNATURE_HEADER = 'ZITADEL-Signature'

/**
 * Wie weit der mitsignierte Zeitstempel vom Jetzt abweichen darf, in Sekunden.
 * Fuenf Minuten in beide Richtungen: genug fuer eine Uhr, die ein wenig
 * abgeht, zu wenig fuer eine Wiederholung von gestern.
 */
export const TOLERANZ_SEKUNDEN = 300

export type SignaturPruefung = { ok: true } | { ok: false; grund: string }

/** Zerlegt `t=…,v1=…` in seine Bestandteile. Unbekannte Schluessel fallen weg. */
export const parseSignaturHeader = (
	header: string,
): { t?: string; v1: string[] } => {
	const v1: string[] = []
	let t: string | undefined
	for (const teil of header.split(',')) {
		const trenner = teil.indexOf('=')
		if (trenner === -1) continue
		const schluessel = teil.slice(0, trenner).trim()
		const wert = teil.slice(trenner + 1).trim()
		if (schluessel === 't') t ??= wert
		// Mehrere `v1` sind erlaubt: Waehrend eines Schluesselwechsels schickt
		// ZITADEL beide Unterschriften, und es genuegt, wenn EINE passt.
		else if (schluessel === 'v1') v1.push(wert)
	}
	return { t, v1 }
}

/** Vergleicht zwei Hex-Zeichenketten in konstanter Zeit. */
const gleich = (a: string, b: string): boolean => {
	const links = Buffer.from(a, 'hex')
	const rechts = Buffer.from(b, 'hex')
	// `timingSafeEqual` wirft bei ungleicher Laenge; die Laenge selbst ist kein
	// Geheimnis, also darf sie vorher geprueft werden.
	if (links.length === 0 || links.length !== rechts.length) return false
	return timingSafeEqual(links, rechts)
}

/** Die erwartete Unterschrift fuer diesen Zeitstempel und diesen Rumpf. */
export const berechneSignatur = (
	signingKey: string,
	timestamp: string,
	rawBody: string,
): string =>
	createHmac('sha256', signingKey)
		.update(`${timestamp}.${rawBody}`)
		.digest('hex')

/**
 * Prueft eine eingehende Unterschrift.
 *
 * Jeder Fehlerfall ist ein `ok: false` mit Grund — der Grund ist fuer das
 * Protokoll, nicht fuer die Antwort. Nach draussen geht ausschliesslich „nein",
 * denn eine Antwort, die den Unterschied zwischen „Header fehlt", „Zeitstempel
 * zu alt" und „Unterschrift falsch" verraet, ist eine Anleitung.
 */
export const pruefeSignatur = (eingabe: {
	header: string | null
	rawBody: string
	signingKey: string
	jetzt?: Date
}): SignaturPruefung => {
	const { header, rawBody, signingKey } = eingabe
	if (!signingKey)
		return { ok: false, grund: 'kein Signaturschluessel gesetzt' }
	if (!header) return { ok: false, grund: `${SIGNATURE_HEADER} fehlt` }

	const { t, v1 } = parseSignaturHeader(header)
	if (!t || v1.length === 0) {
		return { ok: false, grund: `${SIGNATURE_HEADER} unlesbar` }
	}

	const sekunden = Number.parseInt(t, 10)
	if (!Number.isFinite(sekunden)) {
		return { ok: false, grund: 'Zeitstempel keine Zahl' }
	}
	const jetzt = Math.floor((eingabe.jetzt ?? new Date()).getTime() / 1000)
	if (Math.abs(jetzt - sekunden) > TOLERANZ_SEKUNDEN) {
		return { ok: false, grund: 'Zeitstempel ausserhalb der Toleranz' }
	}

	const erwartet = berechneSignatur(signingKey, t, rawBody)
	if (!v1.some((kandidat) => gleich(erwartet, kandidat))) {
		return { ok: false, grund: 'Unterschrift passt nicht' }
	}
	return { ok: true }
}
