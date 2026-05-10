import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/shared',
  'packages/event-bus',
  'packages/core-writer',
  'packages/connector-sdk',
  'packages/connectors/github',
  'packages/connectors/kubernetes',
  'packages/api-server',
  'packages/mcp-server',
  'packages/web-ui',
]);
