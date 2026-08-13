import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { instanceLabel, instanceName } from '../../lib/db/instance.ts'
import type { McpAuth } from './guard.ts'
import { registerEmailTools } from './tools/emails.ts'
import { registerGroupTools } from './tools/groups.ts'
import { registerInstanceTools } from './tools/instance.ts'
import { registerListQueueTools } from './tools/listQueue.ts'
import { registerMailingListTools } from './tools/mailingLists.ts'
import { registerMitgliederTools } from './tools/members.ts'
import { registerRecipientSettingsTools } from './tools/recipientSettings.ts'

/**
 * Baut den MCP-Server. Name und Titel kommen aus `MCP_INSTANCE_NAME` bzw.
 * `MCP_INSTANCE_LABEL` — nur so sind die Klassen-Instanzen im Client
 * ueberhaupt auseinanderzuhalten. Wer sich nicht sicher ist, ruft
 * `get_instance_info` auf.
 *
 * `auth` traegt die Rollen des Aufrufers durch bis zu den Tools. Der Server
 * wird pro Request neu gebaut (siehe `handler.ts`), deshalb gehoert er genau
 * einem Bearer-Token — es gibt keinen Zustand, den ein zweiter Aufrufer erben
 * koennte.
 */
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

	return server
}
