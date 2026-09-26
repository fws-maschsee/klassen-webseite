import { siteUrl } from '../email/config.ts'

export const einstellungenUrl = (): string =>
	new URL('/einstellungen', siteUrl()).toString()

export const abmeldeUrl = (token: string, listAddress: string): string => {
	// Token im Pfad statt in der Query: Query-Parameter landen eher in Verlaeufen und Proxy-Logs.
	const url = new URL(`/public/abmelden/${token}`, siteUrl())
	url.searchParams.set('liste', listAddress)
	return url.toString()
}
