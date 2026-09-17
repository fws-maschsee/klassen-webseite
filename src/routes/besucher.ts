import { verifyRequest } from '../server/auth/index.ts'
import { may } from '../server/auth/roles.ts'

/**
 * Wer da ist, wenn jemand eine Seite unter `/public/` aufruft — ohne
 * Anmeldezwang. Gibt es eine gueltige Sitzung, kommt die Person zurueck;
 * sonst ist es ein Gast. Umgeleitet wird nie: Diese Seiten sind fuer Gaeste da.
 */
export type Besucher = {
	sub: string | null
	name: string | null
	admin: boolean
}

/** Wer gerade handelt — Sitzung plus Bearbeitungsschluessel aus dem Formular. */
export type Handelnde = {
	sub?: string | null
	editToken?: string | null
	admin?: boolean
}

export const besucherLesen = async (request: Request): Promise<Besucher> => {
	try {
		const ergebnis = await verifyRequest(request)
		if (!ergebnis.ok) return { sub: null, name: null, admin: false }
		return {
			sub: ergebnis.user.id,
			name: ergebnis.user.name ?? null,
			admin: may(ergebnis.user.roles, 'bearbeiten'),
		}
	} catch {
		// Anmeldung nicht konfiguriert oder ZITADEL nicht erreichbar: dann ist die
		// Person ein Gast. Eine offene Liste darf daran nicht scheitern.
		return { sub: null, name: null, admin: false }
	}
}

/**
 * Welcher Name auf einem Eintrag steht: Angemeldete tragen unter ihrem
 * Kontonamen ein, sonst waere die Sperre auf der Seite Dekoration. Beim Ändern
 * gilt das nur fuer den eigenen Eintrag — ein admin, der fremde korrigiert,
 * ueberschreibt deren Namen nicht mit seinem. Gaeste tippen selbst.
 */
export const nameFuer = (
	besucher: Besucher,
	ausFormular: string | null,
	eintragOwner: string | null | undefined,
): string | undefined => {
	const eigener = besucher.sub && besucher.name
	if (
		eigener &&
		(eintragOwner === undefined || eintragOwner === besucher.sub)
	) {
		return besucher.name ?? undefined
	}
	return ausFormular ?? undefined
}

export const handelnde = (
	besucher: Besucher,
	editToken: string | null,
): Handelnde => ({
	sub: besucher.sub,
	admin: besucher.admin,
	editToken,
})
