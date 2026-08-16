export interface RedactionResult {
	text: string;
	redactions: number;
}

export const REDACTION = "[REDACTED]";

const PATTERNS: RegExp[] = [
	/-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
	/\b(?:sk|pk|api|key|token)-[A-Za-z0-9_-]{12,}\b/g,
	/\b(?:ghp|github_pat|glpat|xox[baprs]|AKIA|ASIA)[A-Za-z0-9_-]{8,}\b/g,
	/(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret)["']?\s*[:=]\s*)(["'])((?:\\.|(?!\2)[^\\\r\n])*)\2/gi,
	/(\b(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS)|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS)\s*=\s*)(["'])((?:\\.|(?!\2)[^\\\r\n])*)\2/g,
	/(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret)["']?\s*[:=]\s*)[^\s,"';}]{4,}/gi,
	/(\b(?:[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS)|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS)\s*=\s*)[^\s]+/g,
	/(https?:\/\/[^\s/:]+:)[^@\s]+@/gi,
];

export function redactSecrets(input: string): RedactionResult {
	let text = input;
	let redactions = 0;
	for (const pattern of PATTERNS) {
		text = text.replace(pattern, (match: string, ...groups: unknown[]) => {
			redactions++;
			const prefix = typeof groups[0] === "string" ? groups[0] : undefined;
			if (prefix !== undefined && match.startsWith(prefix)) return `${prefix}${REDACTION}`;
			if (/^Bearer\s/i.test(match)) return `Bearer ${REDACTION}`;
			return REDACTION;
		});
	}
	return { text, redactions };
}

/**
 * Replaces terminal control characters (C0 including ESC and DEL, and C1)
 * with U+FFFD so untrusted model-authored text cannot inject escape
 * sequences into the terminal; tab and newline are kept for multi-line
 * advice text. Use {@link containsTerminalControlCharacters} when single-line
 * text must reject tab and newline too.
 */
export function sanitizeTerminalText(input: string): string {
	let output = "";
	for (const character of input) {
		const codePoint = character.codePointAt(0) ?? 0;
		const allowedWhitespace = codePoint === 0x9 || codePoint === 0xa;
		const control = codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
		output += allowedWhitespace || !control ? character : "\uFFFD";
	}
	return output;
}

/** True when the text contains any terminal control character, including tab, newline, and carriage return. */
export function containsTerminalControlCharacters(input: string): boolean {
	return Array.from(input).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
	});
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function truncateUtf8Bytes(input: string, maxBytes: number, marker: string): string {
	if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
	const boundedMarker =
		Buffer.byteLength(marker, "utf8") > maxBytes ? truncateUtf8Bytes(marker, maxBytes, "") : marker;
	const markerBytes = Buffer.byteLength(boundedMarker, "utf8");
	const available = Math.max(0, maxBytes - markerBytes);
	let output = "";
	let bytes = 0;
	for (const character of input) {
		const next = Buffer.byteLength(character, "utf8");
		if (bytes + next > available) break;
		output += character;
		bytes += next;
	}
	return `${output}${boundedMarker}`;
}

export function truncateUtf8TailBytes(input: string, maxBytes: number, marker: string): string {
	if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
	const boundedMarker =
		Buffer.byteLength(marker, "utf8") > maxBytes ? truncateUtf8Bytes(marker, maxBytes, "") : marker;
	const available = Math.max(0, maxBytes - Buffer.byteLength(boundedMarker, "utf8"));
	const kept: string[] = [];
	let bytes = 0;
	for (const character of Array.from(input).reverse()) {
		const next = Buffer.byteLength(character, "utf8");
		if (bytes + next > available) break;
		kept.push(character);
		bytes += next;
	}
	return `${boundedMarker}${kept.reverse().join("")}`;
}
