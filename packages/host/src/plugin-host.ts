import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
  PickFileOptions,
  PluginBackend,
  PluginContext,
  PluginHostServices,
  PluginMethod,
  PluginParams,
} from './plugin.js';
import { exceedsPayload } from './protocol.js';
import {
  UTILITY_PROTOCOL_VERSION,
  type HostCommand,
  type PluginEvent,
  type PluginHostTransport,
  type WireError,
} from './utility-protocol.js';

/**
 * The plugin host: the only code that runs inside a plugin's utility process.
 *
 * It owns nothing but the plugin: it imports the entry the manifest names,
 * hands `activate` a context, records what that context registered, and then
 * serves requests until the host disposes it. The host process never imports
 * plugin code and the plugin never sees the host's tables.
 */

export interface ServePluginOptions {
  /** The plugin's route to its own backend; when absent, calls go to the host. */
  readonly backend?: PluginBackend;
}

class PluginHostError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PluginHostError';
    this.code = code;
  }
}

function wireError(code: string, message: string): WireError {
  return { code, message };
}

/**
 * Turns anything a plugin threw into a wire error. A thrown object with a
 * string code is the plugin's own refusal and keeps that code; everything else
 * is a crash and becomes the host's `core/internal`.
 */
function asWireError(error: unknown): WireError {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };

    if (typeof candidate.code === 'string' && candidate.code.length > 0) {
      return {
        code: candidate.code,
        message:
          typeof candidate.message === 'string'
            ? candidate.message
            : candidate.code,
      };
    }
  }

  if (error instanceof Error && error.message.length > 0) {
    return wireError('core/internal', error.message);
  }

  return wireError('core/internal', String(error));
}

function checkVersion(message: HostCommand): void {
  if (message.v !== UTILITY_PROTOCOL_VERSION) {
    throw wireError(
      'protocol/version-mismatch',
      `this plugin host speaks utility protocol ${UTILITY_PROTOCOL_VERSION}`,
    );
  }
}

/**
 * Serves one plugin over `transport` until the host disposes it.
 *
 * Registration is open only while `activate` runs: a plugin that registers from
 * a timer or a request would make "the manifest lists what is registered"
 * impossible to check, which is the promise activation exists for.
 */
export function servePlugin(
  transport: PluginHostTransport,
  options: ServePluginOptions = {},
): void {
  const methods = new Map<string, PluginMethod>();
  const disposers: (() => unknown | Promise<unknown>)[] = [];
  const pendingHost = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: Error) => void;
    }
  >();

  let registering = true;
  let activated = false;
  let disposing = false;
  let nextHostSeq = 0;

  const send = (event: PluginEvent): void => transport.send(event);

  function hostCall(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const seq = ++nextHostSeq;
    const answer = new Promise<unknown>((resolve, reject) => {
      pendingHost.set(seq, { resolve, reject });
    });

    send({
      v: UTILITY_PROTOCOL_VERSION,
      kind: 'host-call',
      seq,
      method,
      params,
    });

    return answer;
  }

  // A plugin never holds a service client: the host process owns the backend,
  // so a call is one more host service. An in-process backend, when one is
  // supplied, takes the shorter path.
  const backend: PluginBackend = options.backend ?? {
    call: (name, params, callOptions) =>
      hostCall('backend.call', {
        name,
        params,
        ...(callOptions?.timeoutMs === undefined
          ? {}
          : { timeoutMs: callOptions.timeoutMs }),
      }),
  };

  const host: PluginHostServices = {
    pickFile: async (options: PickFileOptions): Promise<string | null> => {
      const answer = await hostCall('pickFile', { kind: options.kind });

      return answer as string | null;
    },
  };

  function registerMethod(name: string, handler: PluginMethod): void {
    if (!registering) {
      throw new PluginHostError(
        'core/methods-mismatch',
        'a method must be registered while activate() runs',
      );
    }

    if (typeof handler !== 'function') {
      throw new PluginHostError(
        'core/methods-mismatch',
        `method ${name} has no handler`,
      );
    }

    if (methods.has(name)) {
      throw new PluginHostError(
        'core/methods-mismatch',
        `method ${name} is registered twice`,
      );
    }

    methods.set(name, handler);
  }

  function onDispose(handler: () => unknown | Promise<unknown>): void {
    if (!registering) {
      throw new PluginHostError(
        'core/methods-mismatch',
        'a disposer must be registered while activate() runs',
      );
    }

    disposers.push(handler);
  }

  async function activate(
    command: Extract<HostCommand, { kind: 'activate' }>,
  ): Promise<void> {
    const entry = join(command.directory, command.main);
    const module: unknown = await import(pathToFileURL(entry).href);
    const candidate = module as { activate?: unknown };

    if (typeof candidate.activate !== 'function') {
      throw new PluginHostError(
        'core/internal',
        `${entry} does not export activate()`,
      );
    }

    const context: PluginContext = {
      pluginId: command.pluginId,
      api: command.api,
      method: registerMethod,
      onDispose,
      host,
      ...(command.hasBackend === false ? {} : { backend }),
    };

    await candidate.activate(context);
    registering = false;
    activated = true;

    send({
      v: UTILITY_PROTOCOL_VERSION,
      kind: 'ready',
      methods: [...methods.keys()],
    });
  }

  async function answer(
    request: Extract<HostCommand, { kind: 'request' }>,
  ): Promise<void> {
    const handler = methods.get(request.name);

    if (handler === undefined) {
      send({
        v: UTILITY_PROTOCOL_VERSION,
        kind: 'failure',
        seq: request.seq,
        error: wireError(
          'core/internal',
          `the host asked for an unregistered method ${request.name}`,
        ),
      });
      return;
    }

    try {
      const result = await handler(request.params as PluginParams);

      if (exceedsPayload(result)) {
        send({
          v: UTILITY_PROTOCOL_VERSION,
          kind: 'failure',
          seq: request.seq,
          error: wireError(
            'protocol/oversize',
            'the result is larger than the payload bound',
          ),
        });
        return;
      }

      send({
        v: UTILITY_PROTOCOL_VERSION,
        kind: 'result',
        seq: request.seq,
        result,
      });
    } catch (error) {
      send({
        v: UTILITY_PROTOCOL_VERSION,
        kind: 'failure',
        seq: request.seq,
        error: asWireError(error),
      });
    }
  }

  function answerHostReply(
    reply: Extract<HostCommand, { kind: 'host-reply' }>,
  ): void {
    const pending = pendingHost.get(reply.seq);

    if (pending === undefined) {
      return;
    }

    pendingHost.delete(reply.seq);

    if (reply.error !== undefined) {
      pending.reject(
        new PluginHostError(reply.error.code, reply.error.message),
      );
      return;
    }

    if (reply.result !== undefined && exceedsPayload(reply.result)) {
      pending.reject(
        new PluginHostError(
          'protocol/oversize',
          'the host replied with more than the payload bound',
        ),
      );
      return;
    }

    pending.resolve(reply.result ?? null);
  }

  async function dispose(): Promise<void> {
    if (disposing) {
      return;
    }

    disposing = true;

    for (const pending of pendingHost.values()) {
      pending.reject(
        new PluginHostError('core/internal', 'the plugin host is disposing'),
      );
    }

    pendingHost.clear();

    // Newest first and strictly one at a time: a disposer that waits for a
    // resource another disposer frees would deadlock if they ran together.
    for (const disposer of [...disposers].reverse()) {
      try {
        await disposer();
      } catch {
        // A failing disposer must not keep the others from running.
      }
    }

    disposers.length = 0;
    send({ v: UTILITY_PROTOCOL_VERSION, kind: 'disposed' });
    transport.close();
  }

  const unsubscribe = transport.onMessage((message) => {
    void (async () => {
      try {
        checkVersion(message);

        if (message.kind === 'host-reply') {
          answerHostReply(message);
          return;
        }

        if (message.kind === 'activate') {
          if (activated || disposing) {
            send({
              v: UTILITY_PROTOCOL_VERSION,
              kind: 'fatal',
              error: wireError(
                'core/internal',
                'this plugin host was already activated',
              ),
            });
            return;
          }

          await activate(message);
          return;
        }

        if (message.kind === 'request') {
          await answer(message);
          return;
        }

        if (message.kind === 'dispose') {
          await dispose();
        }
      } catch (error) {
        send({
          v: UTILITY_PROTOCOL_VERSION,
          kind: 'fatal',
          error: asWireError(error),
        });
      }
    })();
  });

  transport.closed.then(() => {
    unsubscribe();

    for (const pending of pendingHost.values()) {
      pending.reject(
        new PluginHostError('core/internal', 'the host went away'),
      );
    }

    pendingHost.clear();
  });
}
