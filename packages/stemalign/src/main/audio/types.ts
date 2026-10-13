export interface PcmAudio {
    readonly sampleRate: number;
    readonly channels: readonly Float32Array[];
}
