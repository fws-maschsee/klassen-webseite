const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// Allowlist statt jeder https-Adresse: ein Code an einen fremden Server ist genau das Zustimmungs-Phishing.
// Registriert haben sich bisher nur der Claude-Connector (claude.ai) und Claude Code (loopback).
const FREIGEGEBENE_HOSTS = new Set(['claude.ai', 'claude.com'])

export type RedirectZiel =
	| { art: 'freigegeben'; host: string }
	| { art: 'lokal'; host: string }

export type RedirectPruefung =
	| { ok: true; ziel: RedirectZiel }
	| { ok: false; grund: string }

export const pruefeRedirectUri = (uri: string): RedirectPruefung => {
	let url: URL
	try {
		url = new URL(uri)
	} catch {
		return { ok: false, grund: `${uri} ist keine absolute URL` }
	}
	if (uri.includes('#')) {
		return { ok: false, grund: `${uri} enthält ein Fragment` }
	}
	if (url.username || url.password) {
		return { ok: false, grund: `${uri} enthält Zugangsdaten` }
	}
	if (LOOPBACK_HOSTS.has(url.hostname)) {
		if (url.protocol === 'http:' || url.protocol === 'https:') {
			return { ok: true, ziel: { art: 'lokal', host: url.host } }
		}
		return { ok: false, grund: `${uri}: nur http(s) für loopback` }
	}
	if (url.protocol !== 'https:') {
		return {
			ok: false,
			grund: `${uri}: außer loopback ist nur https erlaubt`,
		}
	}
	if (!FREIGEGEBENE_HOSTS.has(url.hostname)) {
		return {
			ok: false,
			grund: `${url.hostname} ist kein freigegebenes Ziel (erlaubt: ${[...FREIGEGEBENE_HOSTS].join(', ')} und loopback)`,
		}
	}
	return { ok: true, ziel: { art: 'freigegeben', host: url.host } }
}
