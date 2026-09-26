import { klassenConfig } from '../../klasse/config.ts'
import { instanceName } from '../db/instance.ts'

export const mailFrom = (): string =>
	process.env.MAIL_FROM ?? klassenConfig().mailFrom

export const mailFromName = (): string =>
	process.env.MAIL_FROM_NAME ?? klassenConfig().label

export const mailReplyTo = (): string => process.env.MAIL_REPLY_TO ?? mailFrom()

export const listDomain = (): string => {
	if (process.env.LIST_DOMAIN) return process.env.LIST_DOMAIN
	const config = klassenConfig()
	// Klassenteil aus der Instanz-Identitaet, damit eine Umbenennung per MCP_INSTANCE_NAME mitzieht.
	const name = instanceName()
	return name === config.slug
		? config.listDomain
		: `${name}.${config.listBaseDomain}`
}

export const listEnvelopeFrom = (): string =>
	process.env.LIST_ENVELOPE_FROM ?? mailFrom()

export const siteUrl = (): string =>
	process.env.PUBLIC_BASE_URL ?? klassenConfig().siteUrl

export const className = (): string => klassenConfig().label
