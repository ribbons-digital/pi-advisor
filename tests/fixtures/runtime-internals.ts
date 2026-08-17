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

export function runtimeInternals(runtime: AdvisorRuntime): AdvisorRuntimeTestInternals {
	// SAFETY: tests read the AdvisorRuntime private layout through this named contract.
	return runtime as unknown as AdvisorRuntimeTestInternals;
}
