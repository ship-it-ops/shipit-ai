import { describe, it, expect } from 'vitest';
import { GitHubConnector } from '../connector.js';
import { parseCodeowners } from '../fetchers/codeowners.js';

describe('GitHubConnector', () => {
  it('has correct manifest', () => {
    const connector = new GitHubConnector();
    expect(connector.manifest.name).toBe('github');
    expect(connector.manifest.version).toBe('1.0.0');
    expect(connector.manifest.schema_version).toBe('1.0');
    expect(connector.manifest.supported_entity_types).toEqual([
      'Repository',
      'Team',
      'Person',
      'Pipeline',
    ]);
  });

  it('discover returns expected entity types', async () => {
    const connector = new GitHubConnector();
    const result = await connector.discover();
    expect(result.entity_types).toContain('Repository');
    expect(result.entity_types).toContain('Team');
    expect(result.entity_types).toContain('Pipeline');
    expect(result.entity_types).toContain('Codeowners');
  });

  it('normalize handles mixed entity types', () => {
    const connector = new GitHubConnector();
    // Access private org field via authenticate-like setup
    (connector as unknown as { org: string }).org = 'test-org';

    const raw = [
      {
        name: 'my-repo',
        full_name: 'test-org/my-repo',
        html_url: 'https://github.com/test-org/my-repo',
        default_branch: 'main',
        visibility: 'public',
        language: 'Go',
        topics: [],
        archived: false,
        description: null,
      },
    ];

    const result = connector.normalize(raw);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].label).toBe('Repository');
  });

  it('normalize handles team entities with members', () => {
    const connector = new GitHubConnector();
    (connector as unknown as { org: string }).org = 'test-org';

    const raw = [
      {
        slug: 'backend',
        name: 'Backend Team',
        description: null,
        privacy: 'closed',
        html_url: 'https://github.com/orgs/test-org/teams/backend',
        members: [
          {
            login: 'dev1',
            avatar_url: 'https://avatars.githubusercontent.com/dev1',
            html_url: 'https://github.com/dev1',
            role: 'member',
          },
        ],
      },
    ];

    const result = connector.normalize(raw);
    expect(result.nodes).toHaveLength(2); // Team + Person
    expect(result.edges).toHaveLength(1); // MEMBER_OF
    expect(result.edges[0].type).toBe('MEMBER_OF');
  });

  it('fetch throws if not authenticated', async () => {
    const connector = new GitHubConnector();
    await expect(connector.fetch('Repository')).rejects.toThrow('Not authenticated');
  });
});

describe('parseCodeowners', () => {
  it('parses a CODEOWNERS file', () => {
    const content = `# This is a comment
*.ts @org/frontend
/src/ @alice @bob
`;
    const entries = parseCodeowners(content, 'my-repo', 'org');
    expect(entries).toHaveLength(2);
    expect(entries[0].pattern).toBe('*.ts');
    expect(entries[0].owners).toEqual(['@org/frontend']);
    expect(entries[1].pattern).toBe('/src/');
    expect(entries[1].owners).toEqual(['@alice', '@bob']);
  });

  it('skips empty lines and comments', () => {
    const content = `
# Comment
# Another comment

*.ts @owner
`;
    const entries = parseCodeowners(content, 'repo', 'org');
    expect(entries).toHaveLength(1);
  });

  it('skips lines with no @ owners', () => {
    const content = `*.ts someone-without-at`;
    const entries = parseCodeowners(content, 'repo', 'org');
    expect(entries).toHaveLength(0);
  });
});
