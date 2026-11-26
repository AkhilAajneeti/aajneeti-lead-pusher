/**
 * Cloudflare Pages Function  ->  POST /api/lead
 *
 * Why this exists: the CRM API sends no CORS headers and answers OPTIONS
 * preflight with 400, so a browser can never POST to it directly. This runs
 * server-side on Cloudflare's edge, so there is no CORS and no bot challenge.
 *
 * Optional env vars (Pages > Settings > Environment variables):
 *   ACCESS_KEY   - if set, callers must send the same value in x-access-key.
 *                  Set this, or anyone who finds your URL can write to your CRM.
 *   UPSTREAM_URL - override the CRM endpoint (defaults to the one below).
 */

const UPSTREAM_DEFAULT = 'https://multiclientapi.aajneetiadvertising.com/';

const FIELDS = [
  'firstName', 'emailAddress', 'phoneNumber', 'addressCity',
  'cProject', 'cSubSource', 'cClientNomen', 'cProjectNomen',
];

const PHONE_RE = /^\+91[6-9]\d{9}$/;

/* Required, and kept in step with lib.js by hand: this file is a Worker and
   cannot import it. cProject, cProjectNomen and cClientNomen say which client
   and project a lead belongs to; without them the CRM cannot route it, so an
   incomplete lead is refused here as well as in the browser and the CLI. */
const REQUIRED = ['firstName', 'cProject', 'cProjectNomen', 'cClientNomen'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-access-key',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export function onRequestGet({ env }) {
  return json({
    ok: true,
    service: 'lead-uploader proxy',
    upstream: env.UPSTREAM_URL || UPSTREAM_DEFAULT,
    keyRequired: Boolean(env.ACCESS_KEY),
  });
}

export async function onRequestPost({ request, env }) {
  if (env.ACCESS_KEY && request.headers.get('x-access-key') !== env.ACCESS_KEY) {
    return json({ ok: false, error: 'Missing or wrong access key.' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Body is not valid JSON.' }, 400);
  }

  // Only ever forward the eight fields the CRM expects.
  const lead = {};
  for (const f of FIELDS) {
    lead[f] = typeof body[f] === 'string' ? body[f].trim() : '';
  }
  if (!lead.cSubSource) lead.cSubSource = 'Meta';

  // Server-side guard so bad rows can never reach the CRM.
  if (!PHONE_RE.test(lead.phoneNumber)) {
    return json({
      ok: false, skipped: true,
      error: 'phoneNumber must be +91 followed by 10 digits starting 6-9.',
    }, 422);
  }
  const missing = REQUIRED.filter((k) => !lead[k]);
  if (missing.length) {
    return json({
      ok: false, skipped: true,
      error: 'missing required: ' + missing.join(', '),
      missing,
    }, 422);
  }

  const upstream = env.UPSTREAM_URL || UPSTREAM_DEFAULT;
  let res, text;
  try {
    res = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(lead),
    });
    text = await res.text();
  } catch (e) {
    return json({ ok: false, error: 'CRM unreachable: ' + e.message }, 502);
  }

  return json(
    { ok: res.ok, status: res.status, response: text.slice(0, 300).trim() },
    res.ok ? 200 : 502,
  );
}
