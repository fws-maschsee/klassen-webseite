import { describe, expect, test } from 'vitest'
import {
	GENERIC_ROLES_CLAIM,
	hasRolesClaim,
	projectAudienceScope,
	projectRolesClaim,
	rolesFromClaims,
} from '../../src/server/auth/tokenRoles.ts'

describe('Rollen aus dem Token', () => {
	const claims = {
		[projectRolesClaim('proj-1')]: {
			mitglied: { 'org-1': 'schule.example.org' },
			admin: { 'org-anders': 'fremd.example.org' },
		},
		[projectRolesClaim('proj-2')]: { admin: { 'org-1': 'x' } },
		[GENERIC_ROLES_CLAIM]: { admin: { 'org-1': 'x' } },
	}

	test('zaehlt nur die Rollen des eigenen Projekts', () => {
		expect(rolesFromClaims(claims, { projectId: 'proj-1' })).toEqual([
			'mitglied',
			'admin',
		])
	})

	test('mit Organisation zaehlen nur die Rollen, die dort vergeben sind', () => {
		expect(
			rolesFromClaims(claims, { projectId: 'proj-1', orgId: 'org-1' }),
		).toEqual(['mitglied'])
	})

	test('ein fremdes Projekt verleiht hier nichts', () => {
		expect(rolesFromClaims(claims, { projectId: 'proj-3' })).toEqual([])
		expect(hasRolesClaim(claims, { projectId: 'proj-3' })).toBe(false)
	})

	test('ohne Projekt-ID gilt der allgemeine Claim', () => {
		expect(rolesFromClaims(claims, {})).toEqual(['admin'])
	})

	test('Unsinn im Claim ergibt keine Rollen', () => {
		expect(
			rolesFromClaims(
				{ [projectRolesClaim('p')]: ['admin'] },
				{ projectId: 'p' },
			),
		).toEqual([])
		expect(
			rolesFromClaims(
				{ [projectRolesClaim('p')]: 'admin' },
				{ projectId: 'p' },
			),
		).toEqual([])
	})

	test('der Scope holt die Rollen des Projekts ins Token', () => {
		expect(projectAudienceScope('proj-1')).toBe(
			'urn:zitadel:iam:org:project:id:proj-1:aud',
		)
	})
})
