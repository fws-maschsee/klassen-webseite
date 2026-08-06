import { klassenConfig } from '../../klasse/config.js'
import { instanceName } from '../db/instance.js'

/**
 * Zentrale Absender-/Domainkonfiguration fuer alles, was diese Instanz
 * verschickt. Eine Stelle, damit Rundmails und Mailinglisten garantiert
 * dieselbe verifizierte Domain benutzen.
 *
 * Die schulweiten Vorgaben (verifizierte Absenderadresse, Basis-Domain der
 * Listen) stehen als Vorgabewerte in `src/klasse/config.ts` — sie unterscheiden
 * Schulen, nicht Klassen. Was eine Klasse unterscheidet, kommt aus der
 * `KlassenConfig`.
 */

export const mailFrom = (): string =>
	process.env.MAIL_FROM ?? klassenConfig().mailFrom

export const mailFromName = (): string =>
	process.env.MAIL_FROM_NAME ?? klassenConfig().label

/**
 * Antwortadresse fuer Rundmails. Ohne Konfiguration wird die Versandadresse
 * genommen — bewusst kein geratener Klassen-Mailverteiler.
 */
export const mailReplyTo = (): string => process.env.MAIL_REPLY_TO ?? mailFrom()

/**
 * Vollstaendige Listen-Domain dieser Klasse, also inklusive Klassen-Label:
 * `<slug>.lists.fws-maschsee-test.de`. Eine Liste `eltern` ist damit
 * `eltern@<slug>.lists.fws-maschsee-test.de` — genau die Adresse, fuer die der
 * Worker das Routing hat.
 *
 * Der Klassenteil kommt aus derselben Quelle wie die Instanz-Identitaet, damit
 * beide nicht auseinanderlaufen koennen: ist die Instanz per
 * `MCP_INSTANCE_NAME` umbenannt, folgt die Listenadresse mit. Sonst zeigte sie
 * auf die alte Klasse, waehrend die Datenbank schon zur neuen gehoert.
 */
export const listDomain = (): string => {
	if (process.env.LIST_DOMAIN) return process.env.LIST_DOMAIN
	const config = klassenConfig()
	const name = instanceName()
	return name === config.slug
		? config.listDomain
		: `${name}.${config.listBaseDomain}`
}

/** Envelope-Absender (Return-Path) fuer Listenmails. */
export const listEnvelopeFrom = (): string =>
	process.env.LIST_ENVELOPE_FROM ?? mailFrom()

/** Basis-URL der Website, z.B. fuer Links im Mail-Footer. */
export const siteUrl = (): string =>
	process.env.PUBLIC_BASE_URL ?? klassenConfig().siteUrl

export const className = (): string => klassenConfig().label
