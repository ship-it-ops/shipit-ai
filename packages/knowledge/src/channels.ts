// The two Redis names the api-server and the knowledge-worker both use. They
// are a contract between two processes, so they are declared once, in the
// package both import. Their values are fixed: during a rolling deploy an
// api-server and a worker of different builds have to agree on them.

/** Pub/sub channel: documents were stored, index them now. */
export const KNOWLEDGE_WAKE_CHANNEL = 'shipit-knowledge-wake';

/** Key the worker refreshes while its index loop is alive; the status check reads it. */
export const KNOWLEDGE_WORKER_HEARTBEAT_KEY = 'shipit-knowledge-worker-heartbeat';
