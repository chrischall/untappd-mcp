import type { ConnectorAuth } from '@chrischall/mcp-connector';
import { xauthLogin } from './client.js';

/**
 * OAuth props stored per user by the Cloudflare connector's OAuth provider.
 * The index signature satisfies `createConnector`'s
 * `Props extends Record<string, unknown>` constraint.
 */
export interface UntappdProps {
  token: string;
  username: string;
  [key: string]: unknown;
}

/**
 * `ConnectorAuth` for the Untappd remote connector: the login page collects
 * the user's own Untappd username/password, exchanges them for an access
 * token via the same xauth flow the stdio server uses (`xauthLogin` in
 * `client.js`), and stores `{ token, username }` as the OAuth props that
 * `worker.ts`'s `buildClient` turns into a per-user `UntappdClient`.
 */
export const untappdAuth: ConnectorAuth<UntappdProps> = {
  service: 'Untappd',
  accent: '#FFC000',
  privacyNote:
    'Your password signs you in once and is not stored — only an access token is kept to make requests on your behalf.',
  fields: [
    { name: 'username', label: 'Untappd username or email' },
    { name: 'password', label: 'Untappd password', type: 'password' },
  ],
  async login(fields, env) {
    const token = await xauthLogin({
      username: fields.username,
      password: fields.password,
      clientId: env.UNTAPPD_CLIENT_ID,
      clientSecret: env.UNTAPPD_CLIENT_SECRET,
    });
    return { token, username: fields.username };
  },
};
