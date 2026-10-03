import { LogLevel, WorkerMailer } from 'worker-mailer';
import { getEntry, getForm, recordNotification, type Entry, type Form } from './db';
import { escapeHtml, isEmail } from './lib/http';

export interface MailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
}

export function smtpConfigured(env: Env): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

/** Optional variable: only set to send from an address other than SMTP_USER, so it may be missing from `Env`. */
type OptionalSender = { MAIL_FROM_EMAIL?: string };

/**
 * The address notifications are sent from: MAIL_FROM_EMAIL when it is a valid
 * address, otherwise SMTP_USER. Set MAIL_FROM_EMAIL for providers whose SMTP
 * username is not an email address (ZeptoMail, SendGrid, Amazon SES, ...).
 */
export function senderEmail(env: Env): string {
  const from = ((env as Env & OptionalSender).MAIL_FROM_EMAIL ?? '').trim();
  return isEmail(from) ? from : env.SMTP_USER;
}

/** Sends one email through the configured SMTP server (Gmail by default). */
export async function sendMail(env: Env, message: MailMessage): Promise<void> {
  const port = Number(env.SMTP_PORT || 465);
  await WorkerMailer.send(
    {
      host: env.SMTP_HOST,
      port,
      // 465 is implicit TLS; 587 upgrades with STARTTLS.
      secure: port === 465,
      startTls: port !== 465,
      credentials: { username: env.SMTP_USER, password: env.SMTP_PASS },
      authType: ['plain', 'login'],
      logLevel: LogLevel.ERROR,
      socketTimeoutMs: 15_000,
      responseTimeoutMs: 15_000,
    },
    {
      // Gmail rewrites "from" to the signed-in account unless the address is one of its "Send mail as" aliases.
      from: { name: env.MAIL_FROM_NAME || 'Form Worker', email: senderEmail(env) },
      to: message.to,
      reply: message.replyTo,
      subject: message.subject.replace(/[\r\n]+/g, ' ').slice(0, 200),
      text: message.text,
      html: message.html,
    },
  );
}

const NAME_KEYS = ['fullName', 'full_name', 'name', 'firstName', 'first_name'];

function submitterName(entry: Entry): string | undefined {
  for (const key of NAME_KEYS) {
    if (entry.data[key]) return entry.data[key].slice(0, 80);
  }
  return undefined;
}

/** The first field that looks like the submitter's email, used as Reply-To. */
function submitterEmail(entry: Entry): string | undefined {
  for (const [key, value] of Object.entries(entry.data)) {
    if (/e-?mail/i.test(key) && isEmail(value)) return value;
  }
  return undefined;
}

export function buildNotification(form: Form, entry: Entry, adminUrl?: string): MailMessage {
  const who = submitterName(entry);
  const what = entry.meta.kind ? `new ${entry.meta.kind}` : 'new submission';
  const subject = `${form.name}: ${what}${who ? ` from ${who}` : ''}`;

  const fields = Object.entries(entry.data);
  const details = Object.entries(entry.meta).filter(([key]) => key !== 'kind');
  const received = new Date(entry.createdAt).toUTCString();

  const text = [
    `${form.name}: ${what}`,
    `Received: ${received}`,
    '',
    ...fields.map(([key, value]) => `${key}: ${value}`),
    '',
    ...details.map(([key, value]) => `(${key}: ${value})`),
    ...(adminUrl ? ['', `View in Form Worker: ${adminUrl}`] : []),
  ].join('\n');

  const row = (key: string, value: string) =>
    `<tr><th align="left" valign="top" style="padding:6px 12px 6px 0;color:#555;font-weight:600;white-space:nowrap">${escapeHtml(key)}</th>` +
    `<td style="padding:6px 0;white-space:pre-wrap">${escapeHtml(value)}</td></tr>`;

  const html = `<!doctype html><html><body style="font:15px/1.5 system-ui,sans-serif;color:#15222a">
<h2 style="font-size:18px;margin:0 0 4px">${escapeHtml(form.name)}: ${escapeHtml(what)}</h2>
<p style="margin:0 0 16px;color:#555">Received ${escapeHtml(received)}</p>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse">${fields.map(([k, v]) => row(k, v)).join('')}</table>
${details.length ? `<p style="margin:16px 0 0;color:#777;font-size:13px">${details.map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v)}`).join(' · ')}</p>` : ''}
${adminUrl ? `<p style="margin:16px 0 0"><a href="${escapeHtml(adminUrl)}">View in Form Worker</a></p>` : ''}
</body></html>`;

  return { to: form.notifyEmails, subject, text, html, replyTo: submitterEmail(entry) };
}

/**
 * Emails the form's notification list about an entry and records the outcome.
 * Never throws: the entry is already stored, so a failed email is retried later
 * by the scheduled job and shown as "failed" in the admin.
 */
export async function notifyEntry(env: Env, form: Form, entry: Entry, adminUrl?: string): Promise<Entry['notifyStatus']> {
  if (form.notifyEmails.length === 0) {
    await recordNotification(env.DB, entry.id, 'skipped', 'No notification addresses', false);
    return 'skipped';
  }
  if (!smtpConfigured(env)) {
    await recordNotification(env.DB, entry.id, 'skipped', 'SMTP is not configured', false);
    return 'skipped';
  }

  try {
    await sendMail(env, buildNotification(form, entry, adminUrl));
    await recordNotification(env.DB, entry.id, 'sent', null, true);
    return 'sent';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: 'notify_failed', form: form.id, entry: entry.id, error: message }));
    await recordNotification(env.DB, entry.id, 'failed', message.slice(0, 500), true);
    return 'failed';
  }
}

/** Body of a message on NOTIFY_QUEUE. The consumer reloads the entry, so only its id travels. */
export interface NotifyMessage {
  entryId: string;
  adminUrl?: string;
}

/**
 * Sends an entry's notification from the queue, so the SMTP work runs in its
 * own invocation instead of the submission request's. Sends inline when there
 * is nothing to send, when the queue is not bound (deploys from before it
 * existed), or when the queue refuses the message.
 */
export async function scheduleNotification(env: Env, form: Form, entry: Entry, adminUrl?: string): Promise<void> {
  if (env.NOTIFY_QUEUE && form.notifyEmails.length > 0 && smtpConfigured(env)) {
    try {
      await env.NOTIFY_QUEUE.send({ entryId: entry.id, adminUrl } satisfies NotifyMessage);
      return;
    } catch (error) {
      console.error(JSON.stringify({ event: 'queue_send_failed', entry: entry.id, error: String(error) }));
    }
  }
  await notifyEntry(env, form, entry, adminUrl);
}

/**
 * Queue consumer. Delivery is at least once, so an entry that is no longer
 * pending or failed (already sent, deleted, or marked as spam) is skipped.
 * A failed send is retried by the queue, then by the hourly job.
 */
export async function handleNotifyBatch(batch: MessageBatch<NotifyMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const entry = await getEntry(env.DB, message.body.entryId);
    const record = entry ? await getForm(env.DB, entry.formId) : null;
    if (!entry || !record || entry.isSpam || (entry.notifyStatus !== 'pending' && entry.notifyStatus !== 'failed')) {
      message.ack();
      continue;
    }
    const status = await notifyEntry(env, record.form, entry, message.body.adminUrl);
    if (status === 'failed') message.retry();
    else message.ack();
  }
}
