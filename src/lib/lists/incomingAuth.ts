import { klassenConfig } from '../../klasse/config.ts'
import { instanceName } from '../db/instance.ts'
import { verifyListRequest } from './signatureEd25519.ts'

export type AuthenticatedListRequest = {
	class: string
	list: string
	envelopeFrom: string
	messageId: string | null
	recipient: string | null
	timestamp: string
}

export type ListAuthResult =
	| { ok: true; request: AuthenticatedListRequest }
	| {
			ok: false
			status: 400 | 401 | 404
			reason: string
			anAbsender: boolean
	  }

export type ListAuthOptions = {
	headers: { get(name: string): string | null | undefined }
	rawBody: Buffer
	expectedClass?: string
	now?: Date
}

export const authenticateListRequest = ({
	headers,
	rawBody,
	expectedClass = instanceName(),
	now,
}: ListAuthOptions): ListAuthResult => {
	const config = klassenConfig()
	const verified = verifyListRequest({
		headers,
		rawBody,
		publicKeyPem: config.listPublicKeyPem,
		expectedClass,
		keyIds: config.listKeyIds,
		now,
	})
	if (!verified.ok) {
		return {
			ok: false,
			status: verified.status,
			reason: verified.reason,
			anAbsender: false,
		}
	}

	return {
		ok: true,
		request: {
			class: verified.fields.class,
			list: verified.fields.list,
			envelopeFrom: verified.fields.envelopeFrom,
			messageId: verified.fields.messageId,
			recipient: verified.fields.recipient,
			timestamp: verified.fields.timestamp,
		},
	}
}
