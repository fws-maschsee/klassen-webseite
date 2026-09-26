import { klassenConfig } from '../klasse/config.ts'

export const publicBaseUrl = (): string =>
	(process.env.PUBLIC_BASE_URL ?? klassenConfig().siteUrl).replace(/\/+$/, '')

export const port = (): number =>
	Number.parseInt(process.env.PORT ?? '4321', 10)
