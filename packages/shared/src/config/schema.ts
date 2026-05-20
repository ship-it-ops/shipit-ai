import { z } from 'zod';

const integrationsSchema = z.object({
  pagerduty: z.object({
    subdomain: z.string().nullable().default(null),
  }),
  datadog: z.object({
    site: z.string().nullable().default(null),
  }),
  github: z.object({
    org: z.string().nullable().default(null),
  }),
  slack: z.object({
    workspace: z.string().nullable().default(null),
    channelPrefix: z.string().default('team-'),
  }),
  kubernetes: z.object({
    consoleUrlTemplate: z.string().nullable().default(null),
  }),
});

const devUserSchema = z
  .object({
    firstName: z.string(),
    lastName: z.string(),
    email: z.string(),
    role: z.string(),
    team: z.string(),
    joinedAt: z.string(),
    capabilities: z.array(z.string()),
  })
  .optional();

export const configSchema = z.object({
  backend: z.object({
    neo4j: z.object({
      uri: z.string(),
      user: z.string(),
      password: z.string(),
    }),
    redis: z.object({
      url: z.string(),
    }),
    api: z.object({
      port: z.number().int().positive(),
    }),
    schema: z.object({
      path: z.string(),
    }),
    cypherQuery: z.object({
      timeoutMs: z.number().int().positive(),
      rowLimit: z.number().int().positive(),
    }),
    reconciliation: z.object({
      threshold: z.number().min(0).max(1),
    }),
    mcp: z.object({
      apiKeySecret: z.string().nullable().default(null),
      rateLimits: z.object({
        graphQueryPerDay: z.number().int().positive(),
        rowLimit: z.number().int().positive(),
        hopLimit: z.number().int().positive(),
        queryTimeoutMs: z.number().int().positive(),
      }),
    }),
  }),
  frontend: z.object({
    api: z.object({
      url: z.string(),
    }),
    devUser: devUserSchema,
    integrations: integrationsSchema,
  }),
});

export type Config = z.infer<typeof configSchema>;
