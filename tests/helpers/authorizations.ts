export const AUTHORIZATIONS_PATH =
	'/zitadel.authorization.v2.AuthorizationService/ListAuthorizations'

export type GrantFixture = {
	userId: string
	email?: string
	roleKeys: string[]
	state?: 'STATE_ACTIVE' | 'STATE_INACTIVE'
	projectId?: string
}

export const authorizationsBody = (
	grants: readonly GrantFixture[],
	projectId = 'proj-1',
) => ({
	pagination: { totalResult: String(grants.length), appliedLimit: '200' },
	authorizations: grants.map((g, i) => ({
		id: `auth-${i}`,
		project: {
			id: g.projectId ?? projectId,
			name: 'Klasse',
			organizationId: 'org-1',
		},
		organization: { id: 'org-1', name: 'Schule' },
		state: g.state ?? 'STATE_ACTIVE',
		roles: g.roleKeys.map((key) => ({ key, displayName: key })),
		user: {
			id: g.userId,
			preferredLoginName: g.email ?? `name-${g.userId}`,
			displayName: g.userId,
			organizationId: 'org-1',
		},
	})),
})

export const authorizationsResponse = (
	grants: readonly GrantFixture[],
	projectId = 'proj-1',
): Response =>
	new Response(JSON.stringify(authorizationsBody(grants, projectId)), {
		status: 200,
	})
