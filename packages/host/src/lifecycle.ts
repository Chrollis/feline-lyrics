import type { CommandContribution, PluginManifest } from './manifest.js';
import type { PluginParams } from './plugin.js';
import { BackendError, DEFAULT_REQUEST_TIMEOUT_MS } from './protocol.js';
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
  ) {
    super(code, message);
    this.name = 'PluginLifecycleError';
    this.issues = issues;
  }
}

export interface PluginHandleOptions {
  /** Opens the transport to one plugin host; the tests wire two loops. */
  readonly createChannel: (manifest: PluginManifest) => PluginTransport;
  readonly activationTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
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
      readonly commands: readonly string[];
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

  get commands(): readonly CommandContribution[] {
    return this.manifest.commands;
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

    const seq = ++this.nextSeq;
    const answer = new Promise<unknown>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
    });

    this.channel.send({
      v: UTILITY_PROTOCOL_VERSION,
      kind: 'request',
      seq,
      name: short,
      params,
    });

    try {
      return await withTimeout(
        answer,
        timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        'core/timeout',
        `${publicName} did not answer`,
      );
    } catch (error) {
      this.pending.delete(seq);
      throw describeError(error);
    }
  }

  private async load(): Promise<void> {
    const channel = this.options.createChannel(this.manifest);
    this.channel = channel;

    const registered = new Promise<{
      readonly methods: readonly string[];
      readonly commands: readonly string[];
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
      this.stateValue = 'FAILED';
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
    readonly commands: readonly string[];
  }): void {
    const issues: PluginIssue[] = [];

    const missingMethods = this.manifest.methods.filter(
      (name) => !answer.methods.includes(name),
    );
    const extraMethods = answer.methods.filter(
      (name) => !this.manifest.methods.includes(name),
    );
    const missingCommands = this.manifest.commands
      .map((command) => command.id)
      .filter((id) => !answer.commands.includes(id));
    const extraCommands = answer.commands.filter(
      (id) => !this.manifest.commands.some((command) => command.id === id),
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

    if (missingCommands.length > 0) {
      issues.push({
        path: 'contributes.commands',
        message: `declared but not registered: ${missingCommands.join(', ')}`,
      });
    }

    if (extraCommands.length > 0) {
      issues.push({
        path: 'registered commands',
        message: `not declared: ${extraCommands.join(', ')}`,
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

    if (event.kind === 'ready') {
      const ready = this.ready;
      this.ready = null;
      ready?.resolve({ methods: event.methods, commands: event.commands });
      return;
    }

    if (event.kind === 'result' || event.kind === 'failure') {
      const pending = this.pending.get(event.seq);

      if (pending === undefined) {
        return;
      }

      this.pending.delete(event.seq);

      if (event.kind === 'result') {
        pending.resolve(event.result);
      } else {
        pending.reject(
          new PluginLifecycleError(event.error.code, event.error.message),
        );
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
  readonly commands: readonly CommandContribution[];
}

/** All plugins of one host run, looked up by id or by public method name. */
export class PluginHosts {
  private readonly handles = new Map<string, PluginHandle>();

  constructor(
    manifests: readonly PluginManifest[],
    options: PluginHandleOptions,
  ) {
    for (const manifest of manifests) {
      this.handles.set(manifest.id, new PluginHandle(manifest, options));
    }
  }

  async enable(id: string): Promise<void> {
    await this.get(id).enable();
  }

  async disable(id: string): Promise<void> {
    await this.get(id).disable();
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
      commands: handle.commands,
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
