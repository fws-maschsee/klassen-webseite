import type { Handelnde } from '../../lib/db/mitbringen.ts'
import { verifyRequest } from '../../server/auth/index.ts'
import { may } from '../../server/auth/roles.ts'

/**
 * Wer da ist, wenn jemand eine Mitbringliste aufruft — OHNE Anmeldezwang.
 *
 * Die Seite liegt unter `/public/`, die Middleware laesst sie ohne Sitzung
 * durch. Trotzdem soll, wer angemeldet IST, seinen Namen vorausgefuellt sehen
 * und seine eigenen Eintraege spaeter aendern koennen. Deshalb wird die Sitzung
 * hier freiwillig geprueft: gibt es eine gueltige, kommt die Person zurueck;
 * gibt es keine oder gehoert sie nicht zur Klasse, ist es eben ein Gast. Es
 * gibt keine Umleitung zur Anmeldung — die Liste ist fuer Gaeste da.
 */
export type Besucher = {
	sub: string | null
	name: string | null
	admin: boolean
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
		// Anmeldung nicht konfiguriert oder ZITADEL nicht erreichbar: dann ist
		// die Person ein Gast. Eine Mitbringliste darf daran nicht scheitern.
		return { sub: null, name: null, admin: false }
	}
}

/**
 * Welcher Name auf einem Eintrag steht.
 *
 * Wer angemeldet ist, traegt unter seinem KONTONAMEN ein — das Feld ist auf
 * der Seite nicht aenderbar, und hier wird es auch nicht aus dem Formular
 * gelesen, sonst waere die Sperre auf der Seite nur Dekoration. Beim Aendern
 * gilt das nur fuer den eigenen Eintrag: Ein admin, der den Eintrag einer
 * anderen Familie korrigiert, ueberschreibt deren Namen nicht mit seinem.
 * Gaeste tippen ihren Namen selbst.
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
