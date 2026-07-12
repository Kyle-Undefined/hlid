// Types

export type {
	HourOfDayBucket,
	LatencyDistribution,
	ModelSplitEntry,
	StopReasonEntry,
	ToolErrorEntry,
	TopToolCall,
} from "./activity";
// Activity (charts aggregations)
export {
	getHourOfDayActivity,
	getLatencyDistribution,
	getModelSplit,
	getStopReasonSplit,
	getToolErrors,
	getTopToolCalls,
} from "./activity";
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
export type { StorageStats } from "./maintenance";
export { getStorageStats, optimizeStorage } from "./maintenance";
// Messages & tool events
export {
	appendAskUserQuestion,
	appendMessage,
	appendPlanProposal,
	appendToolEvent,
	getSessionAskUserQuestions,
	getSessionMessages,
	getSessionPlanProposals,
	getSessionToolEvents,
	setAskUserQuestionResolution,
	setMessageRecap,
	setMessageText,
	setPlanProposalDecision,
	setToolEventResult,
	setToolEventSubagent,
} from "./messages";
// Permissions
export {
	getSessionPermissionEvents,
	recordPermissionEvent,
} from "./permissions";
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
	getSessionById,
	getSessionClaudeId,
	getSessionLastQueryContext,
	getSessionProviderId,
	getSessionProviderSession,
	getSessionsPaginated,
	recordQuery,
	renameSession,
	setSessionActualModel,
	setSessionAgentCwd,
	setSessionProviderId,
	setSessionProviderSession,
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
	AttachmentRow,
	LogCounts,
	LogLevel,
	LogRow,
	MessageRow,
	PermissionEventRow,
	ProviderUsageSnapshot,
	ProviderWindowEntry,
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
	getProviderUsage,
	getThirtyDayStats,
	getUsageWindows,
	getWeeklyStats,
	registerProvider,
} from "./usage";
