import { siteUrl } from '../email/config.ts'

export const einstellungenUrl = (): string =>
	new URL('/einstellungen', siteUrl()).toString()

export const abmeldeUrl = (token: string, listAddress: string): string => {
	const url = new URL(`/public/abmelden/${token}`, siteUrl())
	url.searchParams.set('liste', listAddress)
	return url.toString()
}
