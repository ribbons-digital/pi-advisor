import { describe, expect, it } from "vitest";

import {
	compressAdvisorHistory,
	HISTORY_SUMMARY_TAG,
	type AdvisorHistoryMessage,
} from "../../src/index.js";
import {
	compressNestedMessages,
	NESTED_SLIM_TOOL_RESULT_HEAD_LINES,
	NESTED_SLIM_TRUNCATION_MARKER,
} from "../../src/history-compaction.js";
import { isStringValue } from "../../src/value-guards.js";

interface AdviseOutcomeFixture {
	adviceBlocked: boolean;
	findingKey: string;
	severity: string;
	note: string;
	outcome: { advised: boolean };
}

function userUpdate(text: string): AdvisorHistoryMessage {
	return { role: "user", content: `<advisor-update>\n${text}\n</advisor-update>` };
}
function adviseToolResult(outcome: AdviseOutcomeFixture): AdvisorHistoryMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text: JSON.stringify(outcome) }],
	};
}

const silentOutcome = {
	adviceBlocked: false,
	findingKey: "",
	severity: "none",
	note: "",
	outcome: { advised: false },
};
const advisedOutcome = {
	adviceBlocked: false,
	findingKey: "auth-race",
	severity: "blocker",
	note: "race condition in session cache guard",
	outcome: { advised: true },
};

function isString(value: Parameters<typeof isStringValue>[0]): string {
	return isStringValue(value) ? value : "";
}

describe("compressAdvisorHistory", () => {
	it("returns history unchanged when cycles are within the keep window", () => {
		const messages = [userUpdate("first"), adviseToolResult(silentOutcome), userUpdate("second")];
		const result = compressAdvisorHistory(messages, { keepRecentCycles: 2 });
		expect(result.compressedCycles).toBe(0);
		expect(result.messages).toEqual(messages);
	});

	it("defaults to keeping only the newest cycle verbatim (production contract)", () => {
		// The runtime calls compressAdvisorHistory WITHOUT options; this pins
		// DEFAULT_KEEP_RECENT_CYCLES = 1 so a silent revert (e.g. back to 2)
		// cannot slip through the suite — no config surface anchors it anymore.
		const messages = [
			userUpdate("cycle 1"),
			adviseToolResult(silentOutcome),
			userUpdate("cycle 2"),
			adviseToolResult(silentOutcome),
			userUpdate("cycle 3"),
			adviseToolResult(silentOutcome),
			userUpdate("cycle 4"),
			adviseToolResult(silentOutcome),
		];
		const result = compressAdvisorHistory(messages);
		expect(result.compressedCycles).toBe(3);
		expect(result.keptCycles).toBe(1);
	});

	it("compresses old cycles into a summary block and keeps recent cycles verbatim", () => {
		const messages = [
			userUpdate("[Executor user]\nfix the login bug\n[Executor assistant]\ndone"),
			adviseToolResult(advisedOutcome),
			userUpdate("[Executor user]\nsecond instruction"),
			adviseToolResult(silentOutcome),
			userUpdate("[Executor user]\nthird instruction"),
			adviseToolResult(silentOutcome),
			userUpdate("[Executor user]\nfourth instruction"),
		];
		const result = compressAdvisorHistory(messages, { keepRecentCycles: 2 });
		expect(result.compressedCycles).toBe(2);
		expect(result.keptCycles).toBe(2);
		// summary block replaces the first two cycles; kept tail = [u3, tr3, u4]
		expect(result.messages).toHaveLength(4);
		expect(result.messages[0]?.role).toBe("user");
		const summary = isString(result.messages[0]?.content);
		expect(summary).toContain(`<${HISTORY_SUMMARY_TAG}`);
		expect(summary).toContain('user "fix the login bug"');
		expect(summary).toContain("findingKey=auth-race");
		expect(summary).toContain('note: "race condition in session cache guard"');
		// recent cycles survive verbatim (original wrapped content preserved)
		expect(result.messages.slice(1).map((m: AdvisorHistoryMessage) => m.content)).toEqual([
			"<advisor-update>\n[Executor user]\nthird instruction\n</advisor-update>",
			[{ type: "text", text: JSON.stringify(silentOutcome) }],
			"<advisor-update>\n[Executor user]\nfourth instruction\n</advisor-update>",
		]);
	});

	it("carries unresolved error-register lines and breadcrumbs into the summary", () => {
		const updateText = [
			"[Executor tool result bash error]",
			"npm ERR! audit_events deleted",
			"Dropped beyond window: 9 older entries; files: src/a.ts",
		].join("\n");
		const messages = [
			userUpdate(
				`[Advisor signal register]\n- [ERROR] tool bash: npm ERR! audit_events deleted — unresolved\n\n${updateText}`,
			),
			adviseToolResult(silentOutcome),
			userUpdate("b"),
			adviseToolResult(silentOutcome),
			userUpdate("c"),
		];
		const result = compressAdvisorHistory(messages, { keepRecentCycles: 1 });
		const summary = isString(result.messages[0]?.content);
		expect(summary).toContain("- [ERROR] tool bash: npm ERR! audit_events deleted");
		expect(summary).toContain("Dropped beyond window: 9 older entries");
	});

	it("is deterministic: identical input compresses to an identical block", () => {
		const build = () => [
			userUpdate("[Executor user]\nalpha"),
			adviseToolResult(advisedOutcome),
			userUpdate("[Executor user]\nbeta"),
			adviseToolResult(silentOutcome),
			userUpdate("[Executor user]\ngamma"),
		];
		const a = compressAdvisorHistory(build(), { keepRecentCycles: 1 });
		const b = compressAdvisorHistory(build(), { keepRecentCycles: 1 });
		expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages));
	});

	it("is idempotent: re-compressing a compressed history preserves every findingKey", () => {
		const messages = [
			userUpdate("[Executor user]\nfix login"),
			adviseToolResult(advisedOutcome),
			userUpdate("second"),
			adviseToolResult(silentOutcome),
			userUpdate("third"),
		];
		const first = compressAdvisorHistory(messages, { keepRecentCycles: 1 });
		const second = compressAdvisorHistory(first.messages, { keepRecentCycles: 1 });
		// the carried summary block keeps the original findingKey/notes verbatim
		const allContent = second.messages
			.map((m: AdvisorHistoryMessage) => isString(m.content))
			.join("\n");
		expect(allContent).toContain("findingKey=auth-race");
		expect(allContent).toContain("auth-race");
		expect(second.compressedCycles).toBe(2);
	});

	it("keeps unrepresented cycles verbatim when the byte cap saturates (no findingKey lost)", () => {
		const messages: AdvisorHistoryMessage[] = [];
		const keys: string[] = [];
		for (let i = 0; i < 14; i++) {
			const key = `finding-key-${String(i)}`;
			keys.push(key);
			const longError = `- [ERROR] tool bash: ${"e".repeat(300)} error-${String(i)}`;
			messages.push(
				userUpdate(
					`[Advisor signal register]\n${longError}\n\n[Executor user]\ninstruction ${String(i)}`,
				),
				adviseToolResult({ ...advisedOutcome, findingKey: key }),
			);
		}
		messages.push(userUpdate("final"));
		const result = compressAdvisorHistory(messages, { keepRecentCycles: 1 });
		const summary = isString(result.messages[0]?.content);
		// every findingKey survives: either in the summary block or verbatim in the kept region
		const keptContent = result.messages
			.slice(1)
			.map((m: AdvisorHistoryMessage) =>
				isStringValue(m.content) ? m.content : JSON.stringify(m.content),
			)
			.join("\n");
		for (const key of keys) {
			expect(summary.includes(key) || keptContent.includes(key)).toBe(true);
		}
		// no update silently dropped: 14 instruction cycles + 1 final = 15 updates,
		// each either represented in the summary or kept verbatim
		expect(result.compressedCycles + result.keptCycles).toBe(15);
		// cap bound: the newest unrepresented cycle stays verbatim, not in the summary
		expect(summary.includes("finding-key-13")).toBe(false);
		expect(keptContent.includes("finding-key-13")).toBe(true);
		expect(summary.length).toBeLessThanOrEqual(4_200);
	});

	it("attaches non-update user injections to the current cycle (no orphaned tool results)", () => {
		const messages = [
			userUpdate("one"),
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "c0", name: "advise", arguments: {} }],
			},
			{ role: "user", content: "steer: focus on auth" },
			adviseToolResult(silentOutcome),
			userUpdate("two"),
		];
		const result = compressAdvisorHistory(messages, { keepRecentCycles: 1 });
		// one cycle (update + advise pair + mid-pair injection) compressed into a
		// single summary line; the next update stays verbatim
		expect(result.compressedCycles).toBe(1);
		expect(result.messages).toHaveLength(2);
		const summary = isString(result.messages[0]?.content);
		expect(summary).not.toContain("steer: focus on auth");
	});

	it("keeps all compressed cycles represented when lines fit under the byte cap", () => {
		const messages: AdvisorHistoryMessage[] = [];
		for (let i = 0; i < 12; i++) {
			messages.push(userUpdate(`[Executor user]\n${"x".repeat(300)} cycle ${String(i)}`));
			messages.push(adviseToolResult(silentOutcome));
		}
		messages.push(userUpdate("final"));
		const result = compressAdvisorHistory(messages, { keepRecentCycles: 1 });
		const summary = isString(result.messages[0]?.content);
		expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(4_200);
		expect(result.compressedCycles).toBe(12);
		expect(result.messages).toHaveLength(2);
	});

	it("keeps the summary block header byte-stable across re-compressions (prefix-cache friendly)", () => {
		// Regression: the growing `updates="1..N"` header counter broke the
		// prefix-cache hit on the whole previous summary block after each rewrite
		// (consecutive blocks shared only ~62 bytes). The header must stay
		// constant and the covered range must derive from the carried [#N] rows,
		// so re-compressing appends new rows to a byte-identical prefix.
		const messages: AdvisorHistoryMessage[] = [];
		for (let i = 0; i < 4; i++) {
			messages.push(userUpdate(`[Executor user]\ncycle ${String(i)}`));
			messages.push(adviseToolResult(silentOutcome));
		}
		messages.push(userUpdate("final"));
		const first = compressAdvisorHistory(messages, { keepRecentCycles: 1 });
		const firstSummary = isString(first.messages[0]?.content);
		expect(firstSummary).toContain(HISTORY_SUMMARY_TAG);
		expect(firstSummary).not.toMatch(/updates="1\.\./);
		// Continue the session: two more cycles, then compress again.
		const continued: AdvisorHistoryMessage[] = [
			...first.messages,
			userUpdate(`[Executor user]\ncycle ${String(4)}`),
			adviseToolResult(silentOutcome),
			userUpdate(`[Executor user]\ncycle ${String(5)}`),
			adviseToolResult(silentOutcome),
			userUpdate("final2"),
		];
		const second = compressAdvisorHistory(continued, { keepRecentCycles: 1 });
		const secondSummary = isString(second.messages[0]?.content);
		// Every row of the first block must be carried verbatim at the SAME
		// leading position — the second block's prefix equals the first block's
		// carried rows (its only divergence is the appended new rows + close tag).
		const firstRows = firstSummary.split("\n").filter((line) => line.startsWith("[#"));
		expect(firstRows.length).toBeGreaterThan(0);
		expect(secondSummary.startsWith(`<${HISTORY_SUMMARY_TAG} compressed="algorithmic">`)).toBe(
			true,
		);
		for (const row of firstRows) {
			expect(secondSummary).toContain(`${row}\n`);
		}
		// covered-range still correct after the stable-header change: the carried
		// summary represents updates 1..4 plus the three new cycles (final, cycle4,
		// cycle5) = 7 rows, newest kept verbatim.
		expect(second.compressedCycles).toBe(7);
		expect(second.keptCycles).toBe(1);
	});
});

describe("compressNestedMessages", () => {
	function assistantWithThinking(text: string, thinking: string): AdvisorHistoryMessage {
		// SAFETY: a synthetic assistant fixture message; its content/usage shape
		// matches the advisor history message contract under test.
		return {
			role: "assistant",
			content: [
				{ type: "thinking", thinking },
				{ type: "text", text },
			],
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			},
		} as AdvisorHistoryMessage;
	}

	function bigToolResult(text: string): AdvisorHistoryMessage {
		return { role: "toolResult", content: [{ type: "text", text }] };
	}

	it("strips thinking from older assistant messages but keeps text verbatim", () => {
		// > NESTED_SLIM_KEEP_RECENT_MESSAGES so the old assistant falls in the
		// slimmed head rather than the verbatim keep-window tail.
		const messages = [
			assistantWithThinking("keep me", "secret reasoning ".repeat(200)),
			{ role: "user", content: "filler 1" },
			{ role: "toolResult", content: [{ type: "text", text: "filler 2" }] },
			{ role: "user", content: "filler 3" },
			{ role: "user", content: "recent" },
		];
		const result = compressNestedMessages(messages);
		expect(result.degraded).toBeGreaterThan(0);
		const [first] = result.messages;
		// SAFETY: the fixture assistant message content is a text/thinking block
		// array; after slimming, only the text block survives.
		const content = first?.content as { type: string; text: string }[];
		expect(content.some((part) => part.type === "thinking")).toBe(false);
		expect(content.find((part) => part.type === "text")?.text).toBe("keep me");
	});

	it("keeps the newest few messages verbatim", () => {
		const messages = [
			assistantWithThinking("old-1", "t".repeat(500)),
			assistantWithThinking("old-2", "t".repeat(500)),
			assistantWithThinking("recent-1", "t".repeat(500)),
			{ role: "user", content: "latest" },
		];
		const result = compressNestedMessages(messages);
		// all four lie within the keep-window tail, so nothing is touched
		expect(result.degraded).toBe(0);
		expect(result.messages).toEqual(messages);
	});

	it("caps oversized older toolResults to their head", () => {
		const huge = "line\n".repeat(5_000);
		const messages = [
			bigToolResult(huge),
			{ role: "user", content: "filler 1" },
			{ role: "toolResult", content: [{ type: "text", text: "filler 2" }] },
			{ role: "user", content: "filler 3" },
			{ role: "user", content: "recent" },
		];
		const result = compressNestedMessages(messages);
		expect(result.degraded).toBe(1);
		const [first] = result.messages;
		// SAFETY: the fixture toolResult content is a single text block array,
		// and slimming preserves that shape (trimmed to one text block).
		const parts = first?.content as { type: string; text: string }[] | undefined;
		const text = parts?.[0]?.text ?? "";
		expect(text).toContain(NESTED_SLIM_TRUNCATION_MARKER);
		expect(Buffer.byteLength(text, "utf8")).toBeLessThan(5_000 * 5);
		// still starts with the original content
		expect(text.startsWith("line\n")).toBe(true);
	});

	it("byte-caps an oversized toolResult that has fewer lines than the line cap", () => {
		// Regression: the line-cap scan used to overwrite the last good newline
		// position with -1 when the body ran out of newlines before the cap, so
		// a result with <NESTED_SLIM_TOOL_RESULT_HEAD_LINES newlines but more
		// bytes than the budget (long lines) was never trimmed at all and
		// overflow fell through to the nuclear full clear. The byte cap must
		// bind whenever the body exceeds NESTED_SLIM_TOOL_RESULT_HEAD_BYTES.
		const longLines = Array.from(
			{ length: 5 },
			() => "A".repeat(1_500), // 5 lines x 1.5KB = 7.5KB > 4KiB, but only 4 newlines
		).join("\n");
		const messages = [
			bigToolResult(longLines),
			{ role: "user", content: "filler 1" },
			{ role: "user", content: "filler 2" },
			{ role: "user", content: "filler 3" },
			{ role: "user", content: "recent" },
		];
		const result = compressNestedMessages(messages);
		expect(result.degraded).toBe(1);
		const [first] = result.messages;
		// SAFETY: the fixture toolResult content is a single text block array,
		// and slimming preserves that shape (trimmed to one text block).
		const parts = first?.content as { type: string; text: string }[] | undefined;
		const text = parts?.[0]?.text ?? "";
		expect(text).toContain(NESTED_SLIM_TRUNCATION_MARKER);
		// bounded to the byte budget (not left at the original 7.5KB)
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
			4 * 1_024 + Buffer.byteLength(NESTED_SLIM_TRUNCATION_MARKER, "utf8"),
		);
		expect(Buffer.byteLength(text, "utf8")).toBeLessThan(7_500);
		// kept head is a contiguous prefix of the original
		expect(text.startsWith("A".repeat(100))).toBe(true);
	});

	it("byte-caps a single no-newline oversized toolResult (JSON dump shape)", () => {
		const singleLine = "x".repeat(9_000);
		const messages = [
			bigToolResult(singleLine),
			{ role: "user", content: "filler 1" },
			{ role: "user", content: "filler 2" },
			{ role: "user", content: "filler 3" },
			{ role: "user", content: "recent" },
		];
		const result = compressNestedMessages(messages);
		expect(result.degraded).toBe(1);
		const [first] = result.messages;
		// SAFETY: the fixture toolResult content is a single text block array,
		// and slimming preserves that shape (trimmed to one text block).
		const parts = first?.content as { type: string; text: string }[] | undefined;
		const text = parts?.[0]?.text ?? "";
		expect(text).toContain(NESTED_SLIM_TRUNCATION_MARKER);
		expect(Buffer.byteLength(text, "utf8")).toBeLessThan(9_000);
		expect(text.startsWith("x".repeat(100))).toBe(true);
	});

	it("does not trim a toolResult with exactly the kept-line count ending in a newline", () => {
		// Regression: the line-cap scan used to report lineCapBinds when all cap
		// iterations found a newline, even though a body with exactly
		// NESTED_SLIM_TOOL_RESULT_HEAD_LINES lines that ends in a newline has no
		// (cap+1)-th line to drop — a spurious trim marker was appended while
		// every line survived.
		const lines = Array.from(
			{ length: NESTED_SLIM_TOOL_RESULT_HEAD_LINES },
			(_, index) => `L${String(index).padStart(3, "0")}`,
		);
		const exactlyAtCap = `${lines.join("\n")}\n`;
		const messages = [
			bigToolResult(exactlyAtCap),
			{ role: "user", content: "filler 1" },
			{ role: "user", content: "filler 2" },
			{ role: "user", content: "filler 3" },
			{ role: "user", content: "recent" },
		];
		const result = compressNestedMessages(messages);
		// nothing exceeded either cap, so the toolResult is left verbatim
		expect(result.degraded).toBe(0);
		const [first] = result.messages;
		// SAFETY: the fixture toolResult content is a single text block array,
		// and an untouched result keeps that shape.
		const parts = first?.content as { type: string; text: string }[] | undefined;
		expect(parts?.[0]?.text).toBe(exactlyAtCap);
	});

	it("trims when the (kept-line-count+1)-th line follows within the byte budget", () => {
		// The (cap+1)-th line must be longer than the truncation marker, else the
		// trim would net-inflate the history (marker > dropped tail) and the
		// strict-shrink guard correctly declines it.
		const keptLines = Array.from(
			{ length: NESTED_SLIM_TOOL_RESULT_HEAD_LINES },
			(_, index) => `K${String(index).padStart(3, "0")}`,
		);
		const droppedLine = `D${String(NESTED_SLIM_TOOL_RESULT_HEAD_LINES).padStart(3, "0")}`.padEnd(
			2_000,
			"x",
		);
		const overLineCap = `${[...keptLines, droppedLine].join("\n")}\n`;
		const messages = [
			bigToolResult(overLineCap),
			{ role: "user", content: "filler 1" },
			{ role: "user", content: "filler 2" },
			{ role: "user", content: "filler 3" },
			{ role: "user", content: "recent" },
		];
		const result = compressNestedMessages(messages);
		expect(result.degraded).toBe(1);
		const [first] = result.messages;
		// SAFETY: the fixture toolResult content is a single text block array,
		// and slimming preserves that shape (trimmed to one text block).
		const parts = first?.content as { type: string; text: string }[] | undefined;
		const text = parts?.[0]?.text ?? "";
		expect(text).toContain(NESTED_SLIM_TRUNCATION_MARKER);
		// the kept lines survive; the long (cap+1)-th line is dropped
		expect(text).toContain(keptLines[NESTED_SLIM_TOOL_RESULT_HEAD_LINES - 1] ?? "");
		expect(text).not.toContain(droppedLine);
	});

	it("never splits a multibyte character at the byte cap", () => {
		const multibyte = "中".repeat(3_000); // 9KB of 3-byte chars
		const messages = [
			bigToolResult(multibyte),
			{ role: "user", content: "filler 1" },
			{ role: "user", content: "filler 2" },
			{ role: "user", content: "filler 3" },
			{ role: "user", content: "recent" },
		];
		const result = compressNestedMessages(messages);
		expect(result.degraded).toBe(1);
		const [first] = result.messages;
		// SAFETY: the fixture toolResult content is a single text block array,
		// and slimming preserves that shape (trimmed to one text block).
		const parts = first?.content as { type: string; text: string }[] | undefined;
		const text = parts?.[0]?.text ?? "";
		expect(text).toContain(NESTED_SLIM_TRUNCATION_MARKER);
		// no U+FFFD replacement garbage from a mid-sequence byte cut
		expect(text.includes("\uFFFD")).toBe(false);
		// valid: every kept char is a whole 中 (no partial sequences)
		const head = text.slice(0, text.indexOf(NESTED_SLIM_TRUNCATION_MARKER));
		expect(head.length % 1).toBe(0);
		expect(Array.from(head).every((character) => character === "中")).toBe(true);
	});

	it("is idempotent: a second pass changes nothing", () => {
		const build = () => [
			// 6 messages: the first two fall in the slim head (beyond the 4-message
			// verbatim keep window), the toolResult exceeds both the line and byte
			// caps so the first pass really trims it. The pre-fix sample was a
			// 4-message array (all inside the keep window) with a no-newline run,
			// so it never triggered any trim — this test guarded nothing.
			assistantWithThinking("alpha", "t".repeat(800)),
			bigToolResult(Array.from({ length: 25 }, () => "L".repeat(800)).join("\n")),
			assistantWithThinking("beta", "t".repeat(800)),
			{ role: "user", content: "filler 1" },
			{ role: "user", content: "filler 2" },
			{ role: "user", content: "recent" },
		];
		const first = compressNestedMessages(build());
		expect(first.degraded).toBeGreaterThan(0);
		const second = compressNestedMessages(first.messages);
		expect(second.degraded).toBe(0);
		expect(second.messages).toEqual(first.messages);
	});

	it("never empties an assistant message when stripping thinking", () => {
		// SAFETY: a minimal assistant fixture message; the shape matches the
		// advisor history content contract under test.
		const onlyThinking: AdvisorHistoryMessage = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "only thinking here" }],
		};
		const result = compressNestedMessages([onlyThinking, { role: "user", content: "recent" }]);
		// assistant was left intact (dropping it would orphan the next turn)
		expect(result.degraded).toBe(0);
		expect(result.messages[0]).toEqual(onlyThinking);
	});

	it("keeps redacted/opaque thinking signatures for provider continuity", () => {
		// SAFETY: a minimal assistant fixture message; the shape matches the
		// advisor history content contract under test.
		const redactedThinking: AdvisorHistoryMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque-payload" },
				{ type: "text", text: "survives" },
			],
		};
		const result = compressNestedMessages([redactedThinking, { role: "user", content: "recent" }]);
		// SAFETY: the fixture assistant message content is a block array; the
		// redacted thinking block is retained by the slimmer by design.
		const content = result.messages[0]?.content as { type: string }[];
		expect(content.some((part) => part.type === "thinking")).toBe(true);
		expect(result.degraded).toBe(0);
	});

	it("is deterministic across identical inputs", () => {
		const build = () => [
			assistantWithThinking("a", "t".repeat(600)),
			bigToolResult("y".repeat(9_000)),
			{ role: "user", content: "recent" },
		];
		expect(JSON.stringify(compressNestedMessages(build()).messages)).toBe(
			JSON.stringify(compressNestedMessages(build()).messages),
		);
	});
});
