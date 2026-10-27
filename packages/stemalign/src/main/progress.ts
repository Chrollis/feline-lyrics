export interface SeparationProgress {
    readonly stage: 'chunk';
    readonly completed: number;
    readonly total: number;
}

export type ProgressEvent = SeparationProgress;

export type ProgressReporter = (event: ProgressEvent) => void;
