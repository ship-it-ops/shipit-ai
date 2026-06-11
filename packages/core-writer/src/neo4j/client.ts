import neo4j, { type Driver, type Session, type ManagedTransaction } from 'neo4j-driver';
import type { CoreWriterConfig } from '../config.js';

export class Neo4jClient {
  private driver: Driver | null = null;
  // Session default, remembered from connect(). Newer Aura tiers name the
  // database after the instance ID (e.g. `8a63b716`) and have NO db named
  // `neo4j` — a hard-coded fallback here means DatabaseNotFound on boot.
  // config.neo4j.database carries NEO4J_DATABASE from the pod env.
  private defaultDatabase = 'neo4j';

  async connect(config: CoreWriterConfig['neo4j']): Promise<void> {
    this.driver = neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password));
    this.defaultDatabase = config.database ?? 'neo4j';
    // Verify connectivity
    await this.driver.verifyConnectivity();
  }

  getSession(database?: string): Session {
    if (!this.driver) {
      throw new Error('Neo4j client not connected. Call connect() first.');
    }
    return this.driver.session({ database: database ?? this.defaultDatabase });
  }

  async executeWrite<T>(fn: (tx: ManagedTransaction) => Promise<T>, database?: string): Promise<T> {
    const session = this.getSession(database);
    try {
      return await session.executeWrite(fn);
    } finally {
      await session.close();
    }
  }

  async executeRead<T>(fn: (tx: ManagedTransaction) => Promise<T>, database?: string): Promise<T> {
    const session = this.getSession(database);
    try {
      return await session.executeRead(fn);
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }
}
