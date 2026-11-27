import type { PluginManifest } from './manifest.js';
import type { PluginHostServices, PluginParams } from './plugin.js';
import { BackendError, exceedsPayload } from './protocol.js';
import {
  UTILITY_PROTOCOL_VERSION,
  type PluginEvent,
  type PluginTransport,
} from './utility-protocol.js';

/**
 * The host-side lifecycle of one plugin.
 *
 * The states are the ones the contract names, and every transition is driven by
 * one event: `enable()` activates, a mismatch or a crash fails, `disable()`
 * unloads, and a second enable builds a new channel instead of reviving the old
 * one. A request is answered only from `ACTIVE`; anything else is `core/not-ready`
 * rather than a call into a half-loaded plugin.
 */
export type PluginState =
  | 'PENDING'
  | 'LOADING'
  | 'ACTIVE'
  | 'FAILED'
  | 'UNLOADING'
  | 'DISPOSED';

export interface PluginIssue {
  readonly path: string;
  readonly message: string;
}

export class PluginLifecycleError extends BackendError {
  readonly issues: readonly PluginIssue[];

  constructor(
    code: string,
    message: string,
    issues: readonly PluginIssue[] = [],
    data?: unknown,
  ) {
    super(code, message, data);
    this.name = 'PluginLifecycleError';
    this.issues = issues;
  }
}

export interface PluginHandleOptions {
  /** Opens the transport to one plugin host; the tests wire two loops. */
  readonly createChannel: (manifest: PluginManifest) => PluginTransport;
  /** Host-owned work a plugin may ask for, e.g. the native file picker. */
  readonly host?: PluginHostServices;
  readonly activationTimeoutMs?: number;
  readonly disposalTimeoutMs?: number;
}

export const DEFAULT_ACTIVATION_TIMEOUT_MS = 10_000;
export const DEFAULT_DISPOSAL_TIMEOUT_MS = 10_000;

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  code: string,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new PluginLifecycleError(code, message));
    }, milliseconds);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function describeError(error: unknown): PluginLifecycleError {
  if (error instanceof PluginLifecycleError) {
    return error;
  }

  if (error instanceof BackendError) {
    return new PluginLifecycleError(error.code, error.message);
  }

  if (error instanceof Error) {
    return new PluginLifecycleError('core/internal', error.message);
  }

  return new PluginLifecycleError('core/internal', String(error));
}

/** One loaded plugin, from `PENDING` to `DISPOSED`. */
export class PluginHandle {
  readonly manifest: PluginManifest;

  private readonly options: PluginHandleOptions;
  private readonly pending = new Map<number, PendingRequest>();

  private stateValue: PluginState = 'PENDING';
  private channel: PluginTransport | null = null;
  private unsubscribe: (() => void) | null = null;
  private loading: Promise<void> | null = null;
  private ready: {
    readonly resolve: (value: {
      readonly methods: readonly string[];
    }) => void;
    readonly reject: (error: Error) => void;
  } | null = null;
  private disposed: (() => void) | null = null;
  private nextSeq = 0;

  constructor(manifest: PluginManifest, options: PluginHandleOptions) {
    this.manifest = manifest;
    this.options = options;
  }

  get state(): PluginState {
    return this.stateValue;
  }

  /** The public names the app may call, `<id>/<short>`. */
  get publicMethods(): readonly string[] {
    return this.manifest.methods.map((name) => `${this.manifest.id}/${name}`);
  }

  /**
   * Activates the plugin: opens the channel, lets `activate()` register, and
   * checks the registration against the manifest in both directions.
   */
  async enable(): Promise<void> {
    if (this.stateValue === 'ACTIVE') {
      return;
    }

    if (this.stateValue === 'LOADING' && this.loading !== null) {
      return this.loading;
    }

    if (this.stateValue === 'UNLOADING') {
      throw new PluginLifecycleError(
        'core/not-ready',
        `${this.manifest.id} is still unloading`,
      );
    }

    this.stateValue = 'LOADING';
    this.loading = this.load();

    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /**
   * Unloads the plugin: asks the plugin host to run its disposers, then closes
   * the channel. A dispose that never answers is closed anyway; a plugin cannot
   * hold the host's shutdown open.
   */
  async disable(): Promise<void> {
    if (this.stateValue === 'DISPOSED') {
      return;
    }

    const channel = this.channel;

    if (channel === null) {
      this.stateValue = 'DISPOSED';
      return;
    }

    this.stateValue = 'UNLOADING';
    const disposed = new Promise<void>((resolve) => {
      this.disposed = resolve;
    });

    try {
      channel.send({ v: UTILITY_PROTOCOL_VERSION, kind: 'dispose' });
      await withTimeout(
        disposed,
        this.options.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS,
        'core/timeout',
        `${this.manifest.id} did not finish disposing`,
      );
    } catch {
      // Best effort: the channel is closed below whatever the plugin answered.
    } finally {
      this.disposed = null;
      this.closeChannel();
      this.stateValue = 'DISPOSED';
    }
  }

  /**
   * Stops the plugin without asking it: closes the channel (which kills the
   * utility child), rejects whatever is still waiting, and resolves an
   * in-flight disposal so a quit deadline can get past `disable()`.
   *
   * This is the forced path, so it sends no `dispose` and never throws: the
   * process is already on its way out.
   */
  forceClose(): void {
    if (this.stateValue === 'DISPOSED') {
      return;
    }

    this.stateValue = 'DISPOSED';

    const error = new PluginLifecycleError(
      'core/not-ready',
      `${this.manifest.id} was closed`,
    );

    const disposed = this.disposed;
    this.disposed = null;
    disposed?.();

    const ready = this.ready;
    this.ready = null;
    ready?.reject(error);

    for (const pending of this.pending.values()) {
      pending.reject(error);
    }

    this.pending.clear();

    const channel = this.channel;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = null;
    this.channel = null;

    try {
      unsubscribe?.();
    } catch {
      // The transport is already going away; keep the forced path silent.
    }

    try {
      channel?.close();
    } catch {
      // The child may already be gone; a forced close is best effort.
    }
  }

  /** Calls one public method, e.g. `felyrics.media/probe`. */
  async request(
    publicName: string,
    params: PluginParams,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.stateValue !== 'ACTIVE' || this.channel === null) {
      throw new PluginLifecycleError(
        'core/not-ready',
        `${this.manifest.id} is not active`,
      );
    }

    const prefix = `${this.manifest.id}/`;

    if (!publicName.startsWith(prefix) || publicName.length === prefix.length) {
      throw new PluginLifecycleError(
        'protocol/unknown-method',
        `no method named ${publicName}`,
      );
    }

    const short = publicName.slice(prefix.length);

    if (!this.manifest.methods.includes(short)) {
      throw new PluginLifecycleError(
        'protocol/unknown-method',
        `no method named ${publicName}`,
      );
    }

    return this.invoke(
      { kind: 'request', name: short, params },
      timeoutMs,
      publicName,
    );
  }

  /** Sends one request and pairs the answer by its sequence. */
  private async invoke(
    message: {
      readonly kind: 'request';
      readonly name: string;
      readonly params: PluginParams;
    },
    timeoutMs: number | undefined,
    label: string,
  ): Promise<unknown> {
    const channel = this.channel;

    if (this.stateValue !== 'ACTIVE' || channel === null) {
      throw new PluginLifecycleError(
        'core/not-ready',
        `${this.manifest.id} is not active`,
      );
    }

    const seq = ++this.nextSeq;
    const answer = new Promise<unknown>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
    });

    if (message.kind === 'request') {
      channel.send({
        v: UTILITY_PROTOCOL_VERSION,
        kind: 'request',
        seq,
        name: message.name,
        params: message.params,
      });
    }

    try {
      // Public calls carry no host timeout: the plugin owns its budget, and a
      // slow frame decode must not be killed by a clock nobody asked for.
      // Only an explicit timeoutMs arms a timer.
      return timeoutMs === undefined
        ? await answer
        : await withTimeout(
            answer,
            timeoutMs,
            'core/timeout',
            `${label} did not answer`,
          );
    } catch (error) {
      this.pending.delete(seq);
      throw describeError(error);
    }
  }

  /**
   * B section 8: a plugin error is its own id plus a declared short name.
   * Host codes (core/*) pass through; anything else becomes core/internal,
   * with the original code kept in data.originalCode.
   */
  private pluginError(error: {
    readonly code: string;
    readonly message: string;
  }): PluginLifecycleError {
    const prefix = `${this.manifest.id}/`;
    const short = error.code.startsWith(prefix)
      ? error.code.slice(prefix.length)
      : undefined;
    const declared =
      error.code.startsWith('core/') ||
      error.code.startsWith('protocol/') ||
      (short !== undefined && this.manifest.errors.includes(short));

    if (declared) {
      return new PluginLifecycleError(error.code, error.message);
    }

    return new PluginLifecycleError(
      'core/internal',
      `${error.code}: ${error.message}`,
      [],
      { originalCode: error.code },
    );
  }

  private async load(): Promise<void> {
    const channel = this.options.createChannel(this.manifest);
    this.channel = channel;

    const registered = new Promise<{
      readonly methods: readonly string[];
    }>((resolve, reject) => {
      this.ready = { resolve, reject };
    });

    this.unsubscribe = channel.onMessage((event) => {
      this.handleEvent(event);
    });

    void channel.closed.then(() => {
      this.handleClosed();
    });

    channel.send({
      v: UTILITY_PROTOCOL_VERSION,
      kind: 'activate',
      directory: this.manifest.directory,
      main: this.manifest.main,
      pluginId: this.manifest.id,
      api: this.manifest.api,
      hasBackend: this.manifest.python !== undefined,
    });

    try {
      const answer = await withTimeout(
        registered,
        this.options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS,
        'core/timeout',
        `${this.manifest.id} did not finish activating`,
      );

      this.assertRegistrations(answer);
      this.stateValue = 'ACTIVE';
    } catch (error) {
      this.ready = null;

      // A forced close may have won while activation was in flight; it already
      // set DISPOSED and a late rejection must not turn the handle FAILED.
      if (this.stateValue !== 'DISPOSED') {
        this.stateValue = 'FAILED';
      }

      this.closeChannel();
      throw describeError(error);
    }
  }

  /**
   * The manifest declares exactly what the plugin registered: a method nobody
   * declared is as much a failure as a declared method nobody registered.
   */
  private assertRegistrations(answer: {
    readonly methods: readonly string[];
  }): void {
    const issues: PluginIssue[] = [];

    const missingMethods = this.manifest.methods.filter(
      (name) => !answer.methods.includes(name),
    );
    const extraMethods = answer.methods.filter(
      (name) => !this.manifest.methods.includes(name),
    );

    if (missingMethods.length > 0) {
      issues.push({
        path: 'contributes.methods',
        message: `declared but not registered: ${missingMethods.join(', ')}`,
      });
    }

    if (extraMethods.length > 0) {
      issues.push({
        path: 'registered methods',
        message: `not declared: ${extraMethods.join(', ')}`,
      });
    }

    if (issues.length > 0) {
      throw new PluginLifecycleError(
        'core/methods-mismatch',
        `${this.manifest.id} registered a different set than its manifest declares`,
        issues,
      );
    }
  }

  /** Answers one host service call; the host owns the window, not the plugin. */
  private async answerHostCall(
    event: Extract<PluginEvent, { kind: 'host-call' }>,
  ): Promise<void> {
    const channel = this.channel;

    if (channel === null) {
      return;
    }

    try {
      if (event.method === 'backend.call') {
        const { name, params, timeoutMs } = event.params as {
          name?: unknown;
          params?: unknown;
          timeoutMs?: unknown;
        };

        if (typeof name !== 'string' || name.length === 0) {
          throw new PluginLifecycleError(
            'protocol/bad-request',
            'backend.call.name must be a non-empty string',
          );
        }

        if (typeof params !== 'object' || params === null) {
          throw new PluginLifecycleError(
            'protocol/bad-request',
            'backend.call.params must be an object',
          );
        }

        if (
          timeoutMs !== undefined &&
          (typeof timeoutMs !== 'number' ||
            !Number.isInteger(timeoutMs) ||
            timeoutMs <= 0)
        ) {
          throw new PluginLifecycleError(
            'protocol/bad-request',
            'backend.call.timeoutMs must be a positive integer',
          );
        }

        const backend = this.options.host?.backend;

        if (backend === undefined) {
          throw new PluginLifecycleError(
            'core/not-ready',
            'this plugin has no backend route',
          );
        }

        const answer = await backend.call(
          // The shared backend process keys its handlers by `(plugin, short)`;
          // the plugin's source still says just `probe` or `decode`.
          `${this.manifest.id}/${name}`,
          params as PluginParams,
          timeoutMs === undefined ? {} : { timeoutMs },
        );

        if (exceedsPayload(answer)) {
          throw new PluginLifecycleError(
            'protocol/oversize',
            'the backend answered with more than the payload bound',
          );
        }

        channel.send({
          v: UTILITY_PROTOCOL_VERSION,
          kind: 'host-reply',
          seq: event.seq,
          result: answer,
        });
        return;
      }

      if (event.method !== 'pickFile') {
        throw new PluginLifecycleError(
          'protocol/unknown-method',
          `no host service named ${event.method}`,
        );
      }

      const kind = (event.params as { kind?: unknown }).kind;

      if (kind !== 'audio' && kind !== 'video' && kind !== 'any') {
        throw new PluginLifecycleError(
          'protocol/bad-request',
          'pickFile.kind must be audio, video or any',
        );
      }

      const services = this.options.host;

      if (services === undefined) {
        throw new PluginLifecycleError(
          'core/not-ready',
          'this host offers no file picker',
        );
      }

      channel.send({
        v: UTILITY_PROTOCOL_VERSION,
        kind: 'host-reply',
        seq: event.seq,
        result: await services.pickFile({ kind }),
      });
    } catch (error) {
      const described = describeError(error);

      channel.send({
        v: UTILITY_PROTOCOL_VERSION,
        kind: 'host-reply',
        seq: event.seq,
        error: { code: described.code, message: described.message },
      });
    }
  }

  private handleEvent(event: PluginEvent): void {
    if (event.v !== UTILITY_PROTOCOL_VERSION) {
      this.failAll(
        new PluginLifecycleError(
          'protocol/version-mismatch',
          `plugin host speaks utility protocol ${String(event.v)}`,
        ),
      );
      return;
    }

    if (event.kind === 'host-call') {
      void this.answerHostCall(event);
      return;
    }

    if (event.kind === 'ready') {
      const ready = this.ready;
      this.ready = null;
      ready?.resolve({ methods: event.methods });
      return;
    }

    if (event.kind === 'result' || event.kind === 'failure') {
      const pending = this.pending.get(event.seq);

      if (pending === undefined) {
        return;
      }

      this.pending.delete(event.seq);

      if (event.kind === 'result') {
        if (exceedsPayload(event.result)) {
          pending.reject(
            new PluginLifecycleError(
              'protocol/oversize',
              'the plugin answered with more than the payload bound',
            ),
          );
          return;
        }

        pending.resolve(event.result);
      } else {
        pending.reject(this.pluginError(event.error));
      }

      return;
    }

    if (event.kind === 'fatal') {
      this.failAll(
        new PluginLifecycleError(event.error.code, event.error.message),
      );
      return;
    }

    if (event.kind === 'disposed') {
      const disposed = this.disposed;
      this.disposed = null;
      disposed?.();
    }
  }

  private handleClosed(): void {
    if (this.stateValue === 'UNLOADING' || this.stateValue === 'DISPOSED') {
      this.disposed?.();
      return;
    }

    this.failAll(
      new PluginLifecycleError(
        'core/internal',
        `${this.manifest.id} exited`,
      ),
    );
  }

  private failAll(error: PluginLifecycleError): void {
    if (this.stateValue === 'LOADING' || this.stateValue === 'ACTIVE') {
      this.stateValue = 'FAILED';
    }

    const ready = this.ready;
    this.ready = null;
    ready?.reject(error);

    for (const pending of this.pending.values()) {
      pending.reject(error);
    }

    this.pending.clear();
    this.closeChannel();
  }

  private closeChannel(): void {
    const channel = this.channel;

    this.unsubscribe?.();
    this.unsubscribe = null;
    this.channel = null;

    if (channel !== null) {
      channel.close();
    }

    for (const pending of this.pending.values()) {
      pending.reject(
        new PluginLifecycleError(
          'core/not-ready',
          `${this.manifest.id} is not active`,
        ),
      );
    }

    this.pending.clear();
    this.ready = null;
  }
}

export interface PluginSummary {
  readonly id: string;
  readonly state: PluginState;
  readonly methods: readonly string[];
}

/** All plugins of one host run, looked up by id or by public method name. */
export class PluginHosts {
  private readonly handles = new Map<string, PluginHandle>();
  private readonly options: PluginHandleOptions;

  constructor(
    manifests: readonly PluginManifest[],
    options: PluginHandleOptions,
  ) {
    this.options = options;
    for (const manifest of manifests) {
      this.handles.set(manifest.id, new PluginHandle(manifest, options));
    }
  }

  async enable(id: string): Promise<void> {
    await this.get(id).enable();
  }

  /**
   * Adds a manifest discovered after the table was built (a plugin installed
   * while the app runs). The new handle starts PENDING like any other.
   */
  add(manifest: PluginManifest): void {
    if (this.handles.has(manifest.id)) {
      throw new BackendError(
        'core/duplicate-id',
        `plugin ${manifest.id} is already in the table`,
      );
    }

    this.handles.set(manifest.id, new PluginHandle(manifest, this.options));
  }

  async disable(id: string): Promise<void> {
    await this.get(id).disable();
  }

  /**
   * The quit deadline's last resort: force every handle closed. One broken
   * handle must not keep the rest alive, so each is attempted separately.
   */
  forceClose(): void {
    for (const handle of this.handles.values()) {
      try {
        handle.forceClose();
      } catch {
        // forceClose is documented not to throw; keep going anyway.
      }
    }
  }

  async request(
    publicName: string,
    params: PluginParams,
    timeoutMs?: number,
  ): Promise<unknown> {
    const slash = publicName.indexOf('/');
    const id = slash === -1 ? publicName : publicName.slice(0, slash);

    return this.get(id).request(publicName, params, timeoutMs);
  }

  list(): readonly PluginSummary[] {
    return [...this.handles.values()].map((handle) => ({
      id: handle.manifest.id,
      state: handle.state,
      methods: handle.publicMethods,
    }));
  }

  handle(id: string): PluginHandle {
    return this.get(id);
  }

  private get(id: string): PluginHandle {
    const handle = this.handles.get(id);

    if (handle === undefined) {
      throw new PluginLifecycleError(
        'protocol/unknown-method',
        `no plugin with id ${id}`,
      );
    }

    return handle;
  }
}
