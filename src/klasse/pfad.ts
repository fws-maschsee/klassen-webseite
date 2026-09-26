import path from 'node:path'
import { PUBLIC_PATHS } from './config.ts'

const AUTH_PREFIX = '/auth/'

/**
 * Der Pfad, wie ihn `express.static` und Astro am Ende auflösen — oder `null`, wenn die Anfrage
 * mit 400 abzuweisen ist. Zugriffsentscheidungen fallen nur auf diesem Ergebnis, nie auf dem Rohpfad:
 * `/public/..%2fdokumente/x.pdf` beginnt roh mit `/public/`, ausgeliefert wird aber `/dokumente/x.pdf`.
 */
export const normalisierterPfad = (roh: string): string | null => {
	if (/%(2f|5c)/i.test(roh)) return null

	let entpackt: string
	try {
		entpackt = decodeURIComponent(roh)
	} catch {
		return null
	}

	if (!entpackt.startsWith('/')) return null
	if (entpackt.includes('\\') || entpackt.includes('\0')) return null
	// Doppelt kodiert: jede Schicht, die noch einmal dekodiert, sähe einen anderen Pfad als diese Prüfung.
	if (/%[0-9a-f]{2}/i.test(entpackt)) return null
	if (entpackt.split('/').includes('..')) return null

	return path.posix.normalize(entpackt)
}

export const brauchtKeineAnmeldung = (pfad: string): boolean =>
	pfad.startsWith(AUTH_PREFIX) ||
	PUBLIC_PATHS.some((prefix) => pfad.startsWith(prefix))
