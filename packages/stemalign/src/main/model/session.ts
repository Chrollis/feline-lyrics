import { isAbsolute } from 'node:path';
import { env, InferenceSession } from 'onnxruntime-node';
import type { TensorInfo } from './info.js';
import { toTensorInfos } from './info.js';
import { StemalignError } from '../errors.js';
import type { ModelSource, ModelSpec } from './spec.js';

export type OrtLogLevel = 'verbose' | 'info' | 'warning' | 'error' | 'fatal';

let ortInitialized = false;

export function setOrtLogLevel(level: OrtLogLevel): void {
    if (ortInitialized) {
        throw new StemalignError(
            'log-level-too-late',
            'the ORT log level must be set before the first session is created',
            { actual: level },
        );
    }
    env.logLevel = level;
}

export interface ModelSession {
    readonly name: string;
    readonly inputInfo: readonly TensorInfo[];
    readonly outputInfo: readonly TensorInfo[];
    run(
        feeds: InferenceSession.FeedsType,
        fetches?: readonly string[],
    ): Promise<InferenceSession.ReturnType>;
    release(): Promise<void>;
}

export interface ModelHandle {
    readonly id: string;
    readonly sessions: ReadonlyMap<string, ModelSession>;
    readonly settings: Readonly<Record<string, string>>;
    release(): Promise<void>;
}

export async function openModel(spec: ModelSpec): Promise<ModelHandle> {
    const names = Object.keys(spec.sessions);
    if (names.length === 0) {
        throw new StemalignError(
            'model-invalid',
            `model "${spec.id}" defines no sessions`,
            { modelId: spec.id },
        );
    }
    const sessions = new Map<string, ModelSession>();
    try {
        for (const name of names) {
            const source = spec.sessions[name];
            if (source === undefined) {
                continue;
            }
            ortInitialized = true;
            const session = await createSession(
                spec.id,
                name,
                source,
                spec.executionProviders,
            );
            sessions.set(name, session);
        }
    } catch (error) {
        try {
            await releaseAll(sessions.values());
        } catch {
            // A cleanup failure must not hide the error that triggered the cleanup.
        }
        throw error;
    }
    return {
        id: spec.id,
        sessions,
        settings: spec.settings ?? {},
        release: () => releaseAll(sessions.values()),
    };
}

export function requireSession(
    handle: ModelHandle,
    name: string,
): ModelSession {
    const session = handle.sessions.get(name);
    if (session === undefined) {
        throw new StemalignError(
            'model-invalid',
            `model "${handle.id}" has no session named "${name}"`,
            { modelId: handle.id, session: name },
        );
    }
    return session;
}

async function createSession(
    modelId: string,
    name: string,
    source: ModelSource,
    executionProviders: readonly string[] | undefined,
): Promise<ModelSession> {
    if (!('bytes' in source) && !isAbsolute(source.path)) {
        throw new StemalignError(
            'invalid-option',
            `session "${name}" of model "${modelId}" needs an absolute model path`,
            { modelId, session: name, actual: source.path },
        );
    }
    const options: InferenceSession.SessionOptions = {};
    if (executionProviders !== undefined) {
        options.executionProviders = executionProviders;
    }
    if ('bytes' in source && source.externalData !== undefined) {
        options.externalData = source.externalData.map((item) => ({
            data: item.bytes,
            path: item.path,
        }));
    }
    const session = await createInferenceSession(
        modelId,
        name,
        source,
        options,
    );
    let released = false;
    return {
        name,
        inputInfo: toTensorInfos(session.inputMetadata),
        outputInfo: toTensorInfos(session.outputMetadata),
        run: async (feeds, fetches) => {
            if (released) {
                throw new StemalignError(
                    'session-released',
                    `session "${name}" of model "${modelId}" is already released`,
                    { modelId, session: name },
                );
            }
            return fetches === undefined
                ? session.run(feeds)
                : session.run(feeds, fetches);
        },
        release: async () => {
            if (released) {
                return;
            }
            released = true;
            await session.release();
        },
    };
}

async function releaseAll(sessions: Iterable<ModelSession>): Promise<void> {
    const list = Array.from(sessions);
    const results = await Promise.allSettled(
        list.map((session) => session.release()),
    );
    const failures: string[] = [];
    for (const [index, session] of list.entries()) {
        const result = results[index];
        if (result !== undefined && result.status === 'rejected') {
            failures.push(`${session.name}: ${String(result.reason)}`);
        }
    }
    if (failures.length > 0) {
        const summary = failures.join('; ');
        throw new StemalignError(
            'release-failed',
            `failed to release ${failures.length} of ${list.length} sessions: ${summary}`,
            { actual: summary },
        );
    }
}

async function createInferenceSession(
    modelId: string,
    name: string,
    source: ModelSource,
    options: InferenceSession.SessionOptions,
): Promise<InferenceSession> {
    try {
        return 'bytes' in source
            ? await InferenceSession.create(source.bytes, options)
            : await InferenceSession.create(source.path, options);
    } catch (error) {
        throw new StemalignError(
            'session-create-failed',
            `failed to create session "${name}" of model "${modelId}"`,
            { modelId, session: name },
            { cause: error },
        );
    }
}
