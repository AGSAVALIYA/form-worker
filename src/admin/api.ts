/** JSON API behind /admin/api/*, used by the admin UI. Every route requires admin auth. */
import {
  createForm,
  deleteEntry,
  deleteForm,
  getEntry,
  getForm,
  insertEntry,
  listEntries,
  listForms,
  now,
  setApiKeyHash,
  setSpam,
  updateForm,
  type Entry,
  type Form,
} from '../db';
import { newApiKey, sha256Hex } from '../lib/crypto';
import { HttpError, isEmail, json } from '../lib/http';
import { notifyEntry, sendMail, smtpConfigured } from '../notify';

const FORM_ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const MAX_LIST = 20;

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Expected a JSON object');
}

async function requireForm(env: Env, id: string): Promise<Form> {
  const record = await getForm(env.DB, id);
  if (!record) throw new HttpError(404, 'Form not found');
  return record.form;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be a list`);
  const items = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  if (items.length > MAX_LIST) throw new HttpError(400, `${label}: at most ${MAX_LIST} entries`);
  return items;
}

function origins(value: unknown): string[] {
  return stringList(value, 'Allowed origins').map((item) => {
    let url: URL;
    try {
      url = new URL(item);
    } catch {
      throw new HttpError(400, `"${item}" is not a valid origin, e.g. https://www.example.com`);
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new HttpError(400, `"${item}" must use https`);
    }
    return url.origin;
  });
}

function emails(value: unknown): string[] {
  const list = stringList(value, 'Notification emails');
  const bad = list.find((item) => !isEmail(item));
  if (bad) throw new HttpError(400, `"${bad}" is not a valid email address`);
  return list;
}

function applyChanges(form: Form, body: Record<string, unknown>): Form {
  const next = { ...form };
  if ('name' in body) {
    const name = String(body.name ?? '').trim();
    if (!name || name.length > 100) throw new HttpError(400, 'Name is required (up to 100 characters)');
    next.name = name;
  }
  if ('allowedOrigins' in body) next.allowedOrigins = origins(body.allowedOrigins);
  if ('notifyEmails' in body) next.notifyEmails = emails(body.notifyEmails);
  if ('redirectUrl' in body) {
    const value = String(body.redirectUrl ?? '').trim();
    if (value && !/^https:\/\/[^\s]+$/.test(value)) throw new HttpError(400, 'Redirect URL must start with https://');
    next.redirectUrl = value || null;
  }
  if ('requireTurnstile' in body) next.requireTurnstile = body.requireTurnstile === true;
  if ('spamThreshold' in body) {
    const threshold = Number(body.spamThreshold);
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) throw new HttpError(400, 'Spam threshold must be 0 (off) to 100');
    next.spamThreshold = threshold;
  }
  if ('enabled' in body) next.enabled = body.enabled === true;
  if ('retentionDays' in body) {
    const days = Number(body.retentionDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new HttpError(400, 'Retention must be 1 to 3650 days');
    next.retentionDays = days;
  }
  return next;
}

/** Spreadsheet apps execute cells starting with these characters as formulas. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

async function exportCsv(env: Env, form: Form): Promise<Response> {
  const entries: Entry[] = [];
  let cursor: { createdAt: string; id: string } | undefined;
  // Page through everything; forms here are small, and each page is bounded.
  for (;;) {
    const page = await listEntries(env.DB, form.id, 500, { view: 'all', cursor });
    entries.push(...page);
    if (page.length < 500) break;
    const last = page[page.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
  }

  const fieldKeys = [...new Set(entries.flatMap((entry) => Object.keys(entry.data)))];
  const metaKeys = [...new Set(entries.flatMap((entry) => Object.keys(entry.meta)))];
  const header = ['id', 'received', ...fieldKeys, ...metaKeys.map((key) => `meta.${key}`), 'spam', 'spam_score', 'notification'];
  const rows = entries.map((entry) => [
    entry.id,
    entry.createdAt,
    ...fieldKeys.map((key) => entry.data[key] ?? ''),
    ...metaKeys.map((key) => entry.meta[key] ?? ''),
    entry.isSpam ? 'yes' : 'no',
    String(entry.spamScore),
    entry.notifyStatus,
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');

  return new Response(`﻿${csv}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${form.id}-entries-${now().slice(0, 10)}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function handleAdminApi(
  request: Request,
  env: Env,
  path: string,
  user: { user: string; mode: string },
  origin: string,
): Promise<Response> {
  const method = request.method;
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);

  // GET /me
  if (method === 'GET' && path === '/me') {
    return json({ user: user.user, authMode: user.mode, smtpConfigured: smtpConfigured(env), smtpUser: env.SMTP_USER || null });
  }

  // /forms
  if (segments[0] === 'forms' && segments.length === 1) {
    if (method === 'GET') return json({ forms: await listForms(env.DB) });
    if (method === 'POST') {
      const body = await readJson(request);
      const id = String(body.id ?? '').trim().toLowerCase();
      const name = String(body.name ?? '').trim();
      if (!FORM_ID.test(id)) throw new HttpError(400, 'Form ID: 2–63 lowercase letters, numbers or hyphens');
      if (!name) throw new HttpError(400, 'Name is required');
      if (await getForm(env.DB, id)) throw new HttpError(409, 'A form with this ID already exists');
      const apiKey = newApiKey();
      await createForm(env.DB, id, name, await sha256Hex(apiKey));
      return json({ form: await requireForm(env, id), apiKey, endpoint: `${origin}/api/forms/${id}/submissions` }, { status: 201 });
    }
  }

  // /forms/:id and sub-resources
  if (segments[0] === 'forms' && segments.length >= 2) {
    const form = await requireForm(env, segments[1]);
    const rest = segments.slice(2).join('/');

    if (!rest) {
      if (method === 'GET') return json({ form, endpoint: `${origin}/api/forms/${form.id}/submissions` });
      if (method === 'PATCH') {
        const next = applyChanges(form, await readJson(request));
        await updateForm(env.DB, next);
        return json({ form: next });
      }
      if (method === 'DELETE') {
        await deleteForm(env.DB, form.id);
        return json({ ok: true });
      }
    }

    if (rest === 'rotate-key' && method === 'POST') {
      const apiKey = newApiKey();
      await setApiKeyHash(env.DB, form.id, await sha256Hex(apiKey));
      return json({ apiKey });
    }

    if (rest === 'entries' && method === 'GET') {
      const url = new URL(request.url);
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
      const before = url.searchParams.get('before');
      const beforeId = url.searchParams.get('beforeId');
      const view = url.searchParams.get('view');
      const entries = await listEntries(env.DB, form.id, limit, {
        view: view === 'spam' || view === 'all' ? view : 'inbox',
        search: (url.searchParams.get('q') ?? '').trim().slice(0, 100) || undefined,
        cursor: before && beforeId ? { createdAt: before, id: beforeId } : undefined,
      });
      return json({ entries, hasMore: entries.length === limit });
    }

    if (rest === 'entries' && method === 'POST') {
      // Manual entry, e.g. an enquiry taken by phone. Not emailed.
      const body = await readJson(request);
      const raw = body.data;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'data must be an object of field: value');
      const data = Object.fromEntries(
        Object.entries(raw as Record<string, unknown>)
          .map(([key, value]) => [key.trim().slice(0, 100), String(value ?? '').trim().slice(0, 10_000)] as const)
          .filter(([key]) => key),
      );
      if (Object.keys(data).length === 0) throw new HttpError(400, 'Add at least one field');
      const entry: Entry = {
        id: crypto.randomUUID(),
        formId: form.id,
        createdAt: now(),
        data,
        meta: { via: 'manual', addedBy: user.user },
        notifyStatus: 'skipped',
        notifyAttempts: 0,
        notifyError: 'Added manually',
        isSpam: false,
        spamScore: 0,
        spamReasons: [],
        contentHash: null,
      };
      await insertEntry(env.DB, entry);
      return json({ entry }, { status: 201 });
    }

    if (rest === 'entries.csv' && method === 'GET') return exportCsv(env, form);
  }

  // /entries/:id
  if (segments[0] === 'entries' && segments.length >= 2) {
    const entry = await getEntry(env.DB, segments[1]);
    if (!entry) throw new HttpError(404, 'Entry not found');

    if (segments.length === 2 && method === 'DELETE') {
      await deleteEntry(env.DB, entry.id);
      return json({ ok: true });
    }
    if (segments[2] === 'spam' && method === 'POST') {
      // Mark as spam / not spam. Rescuing an entry that was never emailed sends its notification now.
      const isSpam = (await readJson(request)).spam === true;
      await setSpam(env.DB, entry.id, isSpam);
      let status = entry.notifyStatus;
      if (!isSpam && entry.isSpam && entry.notifyStatus === 'skipped' && entry.notifyError === 'Filed as spam') {
        const form = await requireForm(env, entry.formId);
        status = await notifyEntry(env, form, { ...entry, isSpam: false }, `${origin}/admin#/forms/${encodeURIComponent(form.id)}`);
      }
      return json({ entry: await getEntry(env.DB, entry.id), status });
    }
    if (segments[2] === 'notify' && method === 'POST') {
      const form = await requireForm(env, entry.formId);
      const status = await notifyEntry(env, form, entry, `${origin}/admin#/forms/${encodeURIComponent(form.id)}`);
      return json({ entry: await getEntry(env.DB, entry.id), status });
    }
  }

  // POST /test-email { to }
  if (path === '/test-email' && method === 'POST') {
    const body = await readJson(request);
    const to = String(body.to ?? '').trim();
    if (!isEmail(to)) throw new HttpError(400, 'Enter a valid email address');
    if (!smtpConfigured(env)) throw new HttpError(400, 'SMTP is not configured (SMTP_USER / SMTP_PASS secrets)');
    try {
      await sendMail(env, {
        to: [to],
        subject: 'Form Worker: test email',
        text: `This is a test from Form Worker, sent by ${user.user}. Notifications are working.`,
        html: `<p>This is a test from Form Worker, sent by ${user.user.replace(/[<>&]/g, '')}.</p><p>Notifications are working.</p>`,
      });
    } catch (error) {
      throw new HttpError(502, `Sending failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return json({ ok: true });
  }

  throw new HttpError(404, 'Not found');
}
