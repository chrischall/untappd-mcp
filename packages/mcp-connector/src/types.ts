export interface LoginField {
  name: string;
  label: string;
  type?: 'text' | 'password';
}

export interface ConnectorAuth<Props> {
  /** Login-page branding, e.g. "Untappd". */
  service: string;
  fields: LoginField[];
  /** Verifies credentials and returns the OAuth props to store. Throws on bad creds. */
  login(fields: Record<string, string>, env: any): Promise<Props>;
  /** One-line note shown under the form. */
  privacyNote?: string;
  /** Brand accent as a hex color (e.g. "#FFC000") for the login page's button, focus ring, and tint. Optional — a neutral is used if absent. */
  accent?: string;
}

/**
 * Per-request context handed to each tool registrar alongside the server and
 * client, so a registrar can reach the Worker `env` (bindings) and the
 * authenticated user's OAuth `props` — e.g. to scope a Durable Object to the
 * logged-in user. Registrars that don't need it simply ignore the argument.
 */
export interface ConnectorContext<Props> {
  env: any;
  props: Props;
}

export interface ConnectorOptions<Props extends Record<string, unknown>, Client> {
  name: string;
  version: string;
  auth: ConnectorAuth<Props>;
  buildClient(props: Props, env: any): Client;
  tools: Array<(server: any, client: Client, ctx: ConnectorContext<Props>) => void>;
}
