import type { Email } from '../../../src/lib/emails/types.ts'

const email: Email = {
	subject: 'Vorlage',
	recipients: { kind: 'group', value: 'eltern' },
	template: { heading: 'Vorlage', blocks: [] },
}

export default email
