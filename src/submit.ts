/**
 * Public endpoint: POST /api/forms/<formId>/submissions
 *
 * Two ways to submit:
 * - Server to server (e.g. a Pages Function): `Authorization: Bearer <api key>`.
 * - From a browser: the page's origin must be in the form's allowed origins,
 *   and a Turnstile token is required if the form asks for one.
 *
 * Accepts JSON, urlencoded or multipart bodies (files are ignored). A JSON
 * body shaped `{ fields: {...}, ...other }` stores `fields` as the entry and
 * the other top-level values (kind, sourcePage, …) as metadata.
 *
 * Fields starting with `_` are control fields and are not stored:
 * `_gotcha` is a honeypot, `_redirect` a post-submit redirect for plain HTML forms.
 */
import { getForm, hasRecentDuplicate, insertEntry, now, type Entry, type Form } from './db';
import { apiKeyMatches, sha256Hex } from './lib/crypto';
import { escapeHtml, HttpError, json, readBodyLimited } from './lib/http';
import { scheduleNotification } from './notify';
import { classifySubmission } from './spam';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_FIELDS = 100;
const MAX_KEY_LENGTH = 100;
const MAX_VALUE_LENGTH = 10_000;
const TURNSTILE_FIELD = 'cf-turnstile-response';

type Parsed = Record<string, unknown>;

function corsHeaders(origin: string): Record<string, string> {
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

async function parseBody(request: Request, bytes: Uint8Array): Promise<Parsed> {
  const type = (request.headers.get('Content-Type') ?? '').toLowerCase();
  const text = () => new TextDecoder().decode(bytes);

  if (type.includes('application/json')) {
    let value: unknown;
    try {
      value = JSON.parse(text());
    } catch {
      throw new HttpError(400, 'Body is not valid JSON');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'JSON body must be an object');
    return value as Parsed;
  }

  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await new Response(bytes, { headers: { 'Content-Type': type } }).formData();
    const out: Record<string, string> = {};
    for (const [key, value] of form) {
      if (typeof value !== 'string') continue; // files are not stored
      out[key] = key in out ? `${out[key]}, ${value}` : value;
    }
    return out;
  }

  throw new HttpError(415, 'Use a JSON, urlencoded or multipart body');
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(', ');
  return JSON.stringify(value);
}

function clean(source: Parsed, into: Record<string, string>, control: Record<string, string>) {
  for (const [rawKey, rawValue] of Object.entries(source)) {
    const key = rawKey.trim().slice(0, MAX_KEY_LENGTH);
    if (!key) continue;
    if (key.startsWith('_') || key === TURNSTILE_FIELD) {
      control[key] = toText(rawValue);
      continue;
    }
    if (Object.keys(into).length >= MAX_FIELDS) break;
    into[key] = toText(rawValue).slice(0, MAX_VALUE_LENGTH);
  }
}

function normalise(parsed: Parsed) {
  const data: Record<string, string> = {};
  const meta: Record<string, string> = {};
  const control: Record<string, string> = {};

  const fields = parsed.fields;
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    clean(fields as Parsed, data, control);
    const rest = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'fields'));
    clean(rest, meta, control);
  } else {
    clean(parsed, data, control);
  }
  return { data, meta, control };
}

/** Optional secret: only set when a form requires Turnstile, so it may be missing from `Env`. */
type OptionalSecrets = { TURNSTILE_SECRET_KEY?: string };

async function verifyTurnstile(env: Env, token: string, ip: string | null): Promise<boolean> {
  const secret = (env as Env & OptionalSecrets).TURNSTILE_SECRET_KEY;
  if (!token || !secret) return false;
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  if (!response.ok) return false;
  const result = await response.json<{ success?: boolean }>();
  return result.success === true;
}

/** Only redirect to the form's configured URL or to a page on an allowed origin. */
function redirectTarget(form: Form, requested: string | undefined): string | null {
  if (requested) {
    try {
      const url = new URL(requested);
      if (form.allowedOrigins.includes(url.origin)) return url.toString();
    } catch {
      // ignore malformed values
    }
  }
  return form.redirectUrl;
}

function thankYouPage(form: Form): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Thank you</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:36rem;margin:0 auto;padding:3rem 1rem;color:#15222a}</style></head>
<body><h1>Thank you</h1><p>Your submission to ${escapeHtml(form.name)} has been received.</p><p><a href="javascript:history.back()">Go back</a></p></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export async function handleSubmission(request: Request, env: Env, ctx: ExecutionContext, formId: string): Promise<Response> {
  const origin = request.headers.get('Origin');
  const record = await getForm(env.DB, formId);
  if (!record || !record.form.enabled) return json({ ok: false, error: 'Form not found' }, { status: 404 });

  const { form, apiKeyHash } = record;
  const originAllowed = origin !== null && form.allowedOrigins.includes(origin);
  const cors = originAllowed && origin ? corsHeaders(origin) : {};

  if (request.method === 'OPTIONS') {
    if (!originAllowed) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type, Accept',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, { status: 405, headers: { Allow: 'POST, OPTIONS' } });

  try {
    // 1. Who is submitting?
    const authorization = request.headers.get('Authorization');
    const viaApiKey = authorization?.startsWith('Bearer ') ?? false;
    if (viaApiKey) {
      if (!(await apiKeyMatches(authorization!.slice(7).trim(), apiKeyHash))) throw new HttpError(401, 'Invalid API key');
    } else if (!originAllowed) {
      throw new HttpError(403, 'This website is not allowed to submit to this form');
    }

    // 2. What was submitted?
    const parsed = await parseBody(request, await readBodyLimited(request, MAX_BODY_BYTES));
    const { data, meta, control } = normalise(parsed);
    const accept = request.headers.get('Accept') ?? '';
    const wantsPage = !viaApiKey && !accept.includes('application/json') && accept.includes('text/html');

    // Honeypot: pretend it worked so bots learn nothing.
    if (control._gotcha) {
      const target = wantsPage ? redirectTarget(form, control._redirect) : null;
      if (wantsPage) return target ? Response.redirect(target, 303) : thankYouPage(form);
      return json({ ok: true }, { headers: cors });
    }

    if (!viaApiKey && form.requireTurnstile) {
      const passed = await verifyTurnstile(env, control[TURNSTILE_FIELD] ?? '', request.headers.get('CF-Connecting-IP'));
      if (!passed) throw new HttpError(422, 'Spam check failed. Please try again.');
    }
    if (Object.keys(data).length === 0) throw new HttpError(400, 'No fields were submitted');

    // 3. Classify. Spam is kept (so it can be reviewed) but never emailed, and
    //    the sender gets the same success response either way.
    const contentHash = await sha256Hex(JSON.stringify(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))));
    const duplicate = await hasRecentDuplicate(env.DB, form.id, contentHash);
    const verdict = classifySubmission(data, { threshold: form.spamThreshold, duplicate });

    // 4. Store first, then queue the email so SMTP never runs in this request.
    const entry: Entry = {
      id: crypto.randomUUID(),
      formId: form.id,
      createdAt: now(),
      data,
      meta: { ...meta, via: viaApiKey ? 'api' : 'browser', ...(origin ? { origin } : {}) },
      notifyStatus: verdict.isSpam ? 'skipped' : 'pending',
      notifyAttempts: 0,
      notifyError: verdict.isSpam ? 'Filed as spam' : null,
      isSpam: verdict.isSpam,
      spamScore: verdict.score,
      spamReasons: verdict.reasons,
      contentHash,
    };
    await insertEntry(env.DB, entry);
    if (!verdict.isSpam) {
      const adminUrl = `${new URL(request.url).origin}/admin#/forms/${encodeURIComponent(form.id)}`;
      ctx.waitUntil(scheduleNotification(env, form, entry, adminUrl));
    }

    if (wantsPage) {
      const target = redirectTarget(form, control._redirect);
      return target ? Response.redirect(target, 303) : thankYouPage(form);
    }
    return json({ ok: true, id: entry.id }, { status: 201, headers: cors });
  } catch (error) {
    if (error instanceof HttpError) return json({ ok: false, error: error.message }, { status: error.status, headers: cors });
    console.error(JSON.stringify({ event: 'submission_error', form: formId, error: String(error) }));
    return json({ ok: false, error: 'Something went wrong' }, { status: 500, headers: cors });
  }
}
