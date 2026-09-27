export interface Form {
  id: string;
  name: string;
  allowedOrigins: string[];
  notifyEmails: string[];
  redirectUrl: string | null;
  requireTurnstile: boolean;
  retentionDays: number;
  /** 0 = spam filter off; otherwise the score at which entries are filed as spam. */
  spamThreshold: number;
  enabled: boolean;
  createdAt: string;
}

export type NotifyStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface Entry {
  id: string;
  formId: string;
  createdAt: string;
  data: Record<string, string>;
  meta: Record<string, string>;
  notifyStatus: NotifyStatus;
  notifyAttempts: number;
  notifyError: string | null;
  isSpam: boolean;
  spamScore: number;
  spamReasons: string[];
  contentHash: string | null;
}

interface FormRow {
  id: string;
  name: string;
  api_key_hash: string;
  allowed_origins: string;
  notify_emails: string;
  redirect_url: string | null;
  require_turnstile: number;
  retention_days: number;
  spam_threshold: number;
  enabled: number;
  created_at: string;
}

interface EntryRow {
  id: string;
  form_id: string;
  created_at: string;
  data: string;
  meta: string;
  notify_status: NotifyStatus;
  notify_attempts: number;
  notify_error: string | null;
  is_spam: number;
  spam_score: number;
  spam_reasons: string;
  content_hash: string | null;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toForm(row: FormRow): Form {
  return {
    id: row.id,
    name: row.name,
    allowedOrigins: parseJson<string[]>(row.allowed_origins, []),
    notifyEmails: parseJson<string[]>(row.notify_emails, []),
    redirectUrl: row.redirect_url,
    requireTurnstile: row.require_turnstile === 1,
    retentionDays: row.retention_days,
    spamThreshold: row.spam_threshold,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

function toEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    formId: row.form_id,
    createdAt: row.created_at,
    data: parseJson<Record<string, string>>(row.data, {}),
    meta: parseJson<Record<string, string>>(row.meta, {}),
    notifyStatus: row.notify_status,
    notifyAttempts: row.notify_attempts,
    notifyError: row.notify_error,
    isSpam: row.is_spam === 1,
    spamScore: row.spam_score,
    spamReasons: parseJson<string[]>(row.spam_reasons, []),
    contentHash: row.content_hash,
  };
}

export const now = () => new Date().toISOString();

// ── Forms ────────────────────────────────────────────────────────────────────

export async function getForm(db: D1Database, id: string): Promise<{ form: Form; apiKeyHash: string } | null> {
  const row = await db.prepare('SELECT * FROM forms WHERE id = ?').bind(id).first<FormRow>();
  return row ? { form: toForm(row), apiKeyHash: row.api_key_hash } : null;
}

export interface FormSummary extends Form {
  /** Entries not marked as spam. */
  entryCount: number;
  spamCount: number;
  last7Days: number;
  lastEntryAt: string | null;
}

export async function listForms(db: D1Database): Promise<FormSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT f.*,
         COALESCE(SUM(e.is_spam = 0), 0) AS entry_count,
         COALESCE(SUM(e.is_spam = 1), 0) AS spam_count,
         COALESCE(SUM(e.is_spam = 0 AND e.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')), 0) AS last_7_days,
         MAX(CASE WHEN e.is_spam = 0 THEN e.created_at END) AS last_entry_at
       FROM forms f LEFT JOIN entries e ON e.form_id = f.id
       GROUP BY f.id ORDER BY f.name COLLATE NOCASE`,
    )
    .all<FormRow & { entry_count: number; spam_count: number; last_7_days: number; last_entry_at: string | null }>();
  return results.map((row) => ({
    ...toForm(row),
    entryCount: row.entry_count,
    spamCount: row.spam_count,
    last7Days: row.last_7_days,
    lastEntryAt: row.last_entry_at,
  }));
}

export async function createForm(db: D1Database, id: string, name: string, apiKeyHash: string): Promise<void> {
  await db
    .prepare('INSERT INTO forms (id, name, api_key_hash, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, name, apiKeyHash, now())
    .run();
}

export async function updateForm(db: D1Database, form: Form): Promise<void> {
  await db
    .prepare(
      `UPDATE forms SET name = ?, allowed_origins = ?, notify_emails = ?, redirect_url = ?,
       require_turnstile = ?, retention_days = ?, spam_threshold = ?, enabled = ? WHERE id = ?`,
    )
    .bind(
      form.name,
      JSON.stringify(form.allowedOrigins),
      JSON.stringify(form.notifyEmails),
      form.redirectUrl,
      form.requireTurnstile ? 1 : 0,
      form.retentionDays,
      form.spamThreshold,
      form.enabled ? 1 : 0,
      form.id,
    )
    .run();
}

export async function setApiKeyHash(db: D1Database, id: string, apiKeyHash: string): Promise<void> {
  await db.prepare('UPDATE forms SET api_key_hash = ? WHERE id = ?').bind(apiKeyHash, id).run();
}

export async function deleteForm(db: D1Database, id: string): Promise<void> {
  // Entries are removed by ON DELETE CASCADE; deleted explicitly too in case foreign keys are off.
  await db.batch([
    db.prepare('DELETE FROM entries WHERE form_id = ?').bind(id),
    db.prepare('DELETE FROM forms WHERE id = ?').bind(id),
  ]);
}

// ── Entries ──────────────────────────────────────────────────────────────────

export async function insertEntry(db: D1Database, entry: Entry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO entries (id, form_id, created_at, data, meta, notify_status, notify_attempts, notify_error,
         is_spam, spam_score, spam_reasons, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      entry.id,
      entry.formId,
      entry.createdAt,
      JSON.stringify(entry.data),
      JSON.stringify(entry.meta),
      entry.notifyStatus,
      entry.notifyAttempts,
      entry.notifyError,
      entry.isSpam ? 1 : 0,
      entry.spamScore,
      JSON.stringify(entry.spamReasons),
      entry.contentHash,
    )
    .run();
}

export async function getEntry(db: D1Database, id: string): Promise<Entry | null> {
  const row = await db.prepare('SELECT * FROM entries WHERE id = ?').bind(id).first<EntryRow>();
  return row ? toEntry(row) : null;
}

export interface EntryFilter {
  /** inbox = not spam (default), spam = spam only, all = both. */
  view?: 'inbox' | 'spam' | 'all';
  /** Case-insensitive text search across all field values. */
  search?: string;
  cursor?: { createdAt: string; id: string };
}

/** Newest first. Pass the last entry's `createdAt` and `id` as the cursor to get the next page. */
export async function listEntries(db: D1Database, formId: string, limit: number, filter: EntryFilter = {}): Promise<Entry[]> {
  const where = ['form_id = ?'];
  const params: (string | number)[] = [formId];

  if (filter.view === 'spam') where.push('is_spam = 1');
  else if (filter.view !== 'all') where.push('is_spam = 0');

  if (filter.search) {
    // Escape LIKE wildcards so the search is literal.
    where.push("data LIKE ? ESCAPE '\\'");
    params.push(`%${filter.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`);
  }
  if (filter.cursor) {
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(filter.cursor.createdAt, filter.cursor.createdAt, filter.cursor.id);
  }

  const { results } = await db
    .prepare(`SELECT * FROM entries WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...params, limit)
    .all<EntryRow>();
  return results.map(toEntry);
}

/** True if the same content was submitted to this form in the last 24 hours. */
export async function hasRecentDuplicate(db: D1Database, formId: string, contentHash: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM entries WHERE form_id = ? AND content_hash = ?
       AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') LIMIT 1`,
    )
    .bind(formId, contentHash)
    .first();
  return row !== null;
}

export async function setSpam(db: D1Database, id: string, isSpam: boolean): Promise<void> {
  await db.prepare('UPDATE entries SET is_spam = ? WHERE id = ?').bind(isSpam ? 1 : 0, id).run();
}

export async function deleteEntry(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM entries WHERE id = ?').bind(id).run();
  return result.meta.changes > 0;
}

export async function recordNotification(
  db: D1Database,
  id: string,
  status: NotifyStatus,
  error: string | null,
  attempted: boolean,
): Promise<void> {
  await db
    .prepare('UPDATE entries SET notify_status = ?, notify_error = ?, notify_attempts = notify_attempts + ? WHERE id = ?')
    .bind(status, error, attempted ? 1 : 0, id)
    .run();
}

/** Entries whose notification failed, or never completed, and are worth another try. */
export async function entriesToRetry(db: D1Database, maxAttempts: number, limit: number): Promise<Entry[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM entries
       WHERE notify_status IN ('pending', 'failed') AND is_spam = 0 AND notify_attempts < ?
         AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-5 minutes')
         AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days')
       ORDER BY created_at LIMIT ?`,
    )
    .bind(maxAttempts, limit)
    .all<EntryRow>();
  return results.map(toEntry);
}

/** Deletes entries older than their form's retention period. Returns the number removed. */
export async function purgeExpiredEntries(db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `DELETE FROM entries WHERE created_at < (
         SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || f.retention_days || ' days')
         FROM forms f WHERE f.id = entries.form_id
       )`,
    )
    .run();
  return result.meta.changes;
}
