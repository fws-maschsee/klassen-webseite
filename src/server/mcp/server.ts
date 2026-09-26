import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { instanceLabel, instanceName } from '../../lib/db/instance.ts'
import type { McpAuth } from './guard.ts'
import { registerAccountTools } from './tools/accounts.ts'
import { registerEmailTools } from './tools/emails.ts'
import { registerGroupTools } from './tools/groups.ts'
import { registerInstanceTools } from './tools/instance.ts'
import { registerListQueueTools } from './tools/listQueue.ts'
import { registerMailingListTools } from './tools/mailingLists.ts'
import { registerMitgliederTools } from './tools/members.ts'
import { registerMitbringTools } from './tools/mitbringen.ts'
import { registerPutzplanTools } from './tools/putzplan.ts'
import { registerRecipientSettingsTools } from './tools/recipientSettings.ts'
import { registerSchichtTools } from './tools/schichten.ts'

export const buildMcpServer = (auth: McpAuth): McpServer => {
	const server = new McpServer({
		name: instanceName(),
		version: '0.1.0',
		title: instanceLabel(),
	})

	registerInstanceTools(server, auth)
	registerMitgliederTools(server, auth)
	registerGroupTools(server, auth)
	registerEmailTools(server, auth)
	registerMailingListTools(server, auth)
	registerListQueueTools(server, auth)
	registerRecipientSettingsTools(server, auth)
	registerPutzplanTools(server, auth)
	registerMitbringTools(server, auth)
	registerSchichtTools(server, auth)
	registerAccountTools(server, auth)

	return server
}
