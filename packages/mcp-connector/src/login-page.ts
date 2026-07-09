import type { ConnectorAuth } from './types.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface RenderLoginPageOptions {
  error?: string;
  oauthReq?: unknown;
}

/**
 * Renders the login form for a connector's own service credentials.
 * Auth-agnostic: knows nothing about the shape of any particular service's
 * credentials beyond the field list it's handed.
 */
export function renderLoginPage<Props>(
  auth: ConnectorAuth<Props>,
  options: RenderLoginPageOptions = {},
): string {
  const { error, oauthReq } = options;
  const encodedOauthReq = oauthReq !== undefined ? btoa(JSON.stringify(oauthReq)) : '';

  const fieldsHtml = auth.fields
    .map((field) => {
      const type = field.type === 'password' ? 'password' : 'text';
      return `
        <label for="${escapeHtml(field.name)}">${escapeHtml(field.label)}</label>
        <input type="${type}" id="${escapeHtml(field.name)}" name="${escapeHtml(field.name)}" required />
      `;
    })
    .join('\n');

  const errorHtml = error
    ? `<p class="error" role="alert">${escapeHtml(error)}</p>`
    : '';

  const privacyHtml = auth.privacyNote
    ? `<p class="privacy-note">${escapeHtml(auth.privacyNote)}</p>`
    : '';

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Connect to ${escapeHtml(auth.service)}</title>
  </head>
  <body>
    <h1>Connect to ${escapeHtml(auth.service)}</h1>
    ${errorHtml}
    <form method="post">
      ${fieldsHtml}
      <input type="hidden" name="oauthReq" value="${escapeHtml(encodedOauthReq)}" />
      <button type="submit">Connect</button>
    </form>
    ${privacyHtml}
  </body>
</html>`;
}
