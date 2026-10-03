import { describe, expect, it, vi } from 'vitest';

// worker-mailer opens TCP sockets through the Workers runtime; not needed to build messages.
vi.mock('worker-mailer', () => ({ WorkerMailer: {}, LogLevel: { ERROR: 3 } }));

const { buildNotification, senderEmail } = await import('../src/notify');
import type { Entry, Form } from '../src/db';

const form: Form = {
  id: 'acme-bakery',
  name: 'Acme Bakery',
  allowedOrigins: [],
  notifyEmails: ['owner@example.com', 'team@example.com'],
  redirectUrl: null,
  requireTurnstile: false,
  retentionDays: 365,
  spamThreshold: 50,
  enabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function entry(data: Record<string, string>, meta: Record<string, string> = {}): Entry {
  return {
    id: 'e1',
    formId: form.id,
    createdAt: '2026-09-27T12:00:00.000Z',
    data,
    meta,
    notifyStatus: 'pending',
    notifyAttempts: 0,
    notifyError: null,
    isSpam: false,
    spamScore: 0,
    spamReasons: [],
    contentHash: null,
  };
}

describe('buildNotification', () => {
  it('addresses every notification email and replies to the sender', () => {
    const message = buildNotification(form, entry({ name: 'Sam Lee', email: 'sam@example.com', message: 'Hello' }));
    expect(message.to).toEqual(['owner@example.com', 'team@example.com']);
    expect(message.replyTo).toBe('sam@example.com');
    expect(message.subject).toBe('Acme Bakery: new submission from Sam Lee');
  });

  it('uses the submission kind in the subject', () => {
    const message = buildNotification(form, entry({ fullName: 'Sam Lee' }, { kind: 'enquiry' }));
    expect(message.subject).toBe('Acme Bakery: new enquiry from Sam Lee');
  });

  it('escapes submitted HTML', () => {
    const message = buildNotification(form, entry({ '<b>key</b>': '<script>alert(1)</script>' }));
    expect(message.html).not.toContain('<script>');
    expect(message.html).not.toContain('<b>key</b>');
    expect(message.html).toContain('&#60;script&#62;');
  });

  it('does not use an invalid address as Reply-To', () => {
    const message = buildNotification(form, entry({ email: 'not an email' }));
    expect(message.replyTo).toBeUndefined();
  });

  it('includes a link to the admin when given', () => {
    const message = buildNotification(form, entry({ name: 'Sam' }), 'https://forms.example.com/admin#/forms/acme-bakery');
    expect(message.text).toContain('https://forms.example.com/admin#/forms/acme-bakery');
    expect(message.html).toContain('href="https://forms.example.com/admin#/forms/acme-bakery"');
  });
});

describe('senderEmail', () => {
  const env = (vars: Record<string, string>) => ({ SMTP_USER: 'me@example.com', ...vars }) as unknown as Env;

  it('defaults to the SMTP username', () => {
    expect(senderEmail(env({}))).toBe('me@example.com');
  });

  it('uses MAIL_FROM_EMAIL when set', () => {
    expect(senderEmail(env({ SMTP_USER: 'emailapikey', MAIL_FROM_EMAIL: ' noreply@example.com ' }))).toBe('noreply@example.com');
  });

  it('ignores an invalid MAIL_FROM_EMAIL', () => {
    expect(senderEmail(env({ MAIL_FROM_EMAIL: 'not an email' }))).toBe('me@example.com');
  });
});
