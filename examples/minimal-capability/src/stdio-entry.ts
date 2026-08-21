#!/usr/bin/env node
import { startStdioAgentToolApplication } from '@agent-tool-platform/runtime';
import minimalCapability, { type MinimalConfig, type MinimalServices } from './index.js';

/**
 * The whole of a local stdio entry point.
 *
 * Everything generic — the silent logger, local execution semantics, the application, the
 * capability lifecycle, the MCP server, the transport, signal handling, ordered teardown, and the
 * process exit code — belongs to the platform. What is left is this capability's own environment
 * policy, which the platform deliberately knows nothing about: a real capability would default a
 * workspace root, a data root, or a documents path here in exactly the same shape.
 */
await startStdioAgentToolApplication<MinimalServices, MinimalConfig>(minimalCapability, {
  env: {
    ...process.env,
    MINIMAL_GREETING: process.env.MINIMAL_GREETING?.trim() || 'minimal capability',
  },
});
