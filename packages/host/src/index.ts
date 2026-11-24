export {
  discoverPluginDirectories,
  discoverPlugins,
  type DiscoveryOptions,
} from './loader.js';
export {
  isShortName,
  loadManifest,
  ManifestError,
  PLUGIN_API,
  PLUGIN_HOSTS,
  WORKER_LIMIT,
  type CommandContribution,
  type LoadManifestOptions,
  type ManifestErrorCode,
  type ManifestIssue,
  type PluginHost,
  type PluginManifest,
  type PythonTarget,
} from './manifest.js';
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
