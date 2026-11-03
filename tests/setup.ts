import { vi } from 'vitest';

// src/client.ts loads the repo's .env on import. A developer's real credentials
// would then change what the suite sees (a configured username switches on the
// favorites lookup, for one), so tests never load it. Done here rather than in
// src/ so the server reads no test-only env var.
vi.mock('@chrischall/mcp-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@chrischall/mcp-utils')>()),
  loadDotenvSafely: async () => undefined,
}));
