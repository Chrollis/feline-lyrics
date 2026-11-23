export {
  resolveHostPaths,
  type HostPathInputs,
  type HostPaths,
} from './paths.js';
export {
  type BackendCallOptions,
  type PluginBackend,
  type PluginContext,
  type PluginMethod,
  type PluginParams,
} from './plugin.js';
export {
  BackendError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  PROTOCOL_VERSION,
  startService,
  type ServiceClient,
  type ServiceMessage,
  type ServiceOptions,
  type ServiceRequestOptions,
} from './protocol.js';
