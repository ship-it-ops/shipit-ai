// GET /api/config/export — download the merged raw config (placeholders
// preserved, secrets scrubbed) for committing as the deployment's next
// seed config. Admin-only: the export reveals instance-wide wiring.
import type { FastifyInstance } from 'fastify';
import { ConfigExportService } from '../services/config-export-service.js';

export async function configExportRoutes(server: FastifyInstance): Promise<void> {
  server.get('/export', async (request, reply) => {
    if (request.ctx.user.role !== 'admin') {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Admin role required.' },
      });
    }
    const paths = server.configPaths;
    if (!paths) {
      return reply.status(503).send({
        error: {
          code: 'CONFIG_EXPORT_DISABLED',
          message: 'Config export is not wired on this deployment.',
        },
      });
    }
    const body = new ConfigExportService(paths).buildExport();
    return reply
      .type('application/x-yaml; charset=utf-8')
      .header('content-disposition', 'attachment; filename="shipit.config.yaml"')
      .send(body);
  });
}
