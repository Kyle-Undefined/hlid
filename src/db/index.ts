// Types

// Attachments
export {
	createAttachment,
	deleteAttachment,
	getAttachment,
	getAttachmentsForSession,
	linkAttachmentToMessage,
	listAttachments,
} from "./attachments";
// Event log
export { appendLog, clearLogs, getLogs } from "./logs";
// Messages & tool events
export {
	appendMessage,
	appendToolEvent,
	getSessionMessages,
	getSessionToolEvents,
	setMessageRecap,
} from "./messages";
// Permissions
export {
	getSessionPermissionEvents,
	recordPermissionEvent,
} from "./permissions";
export type { Db } from "./schema";
// Schema / DB handle
export { getDb } from "./schema";
// Sessions
export {
	createSession,
	deleteSession,
	deleteSessionsOlderThan,
	getRecentSessions,
	getSessionActualModel,
	getSessionAgentCwd,
	getSessionClaudeId,
	getSessionLastQueryContext,
	getSessionsPaginated,
	recordQuery,
	setSessionActualModel,
	setSessionAgentCwd,
	setSessionClaudeId,
} from "./sessions";
// Settings
export {
	clearCurrentSessionId,
	getCurrentSessionId,
	getSetting,
	saveSetting,
	setCurrentSessionId,
} from "./settings";
export type {
	AggStats,
	AggWindow,
	AttachmentKind,
	AttachmentListFilter,
	AttachmentRow,
	LogCounts,
	LogLevel,
	LogRow,
	MessageRow,
	PermissionEventRow,
	QueryData,
	SessionRow,
	ThirtyDayStats,
	ToolEventRow,
	UsageWindow,
	UsageWindows,
	WeeklyStats,
} from "./types";
// Usage / stats
export {
	getAggregatedStats,
	getThirtyDayStats,
	getUsageWindows,
	getWeeklyStats,
} from "./usage";
