// Engram — Framework Adapter Types
// Standard interface for mounting Engram into any agent framework.

import type { Plugin } from "../types/pluginTypes";

/**
 * FrameworkAdapter — mounts an Engram Plugin into a specific agent framework.
 *
 * Each adapter handles the framework-specific integration:
 * - Maps Engram lifecycle hooks to the framework's event system
 * - Registers Engram tools as framework tools
 * - Provides the framework with the Engram memory provider
 */
export interface FrameworkAdapter {
  /** Framework identifier (e.g. "openclaw", "langchain", "generic") */
  readonly framework: string;

  /**
   * Mount the Engram plugin into the host framework.
   * @param plugin The Engram plugin to mount
   * @param hostContext Framework-specific context (e.g., runtime instance, app config)
   */
  mount(plugin: Plugin, hostContext: unknown): Promise<void>;

  /** Unmount the plugin and clean up resources */
  unmount(): Promise<void>;
}

/**
 * GenericAdapterConfig — configuration for the GenericAdapter.
 * Used when integrating Engram into a custom agent framework.
 */
export interface GenericAdapterConfig {
  /** Called before each agent step with the user message */
  onBeforeStep?: (memories: string[], sessionBridges: string[]) => string | void;

  /** Called after each agent run completes */
  onAfterRun?: (result: { steps: number; durationMs: number }) => void;

  /** Called when a memory is proposed by the agent */
  onMemoryProposed?: (type: string, content: string) => void;
}

/**
 * StandaloneServerConfig — configuration for the built-in HTTP server adapter.
 */
export interface StandaloneServerConfig {
  /** HTTP server port (default: 3456) */
  port?: number;
  /** Host to bind to (default: "localhost") */
  host?: string;
  /** API key for authentication (optional) */
  apiKey?: string;
}
