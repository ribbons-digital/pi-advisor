import { createHash } from "node:crypto";
import { ADVISOR_RUNTIME_STATE_ENTRY_TYPE } from "../../src/index.js";
import { isRecordValue } from "../../src/value-guards.js";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
	AcceptedAdvice,
	AdviceCollector,
	AdviceDelivery,
	AdviceDedupeTag,
	AdvisorConfig,
	AdvisorCursor,
	AdvisorGovernorOutcome,
	AdvisorRuntime,
	AdvisorRuntimeStatus,
	AdvisorUsageTotals,
	BoundedAdviceDedupe,
	BoundedKeyedByteFifo,
	PersistedAdvisorActiveReview,
	PersistedAdvisorRuntimeState,
	PersistedAdvisorToolAttempt,
	RecentFindingsIndex,
} from "../../src/index.js";

export interface CurrentRun {
	epoch: number;
	reviewId: string;
	reviewOrdinal: { next: number };
	turns: number;
	toolCalls: number;
	deferAdvice: boolean;
	governorFailure?: AdvisorGovernorOutcome;
	providerFailure?: string;
	providerOverflow: boolean;
	toolFailure?: string;
	adviseToolCalls: number;
	adviseExecutionStartedCallIds: Set<string>;
	abortedForSupersession?: boolean;
	usage: AdvisorUsageTotals;
	stopReason: string;
	transcriptRecords: PersistedAdvisorToolAttempt[];
}

export interface PendingAdvice {
	advice: AcceptedAdvice;
	stale: boolean;
	branchWindow: AdvisorCursor;
	displayedInEntry: boolean;
	restoredAfterResume?: boolean;
	reviewId?: string;
	tag?: AdviceDedupeTag;
}

export interface QueuedAdvisorUpdate {
	text: string;
	entryCount: number;
	truncated: boolean;
	window: AdvisorCursor;
	turnNumber: number;
	successfulMemoryTexts: Set<string>;
	reviewId?: string;
	restoredReplayCount?: number;
	restoredQueued?: boolean;
	heldForMaterialTurn?: boolean;
}

export interface OutstandingAdvice extends PendingAdvice {
	identity: string;
	deliveryId: string;
	reviewId: string;
	turnNumber: number;
	epoch: number;
}

export interface AdvisorRuntimeTestInternals {
	config: AdvisorConfig;
	session?: AgentSession;
	hostContext?: ExtensionContext;
	pendingUpdate?: QueuedAdvisorUpdate;
	throttledUpdate?: QueuedAdvisorUpdate;
	activeReview?: PersistedAdvisorActiveReview;
	cadenceTimer?: ReturnType<typeof setTimeout>;
	lastReviewSubmittedTurn?: number;
	draining: boolean;
	currentRun?: CurrentRun;
	pendingAdvice: BoundedKeyedByteFifo<PendingAdvice>;
	activeAdvice: BoundedKeyedByteFifo<OutstandingAdvice>;
	automaticReviewFollowUpDeliveryId?: string;
	adviceDedupe: BoundedAdviceDedupe;
	recentFindings: RecentFindingsIndex;
	collector: AdviceCollector;
	status: AdvisorRuntimeStatus;
	readonly pi: ExtensionAPI;
	persistState(): void;
	coalescePending(
		current: QueuedAdvisorUpdate | undefined,
		incoming: QueuedAdvisorUpdate,
	): QueuedAdvisorUpdate;
	deliver(
		advice: AcceptedAdvice,
		ctx: ExtensionContext,
		stale: boolean,
		newerInstructionInput: boolean,
		forceDeferred: boolean,
		turnNumber: number,
		reviewId: string,
	): AdviceDelivery | undefined;
	updateBacklogStatus(): void;
}

/** Bind a hand-built recovery fixture to the exact prompt of the test session. */
export function bindFixtureInstructions(session: AgentSession): void {
	const entry = [...session.sessionManager.getBranch()]
		.reverse()
		.find(
			(candidate) =>
				candidate.type === "custom" && candidate.customType === ADVISOR_RUNTIME_STATE_ENTRY_TYPE,
		);
	if (entry?.type !== "custom" || !isRecordValue<PersistedAdvisorRuntimeState>(entry.data))
		throw new Error("Expected hand-built recovery state");
	session.sessionManager.appendCustomEntry(ADVISOR_RUNTIME_STATE_ENTRY_TYPE, {
		...entry.data,
		effectiveSystemPromptHash: createHash("sha256").update(session.systemPrompt).digest("hex"),
	});
}

export function runtimeInternals(runtime: AdvisorRuntime): AdvisorRuntimeTestInternals;
export function runtimeInternals(
	runtime: AdvisorRuntime | AdvisorRuntimeTestInternals,
): AdvisorRuntime | AdvisorRuntimeTestInternals {
	return runtime;
}
