export type ConnectorType = 'github' | 'kubernetes' | 'datadog' | 'backstage' | 'jira' | 'identity';

export function buildLinkingKey(connector: ConnectorType, ...parts: string[]): string {
  const prefix = getLinkingKeyPrefix(connector);
  return `${prefix}://${parts.join('/')}`;
}

function getLinkingKeyPrefix(connector: ConnectorType): string {
  switch (connector) {
    case 'github':
      return 'github';
    case 'kubernetes':
      return 'k8s';
    case 'datadog':
      return 'dd';
    case 'backstage':
      return 'backstage';
    case 'jira':
      return 'jira';
    case 'identity':
      return 'idp';
  }
}

export function parseLinkingKey(key: string): { connector: string; parts: string[] } | null {
  const match = key.match(/^([a-z0-9]+):\/\/(.+)$/);
  if (!match) return null;
  return {
    connector: match[1],
    parts: match[2].split('/'),
  };
}
