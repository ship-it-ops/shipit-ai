// Route tests for the manual RELATIONS write path (v1b, task T4b).
//
// Unit/inject-level: the RelationEditService is FAKED (real-Neo4j integration is
// the separate T5b task). Coverage:
//   - POST /api/relations → 200 { created } (actor is the principal, not client)
//   - POST → 400 (INVALID_BODY) for a malformed body
//   - POST → 400 INVALID_RELATION_TYPE / SELF_LOOP / ENDPOINT_LABEL_MISMATCH
//   - POST → 404 ENDPOINT_NOT_FOUND
//   - POST over a connector edge → 200 { created:false, preexistingConnectorEdge:true }
//   - DELETE /api/relations → 200 { deleted:true }
//   - DELETE → 204 when nothing matched (idempotent)
//   - DELETE → 409 CONNECTOR_EDGE
//   - 503 MANUAL_EDIT_DISABLED when the service is not wired
//   - kill-switch off → 403 FEATURE_DISABLED
//   - anonymous → 401 boundary; mcp-token lacking graph:write → 403
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config } from '@shipit-ai/shared';
import { createServer } from '../../server.js';
import { makeTestConfig } from '../test-config.js';
import {
  RelationEditValidationError,
  RelationEditNotFoundError,
  RelationEditConflictError,
  type AddRelationInput,
  type DeleteRelationInput,
  type AddRelationResult,
} from '../../services/relation-edit-service.js';
import type { OidcProvider } from '../../services/auth/oidc-provider.js';
import type { TokenService } from '../../services/auth/token-service.js';
import type { Neo4jService } from '../../services/neo4j-service.js';

const SIGNING_SECRET = 'test-signing-secret-thirty-two-chars-or-more-please';

const fakeNeo4j = {
  getDriver: () => ({}),
} as unknown as Neo4jService;

interface FakeService {
  addRelation: (input: AddRelationInput) => Promise<AddRelationResult>;
  deleteRelation: (input: DeleteRelationInput) => Promise<boolean>;
}

const FROM = 'shipit://team/default/platform';
const TO = 'shipit://logicalservice/default/payments';

// --- Auth-disabled server: dev-fallback admin principal holds '*', so the
//     capability gate + kill-switch pass and we exercise service-error mapping.
describe('relations routes — service contract (auth disabled, admin principal)', () => {
  let server: FastifyInstance;
  let fake: FakeService;

  beforeAll(async () => {
    server = await createServer({ config: makeTestConfig(), neo4jService: fakeNeo4j });
    await server.ready();
  });
  afterAll(async () => {
    await server.close();
  });
  beforeEach(() => {
    fake = {
      addRelation: async () => ({ created: true }),
      deleteRelation: async () => true,
    };
    (server as unknown as { relationEditService: FakeService }).relationEditService = fake;
  });

  it('POST /api/relations → 200 { created:true }; actor is the principal, not client', async () => {
    let received: AddRelationInput | undefined;
    fake.addRelation = async (input) => {
      received = input;
      return { created: true };
    };
    const res = await server.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { from: FROM, to: TO, type: 'OWNS', properties: { note: 'x' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: true });
    expect(received).toMatchObject({
      from: FROM,
      to: TO,
      type: 'OWNS',
      properties: { note: 'x' },
      actor: 'dev@shipit.local',
    });
  });

  it('POST over a connector edge → 200 { created:false, preexistingConnectorEdge:true }', async () => {
    fake.addRelation = async () => ({ created: false, preexistingConnectorEdge: true });
    const res = await server.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { from: FROM, to: TO, type: 'OWNS' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ created: false, preexistingConnectorEdge: true });
  });

  it('POST → 400 INVALID_BODY for a malformed body', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { from: FROM, type: 'OWNS' }, // missing `to`
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_BODY');
  });

  it('POST → 400 INVALID_RELATION_TYPE', async () => {
    fake.addRelation = async () => {
      throw new RelationEditValidationError(
        'Unknown relationship type: NOPE',
        'INVALID_RELATION_TYPE',
      );
    };
    const res = await server.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { from: FROM, to: TO, type: 'NOPE' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_RELATION_TYPE');
  });

  it('POST → 400 SELF_LOOP', async () => {
    fake.addRelation = async () => {
      throw new RelationEditValidationError('Self-loops are not allowed', 'SELF_LOOP');
    };
    const res = await server.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { from: FROM, to: FROM, type: 'DEPENDS_ON' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SELF_LOOP');
  });

  it('POST → 400 ENDPOINT_LABEL_MISMATCH', async () => {
    fake.addRelation = async () => {
      throw new RelationEditValidationError(
        'OWNS requires a Team from-node',
        'ENDPOINT_LABEL_MISMATCH',
      );
    };
    const res = await server.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { from: FROM, to: TO, type: 'OWNS' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('ENDPOINT_LABEL_MISMATCH');
  });

  it('POST → 404 ENDPOINT_NOT_FOUND', async () => {
    fake.addRelation = async () => {
      throw new RelationEditNotFoundError('From node ... not found');
    };
    const res = await server.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { from: FROM, to: TO, type: 'OWNS' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ENDPOINT_NOT_FOUND');
  });

  it('DELETE /api/relations → 200 { deleted:true }', async () => {
    let received: DeleteRelationInput | undefined;
    fake.deleteRelation = async (input) => {
      received = input;
      return true;
    };
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/relations',
      payload: { from: FROM, to: TO, type: 'OWNS' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
    expect(received).toMatchObject({ from: FROM, to: TO, type: 'OWNS', actor: 'dev@shipit.local' });
  });

  it('DELETE → 204 when nothing matched (idempotent)', async () => {
    fake.deleteRelation = async () => false;
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/relations',
      payload: { from: FROM, to: TO, type: 'OWNS' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
  });

  it('DELETE → 409 CONNECTOR_EDGE', async () => {
    fake.deleteRelation = async () => {
      throw new RelationEditConflictError('Refusing to delete connector-owned OWNS edge');
    };
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/relations',
      payload: { from: FROM, to: TO, type: 'OWNS' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONNECTOR_EDGE');
  });

  it('DELETE → 400 INVALID_BODY for a malformed body', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/relations',
      payload: { from: FROM, to: TO }, // missing `type`
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_BODY');
  });

  it('503 MANUAL_EDIT_DISABLED when the service is not wired', async () => {
    const withRoutes = await createServer({ config: makeTestConfig(), neo4jService: fakeNeo4j });
    await withRoutes.ready();
    (withRoutes as unknown as { relationEditService: undefined }).relationEditService = undefined;
    const res = await withRoutes.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { from: FROM, to: TO, type: 'OWNS' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('MANUAL_EDIT_DISABLED');
    await withRoutes.close();
  });
});

// --- Kill-switch: manualWrite.enabled = false 403s with FEATURE_DISABLED.
describe('relations routes — kill-switch', () => {
  it('403 FEATURE_DISABLED when accessControl.manualWrite.enabled is false', async () => {
    const config: Config = makeTestConfig();
    config.accessControl.manualWrite.enabled = false;
    const server = await createServer({ config, neo4jService: fakeNeo4j });
    await server.ready();
    (server as unknown as { relationEditService: FakeService }).relationEditService = {
      addRelation: async () => ({ created: true }),
      deleteRelation: async () => true,
    };
    const res = await server.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { from: FROM, to: TO, type: 'OWNS' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FEATURE_DISABLED');
    await server.close();
  });
});

// --- Capability gating with auth ENABLED (real principals via session / token).
function buildAuthConfig(): Config {
  const base = makeTestConfig();
  return {
    ...base,
    accessControl: {
      ...base.accessControl,
      auth: {
        ...base.accessControl.auth,
        enabled: true,
        providers: {
          ...base.accessControl.auth.providers,
          oidc: {
            ...base.accessControl.auth.providers.oidc,
            enabled: true,
            issuerUrl: 'https://idp.example.com',
            clientId: 'oidc-test-client',
            clientSecretEnv: 'TEST_OIDC_CLIENT_SECRET',
            displayName: 'Example IdP',
          },
        },
        admins: ['admin@example.com'],
        allowList: [],
        session: { ...base.accessControl.auth.session, secure: false },
      },
    },
  };
}

function buildMockOidcProvider(): OidcProvider & {
  nextUserInfo: { sub: string; email: string; displayName: string };
} {
  const mock = {
    nextUserInfo: { sub: 'sub-default', email: 'member@example.com', displayName: 'Member' },
    async startAuthorization() {
      return {
        url: 'https://idp.example.com/authorize?stub=1',
        state: 'oidc-state-stub',
        codeVerifier: 'oidc-verifier-stub',
      };
    },
    async exchange() {
      return mock.nextUserInfo;
    },
  };
  return mock as unknown as OidcProvider & typeof mock;
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  if (!setCookie) return '';
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list.map((c) => c.split(';')[0]).join('; ');
}

describe('relations routes — capability gating (auth enabled)', () => {
  let server: FastifyInstance;
  let redis: Redis;
  let oidc: ReturnType<typeof buildMockOidcProvider>;

  const tokenService = {
    validate: async (plaintext: string) => {
      if (plaintext === 'good-token') {
        return { id: 'tok1', ownerEmail: 'bot@example.com', scopes: ['catalog:read'] };
      }
      return null;
    },
  } as unknown as TokenService;

  beforeAll(async () => {
    process.env.SHIPIT_SESSION_SECRET = SIGNING_SECRET;
    redis = new RedisMock() as unknown as Redis;
    oidc = buildMockOidcProvider();
    server = await createServer({
      config: buildAuthConfig(),
      redis,
      oidcProvider: oidc,
      tokenService,
      neo4jService: fakeNeo4j,
    });
    await server.ready();
    (server as unknown as { relationEditService: FakeService }).relationEditService = {
      addRelation: async () => ({ created: true }),
      deleteRelation: async () => true,
    };
  });
  afterAll(async () => {
    await server.close();
    delete process.env.SHIPIT_SESSION_SECRET;
  });

  async function loginAs(email: string, displayName: string): Promise<string> {
    oidc.nextUserInfo = { sub: `sub-${email}`, email, displayName };
    await server.inject({ method: 'GET', url: '/api/auth/login/oidc' });
    const callback = await server.inject({
      method: 'GET',
      url: '/api/auth/callback/oidc?code=any&state=oidc-state-stub',
    });
    return cookieHeader(callback.headers['set-cookie']);
  }

  it('member WITH graph:write succeeds (200)', async () => {
    const cookie = await loginAs('member@example.com', 'Member');
    const res = await server.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { from: FROM, to: TO, type: 'OWNS' },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it('unauthenticated request → 401 at the auth boundary', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { from: FROM, to: TO, type: 'OWNS' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('mcp-token principal lacking graph:write → 403 FORBIDDEN', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/relations',
      payload: { from: FROM, to: TO, type: 'OWNS' },
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('DELETE unauthenticated → 401 at the auth boundary', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/relations',
      payload: { from: FROM, to: TO, type: 'OWNS' },
    });
    expect(res.statusCode).toBe(401);
  });
});
