import type { FastifyPluginAsync } from 'fastify';

const startTime = Date.now();

const healthRoutes: FastifyPluginAsync = async (server) => {
  server.get('/health', async () => {
    return {
      status: 'ok',
      // 'setup' = first-run setup mode (wizard-only surface). Additive:
      // the k8s readiness probe only checks the 200; the web-UI reads
      // this field to route users to /setup vs /login.
      mode: server.setupMode ? 'setup' : 'active',
      version: '0.1.0',
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };
  });
};

export default healthRoutes;
