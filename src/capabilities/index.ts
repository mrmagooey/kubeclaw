export type {
  CapabilitySpec,
  McpCapabilitySpec,
  RagCapabilitySpec,
  HttpCapabilitySpec,
  CapabilityKind,
  CapabilityStatus,
  CapabilityDiscoveryEntry,
  CapabilityLifecycle,
} from './types.js';

export {
  installCapability,
  removeCapability,
  listCapabilities,
  listCapabilitiesByKind,
  getCapabilityByName,
  getEntriesForChannel,
  notifyAllChannels,
  startCapabilitySubsystem,
} from './registry.js';

export { startDiscoveryWatcher, stopDiscoveryWatcher } from './discovery.js';

export { startHealthProbes, stopHealthProbes } from './health.js';
