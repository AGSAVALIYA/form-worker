import { entriesToRetry, getForm, purgeExpiredEntries } from './db';
import { notifyEntry } from './notify';

const MAX_ATTEMPTS = 5;
/** Kept small so one run stays well inside the free plan's limits. */
const RETRIES_PER_RUN = 5;

/** Scheduled job: delete expired entries, then retry notifications that failed. */
export async function runMaintenance(env: Env): Promise<void> {
  const purged = await purgeExpiredEntries(env.DB);

  let retried = 0;
  for (const entry of await entriesToRetry(env.DB, MAX_ATTEMPTS, RETRIES_PER_RUN)) {
    const record = await getForm(env.DB, entry.formId);
    if (!record) continue;
    // Sequential on purpose: one SMTP connection at a time.
    await notifyEntry(env, record.form, entry);
    retried += 1;
  }

  console.log(JSON.stringify({ event: 'maintenance', purged, retried }));
}
