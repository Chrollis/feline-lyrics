import type { TimeSpan } from '../lyrics/time.js';

/** The reason one construct could not be represented. */
export type LossCode =
    // The source carries something the model has no place for.
    | 'unsupported-construct'
    // A tagged run had inner timing that only the model can express.
    | 'collapsed-run'
    // Checks are a model feature; the target has no syntax for them.
    | 'dropped-check-times'
    // The target cannot say "key up", only "a check".
    | 'dropped-check-kind'
    // The target has no annotation stream.
    | 'dropped-annotation'
    // The target has no per-cell duration, only starts.
    | 'dropped-duration'
    // A start landed outside the int32 millisecond range.
    | 'time-clamped'
    // A start was rounded to the target's time resolution.
    | 'time-truncated'
    // A tag was not valid and was kept as literal text instead of guessed.
    | 'tag-unrecognized'
    // The target has no metadata slot for a key the model holds.
    | 'meta-unsupported'
    // The source encoded information in a way that is discarded on purpose.
    | 'source-ignored';

/** One thing a conversion could not carry, with where it came from. */
export interface Loss {
    /** Where in the source, e.g. `lines[3].cells[2]`, or `meta.offset` on export. */
    readonly at: string;
    readonly code: LossCode;
    readonly detail: string;
}

/** Collects losses while a converter walks its input. */
export interface LossCollector {
    readonly losses: Loss[];
    add(at: string, code: LossCode, detail: string): void;
}

export function newLosses(): LossCollector {
    const losses: Loss[] = [];
    return {
        losses,
        add(at: string, code: LossCode, detail: string): void {
            losses.push({ at, code, detail });
        },
    };
}

/**
 * Spans the model stores but a start-only target cannot: the target infers a
 * duration from the next start, so anything else is a loss.
 */
export function durationProblem(
    span: TimeSpan,
    next: TimeSpan | null,
): string | null {
    if (span.duration === 0) {
        return null;
    }
    if (next === null) {
        return 'the last span has no following start to infer its end';
    }
    if (next.start !== span.start + span.duration) {
        return `span ends at ${span.start + span.duration} but the next starts at ${next.start}`;
    }
    return null;
}
