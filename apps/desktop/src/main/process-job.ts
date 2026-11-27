import { createRequire } from 'node:module';

import type { ServiceJob } from '@felyrics/host';

/**
 * The Windows Job Object that owns one backend's process tree.
 *
 * The reason this exists at all is the process a child starts by itself: the
 * backend spawns Python helpers, and `taskkill /T` can only reach them while
 * this app is alive to run it. A job whose only limit is
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` kills the whole tree when the last
 * handle closes, which is what Windows does for us even when the app crashes.
 *
 * Koffi is loaded lazily, through `createRequire`, for two reasons: the native
 * module cannot be bundled into the main chunk, and an app that never starts a
 * backend must not pay for the load.
 */

type KoffiModule = typeof import('koffi');

interface JobApi {
  readonly createJobObject: (attributes: unknown, name: unknown) => unknown;
  readonly setInformationJobObject: (
    job: unknown,
    infoClass: number,
    information: Record<string, unknown>,
    length: number,
  ) => boolean;
  readonly openProcess: (
    access: number,
    inheritHandle: boolean,
    pid: number,
  ) => unknown;
  readonly assignProcessToJobObject: (
    job: unknown,
    process: unknown,
  ) => boolean;
  readonly closeHandle: (handle: unknown) => boolean;
  readonly getLastError: () => number;
  readonly sizeOfExtendedLimit: number;
  readonly extendedLimit: Record<string, unknown>;
}

const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000;
const PROCESS_TERMINATE = 0x0000_0001;
const PROCESS_SET_QUOTA = 0x0000_0100;

const nativeRequire = createRequire(import.meta.url);
let cachedApi: JobApi | undefined;

function isNullPointer(value: unknown): boolean {
  return value === null || value === undefined || value === 0n;
}

function win32Error(action: string, code: number): Error {
  return new Error(`${action} failed with Win32 error ${code}`);
}

function loadApi(): JobApi {
  if (cachedApi !== undefined) {
    return cachedApi;
  }

  // The `koffi` package ships a prebuilt Node-API binary per platform, so this
  // require finds `@koromix/koffi-win32-x64` beside `node_modules/koffi` in the
  // installed app. A missing native module throws here and the protocol treats
  // the service as job-less.
  const koffi = nativeRequire('koffi') as KoffiModule;

  const basicLimits = koffi.struct('JOBOBJECT_BASIC_LIMIT_INFORMATION', {
    PerProcessUserTimeLimit: 'int64',
    PerJobUserTimeLimit: 'int64',
    LimitFlags: 'uint32',
    MinimumWorkingSetSize: 'uintptr',
    MaximumWorkingSetSize: 'uintptr',
    ActiveProcessLimit: 'uint32',
    Affinity: 'uintptr',
    PriorityClass: 'uint32',
    SchedulingClass: 'uint32',
  });
  const ioCounters = koffi.struct('IO_COUNTERS', {
    ReadOperationCount: 'uint64',
    WriteOperationCount: 'uint64',
    OtherOperationCount: 'uint64',
    ReadTransferCount: 'uint64',
    WriteTransferCount: 'uint64',
    OtherTransferCount: 'uint64',
  });
  const extendedLimit = koffi.struct(
    'JOBOBJECT_EXTENDED_LIMIT_INFORMATION',
    {
      BasicLimitInformation: basicLimits,
      IoInfo: ioCounters,
      ProcessMemoryLimit: 'uintptr',
      JobMemoryLimit: 'uintptr',
      PeakProcessMemoryUsed: 'uintptr',
      PeakJobMemoryUsed: 'uintptr',
    },
  );

  const library = koffi.load('kernel32.dll');
  const createJobObject = library.func(
    'void *CreateJobObjectW(void *attributes, void *name)',
  );
  const setInformationJobObject = library.func(
    'bool SetInformationJobObject(void *job, int infoClass, JOBOBJECT_EXTENDED_LIMIT_INFORMATION *information, uint32_t length)',
  );
  const openProcess = library.func(
    'void *OpenProcess(uint32_t access, bool inheritHandle, uint32_t pid)',
  );
  const assignProcessToJobObject = library.func(
    'bool AssignProcessToJobObject(void *job, void *process)',
  );
  const closeHandle = library.func('bool CloseHandle(void *handle)');
  const getLastError = library.func('uint32_t GetLastError()');

  const information = {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0,
      PerJobUserTimeLimit: 0,
      LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
      MinimumWorkingSetSize: 0,
      MaximumWorkingSetSize: 0,
      ActiveProcessLimit: 0,
      Affinity: 0,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0,
      WriteOperationCount: 0,
      OtherOperationCount: 0,
      ReadTransferCount: 0,
      WriteTransferCount: 0,
      OtherTransferCount: 0,
    },
    ProcessMemoryLimit: 0,
    JobMemoryLimit: 0,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0,
  };

  cachedApi = {
    createJobObject: (attributes, name) => createJobObject(attributes, name),
    setInformationJobObject: (job, infoClass, value, length) =>
      setInformationJobObject(job, infoClass, value, length),
    openProcess: (access, inheritHandle, pid) =>
      openProcess(access, inheritHandle, pid),
    assignProcessToJobObject: (job, process) =>
      assignProcessToJobObject(job, process),
    closeHandle: (handle) => closeHandle(handle),
    getLastError: () => getLastError(),
    sizeOfExtendedLimit: koffi.sizeof(extendedLimit),
    extendedLimit: information,
  };

  return cachedApi;
}

class WindowsProcessJob implements ServiceJob {
  readonly #api: JobApi;
  readonly #handle: unknown;
  #closed = false;

  constructor(api: JobApi) {
    this.#api = api;

    const handle = api.createJobObject(null, null);

    if (isNullPointer(handle)) {
      throw win32Error('CreateJobObjectW', api.getLastError());
    }

    this.#handle = handle;

    if (
      !api.setInformationJobObject(
        handle,
        JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
        api.extendedLimit,
        api.sizeOfExtendedLimit,
      )
    ) {
      const code = api.getLastError();

      api.closeHandle(handle);
      throw win32Error('SetInformationJobObject', code);
    }
  }

  assign(pid: number): void {
    if (this.#closed) {
      throw new Error('the job is already closed');
    }

    const process = this.#api.openProcess(
      PROCESS_SET_QUOTA | PROCESS_TERMINATE,
      false,
      pid,
    );

    if (isNullPointer(process)) {
      throw win32Error(`OpenProcess(${pid})`, this.#api.getLastError());
    }

    try {
      if (!this.#api.assignProcessToJobObject(this.#handle, process)) {
        throw win32Error(
          `AssignProcessToJobObject(${pid})`,
          this.#api.getLastError(),
        );
      }
    } finally {
      this.#api.closeHandle(process);
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }

    this.#closed = true;
    // With `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` the tree dies with the last
    // handle, and this process holds the only one.
    this.#api.closeHandle(this.#handle);
  }
}

/** Creates a job for one backend's process tree; throws when it cannot. */
export function createProcessJob(): ServiceJob {
  if (process.platform !== 'win32') {
    throw new Error('a Windows job object only exists on win32');
  }

  return new WindowsProcessJob(loadApi());
}
