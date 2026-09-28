import { entriesToRetry, getForm, purgeExpiredEntries } from './db';
import { notifyEntry, type NotifyMessage } from './notify';

const MAX_ATTEMPTS = 5;
/** Queued retries each get their own invocation, so more fit in one run. */
const QUEUED_RETRIES_PER_RUN = 25;
/** Inline retries share this run's CPU budget, so keep them few. */
const INLINE_RETRIES_PER_RUN = 5;

/** Scheduled job: delete expired entries, then retry notifications that failed. */
export async function runMaintenance(env: Env): Promise<void> {
  const purged = await purgeExpiredEntries(env.DB);

  const limit = env.NOTIFY_QUEUE ? QUEUED_RETRIES_PER_RUN : INLINE_RETRIES_PER_RUN;
  const entries = await entriesToRetry(env.DB, MAX_ATTEMPTS, limit);
  let retried = 0;

  if (env.NOTIFY_QUEUE && entries.length > 0) {
    await env.NOTIFY_QUEUE.sendBatch(entries.map((entry) => ({ body: { entryId: entry.id } satisfies NotifyMessage })));
    retried = entries.length;
  } else {
    for (const entry of entries) {
      const record = await getForm(env.DB, entry.formId);
      if (!record) continue;
      // Sequential on purpose: one SMTP connection at a time.
      await notifyEntry(env, record.form, entry);
      retried += 1;
    }
  }

  console.log(JSON.stringify({ event: 'maintenance', purged, retried }));
}
