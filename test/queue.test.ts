import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry, Form } from '../src/db';

const send = vi.fn();
vi.mock('worker-mailer', () => ({ WorkerMailer: { send }, LogLevel: { ERROR: 3 } }));

// In-memory stand-ins for the D1 queries notify.ts uses.
const entries = new Map<string, Entry>();
const forms = new Map<string, Form>();
vi.mock('../src/db', () => ({
  getEntry: async (_db: unknown, id: string) => entries.get(id) ?? null,
  getForm: async (_db: unknown, id: string) => (forms.has(id) ? { form: forms.get(id), apiKeyHash: '' } : null),
  recordNotification: async (_db: unknown, id: string, status: Entry['notifyStatus'], error: string | null, attempted: boolean) => {
    const entry = entries.get(id)!;
    entries.set(id, { ...entry, notifyStatus: status, notifyError: error, notifyAttempts: entry.notifyAttempts + (attempted ? 1 : 0) });
  },
}));

const { handleNotifyBatch, scheduleNotification } = await import('../src/notify');

const form: Form = {
  id: 'acme',
  name: 'Acme',
  allowedOrigins: [],
  notifyEmails: ['owner@example.com'],
  redirectUrl: null,
  requireTurnstile: false,
  retentionDays: 365,
  spamThreshold: 50,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function addEntry(overrides: Partial<Entry> = {}): Entry {
  const entry: Entry = {
    id: 'e1',
    formId: form.id,
    createdAt: '2026-09-28T00:00:00.000Z',
    data: { name: 'Sam', message: 'Hello' },
    meta: {},
    notifyStatus: 'pending',
    notifyAttempts: 0,
    notifyError: null,
    isSpam: false,
    spamScore: 0,
    spamReasons: [],
    contentHash: null,
    ...overrides,
  };
  entries.set(entry.id, entry);
  return entry;
}

function env(queue?: { send: (body: unknown) => Promise<void> }) {
  return { SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_USER: 'me@example.com', SMTP_PASS: 'secret', NOTIFY_QUEUE: queue } as unknown as Env;
}

function message(entryId: string) {
  return { body: { entryId }, ack: vi.fn(), retry: vi.fn() };
}

const batch = (...messages: ReturnType<typeof message>[]) => ({ messages }) as unknown as MessageBatch<{ entryId: string }>;

beforeEach(() => {
  send.mockReset().mockResolvedValue(undefined);
  entries.clear();
  forms.clear();
  forms.set(form.id, form);
});

describe('scheduleNotification', () => {
  it('queues the email instead of sending it in the request', async () => {
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    await scheduleNotification(env(queue), form, addEntry(), 'https://forms.example.com/admin');
    expect(queue.send).toHaveBeenCalledWith({ entryId: 'e1', adminUrl: 'https://forms.example.com/admin' });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends inline when the queue is not bound', async () => {
    await scheduleNotification(env(), form, addEntry());
    expect(send).toHaveBeenCalledOnce();
    expect(entries.get('e1')?.notifyStatus).toBe('sent');
  });

  it('sends inline when the queue refuses the message', async () => {
    const queue = { send: vi.fn().mockRejectedValue(new Error('queue unavailable')) };
    await scheduleNotification(env(queue), form, addEntry());
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not use the queue when there is nobody to email', async () => {
    const queue = { send: vi.fn() };
    await scheduleNotification(env(queue), { ...form, notifyEmails: [] }, addEntry());
    expect(queue.send).not.toHaveBeenCalled();
    expect(entries.get('e1')?.notifyStatus).toBe('skipped');
  });
});

describe('handleNotifyBatch', () => {
  it('sends a pending entry and acknowledges the message', async () => {
    addEntry();
    const msg = message('e1');
    await handleNotifyBatch(batch(msg), env());
    expect(send).toHaveBeenCalledOnce();
    expect(msg.ack).toHaveBeenCalled();
    expect(entries.get('e1')?.notifyStatus).toBe('sent');
  });

  it('skips an entry that was already sent, so a redelivered message does not email twice', async () => {
    addEntry({ notifyStatus: 'sent' });
    const msg = message('e1');
    await handleNotifyBatch(batch(msg), env());
    expect(send).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalled();
  });

  it('skips entries that were deleted or marked as spam', async () => {
    addEntry({ id: 'spam', isSpam: true });
    const gone = message('deleted');
    const spam = message('spam');
    await handleNotifyBatch(batch(gone, spam), env());
    expect(send).not.toHaveBeenCalled();
    expect(gone.ack).toHaveBeenCalled();
    expect(spam.ack).toHaveBeenCalled();
  });

  it('asks the queue to retry when the email fails', async () => {
    send.mockRejectedValue(new Error('421 try again later'));
    addEntry();
    const msg = message('e1');
    await handleNotifyBatch(batch(msg), env());
    expect(msg.retry).toHaveBeenCalled();
    expect(msg.ack).not.toHaveBeenCalled();
    expect(entries.get('e1')).toMatchObject({ notifyStatus: 'failed', notifyAttempts: 1 });
  });
});
