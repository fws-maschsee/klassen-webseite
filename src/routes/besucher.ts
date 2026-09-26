import { verifyRequest } from '../server/auth/index.ts'
import { may } from '../server/auth/roles.ts'

export type Besucher = {
	sub: string | null
	name: string | null
	admin: boolean
}

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
		// Anmeldung nicht konfiguriert oder ZITADEL weg: dann Gast – eine offene Liste darf daran nicht scheitern.
		return { sub: null, name: null, admin: false }
	}
}

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
