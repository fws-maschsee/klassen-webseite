export const GENERIC_ROLES_CLAIM = 'urn:zitadel:iam:org:project:roles'

export const projectRolesClaim = (projectId: string): string =>
	`urn:zitadel:iam:org:project:${projectId}:roles`

export const PROJECTS_ROLES_SCOPE = 'urn:zitadel:iam:org:projects:roles'

export const projectAudienceScope = (projectId: string): string =>
	`urn:zitadel:iam:org:project:id:${projectId}:aud`

export type RoleScope = {
	projectId?: string
	orgId?: string
}

const claimName = (scope: RoleScope): string =>
	scope.projectId ? projectRolesClaim(scope.projectId) : GENERIC_ROLES_CLAIM

export const hasRolesClaim = (
	claims: Record<string, unknown>,
	scope: RoleScope,
): boolean => claimName(scope) in claims

export const rolesFromClaims = (
	claims: Record<string, unknown>,
	scope: RoleScope,
): string[] => {
	const raw = claims[claimName(scope)]
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
	return Object.entries(raw as Record<string, unknown>)
		.filter(([, orgs]) => {
			if (!scope.orgId) return true
			return (
				typeof orgs === 'object' &&
				orgs !== null &&
				Object.hasOwn(orgs, scope.orgId)
			)
		})
		.map(([role]) => role)
}
