// How store and find reach Qdrant: the same mcp-server-qdrant process settings, so both use the same embedding model.
export const QDRANT_URL = process.env.QDRANT_URL ?? 'http://localhost:6333';
export const QDRANT_COLLECTION = process.env.QDRANT_COLLECTION ?? 'docs';
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'sentence-transformers/all-MiniLM-L6-v2';
export const MCP_SERVER_QDRANT = process.env.MCP_SERVER_QDRANT ?? 'mcp-server-qdrant==0.8.1';

/** MCP server config for reinloop (`mcpServers` entry / `mcpKnowledge({ server })`). */
export const qdrantServer = {
  command: 'uvx',
  args: ['--python', '3.12', MCP_SERVER_QDRANT],
  env: { QDRANT_URL, COLLECTION_NAME: QDRANT_COLLECTION, EMBEDDING_MODEL },
  // The first start downloads the embedding model (about 90 MB).
  timeoutMs: 300_000,
};
