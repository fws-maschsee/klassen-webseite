import type { MitgliedRow } from '../db/types.ts'

export const personalizedAnrede = (mitglied: MitgliedRow): string =>
	`Hallo ${mitglied.first_name},`
