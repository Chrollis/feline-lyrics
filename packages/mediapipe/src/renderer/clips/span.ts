// Half-open span math. A clip covers [startMs, startMs + durationMs).

export interface Span {
    readonly startMs: number;
    readonly durationMs: number;
}

export function spanEnd(span: Span): number {
    return span.startMs + span.durationMs;
}

export function spanFromBounds(startMs: number, endMs: number): Span {
    return { startMs, durationMs: endMs - startMs };
}

/** True when t lies inside the half-open span. */
export function spanContains(span: Span, tMs: number): boolean {
    return span.startMs <= tMs && tMs < spanEnd(span);
}

export function spanIntersects(span: Span, other: Span): boolean {
    return spanIntersect(span, other) !== null;
}

/** Overlap of two spans, or null when they only touch. */
export function spanIntersect(span: Span, other: Span): Span | null {
    const startMs = Math.max(span.startMs, other.startMs);
    const endMs = Math.min(spanEnd(span), spanEnd(other));
    return endMs > startMs ? spanFromBounds(startMs, endMs) : null;
}

/** Shift a span by deltaMs, keeping its duration. */
export function spanOffset(span: Span, deltaMs: number): Span {
    return { startMs: span.startMs + deltaMs, durationMs: span.durationMs };
}
