// Phase 2: Team Dashboard routes.
// GET /api/teams           -> list teams with owned/member/on-call counts
// GET /api/teams/:id       -> per-team detail with services, repos, members, on-call
import type { FastifyPluginAsync } from 'fastify';
import { TeamService } from '../services/team-service.js';
import type { Neo4jService } from '../services/neo4j-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    neo4jService: Neo4jService;
  }
}

const teamsRoutes: FastifyPluginAsync = async (server) => {
  const service = new TeamService(server.neo4jService);

  server.get('/', async () => service.listTeams());

  server.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const id = decodeURIComponent(request.params.id);
    const team = await service.getTeam(id);
    if (!team) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `Team ${id} not found` },
      });
    }
    return team;
  });
};

export default teamsRoutes;
