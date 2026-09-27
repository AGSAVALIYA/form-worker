import { describe, expect, it } from 'vitest';
import { classifySubmission, SPAM_LEVELS } from '../src/spam';

const balanced = { threshold: SPAM_LEVELS.balanced, duplicate: false };

describe('classifySubmission', () => {
  it('lets a normal enquiry through', () => {
    const verdict = classifySubmission(
      {
        fullName: 'Sam Lee',
        email: 'sam@example.co.uk',
        phone: '07700 900982',
        message: 'Hi, we are looking for a £50,000 loan to buy new equipment. Could you call me this week?',
      },
      balanced,
    );
    expect(verdict.isSpam).toBe(false);
    expect(verdict.score).toBe(0);
  });

  it('lets an enquiry with a single website link through', () => {
    const verdict = classifySubmission(
      { name: 'Priya Shah', email: 'priya@shahdesign.co.uk', message: 'Our current site is https://shahdesign.co.uk, can you help?' },
      balanced,
    );
    expect(verdict.isSpam).toBe(false);
  });

  it('flags a typical SEO pitch', () => {
    const verdict = classifySubmission(
      {
        name: 'John',
        email: 'john@seo-agency.example',
        message:
          'Dear Sir/Madam, I can get your website on the first page of Google. Our SEO services and backlinks will boost your traffic. See https://a.example and https://b.example',
      },
      balanced,
    );
    expect(verdict.isSpam).toBe(true);
    expect(verdict.reasons.join(' ')).toMatch(/Spam wording/);
  });

  it('flags link-stuffed messages and BBCode', () => {
    const verdict = classifySubmission(
      { name: 'Buy now', message: '[url=https://x.example]cheap[/url] https://y.example https://z.example' },
      balanced,
    );
    expect(verdict.isSpam).toBe(true);
    expect(verdict.score).toBeGreaterThanOrEqual(80);
  });

  it('flags a link in the name field together with a disposable address', () => {
    const verdict = classifySubmission({ name: 'https://spam.example', email: 'x@mailinator.com', message: 'hello' }, balanced);
    expect(verdict.isSpam).toBe(true);
    expect(verdict.reasons).toContain('Disposable email address (mailinator.com)');
  });

  it('adds weight for duplicates', () => {
    const data = { name: 'Alex', message: 'Please call me back' };
    expect(classifySubmission(data, balanced).score).toBe(0);
    expect(classifySubmission(data, { ...balanced, duplicate: true }).score).toBe(30);
  });

  it('never marks spam when the filter is off', () => {
    const verdict = classifySubmission({ message: '[url=x]a[/url] https://a.example https://b.example https://c.example' }, { threshold: SPAM_LEVELS.off, duplicate: false });
    expect(verdict.isSpam).toBe(false);
    expect(verdict.score).toBeGreaterThan(0);
  });

  it('detects random-looking filler text', () => {
    const verdict = classifySubmission({ name: 'xkqjvzwptrm', message: 'bnmxcvzlkqwrt' }, balanced);
    expect(verdict.reasons).toContain('Contains random-looking text');
  });

  it('caps the score at 100', () => {
    const verdict = classifySubmission(
      {
        name: 'https://spam.example',
        email: 'a@yopmail.com',
        message:
          'DEAR SIR, SEO SERVICES, BACKLINKS, CASINO ONLINE, VIAGRA, BITCOIN INVESTMENT [url=a]x[/url] https://a.example https://b.example https://c.example bit.ly/abc',
      },
      { threshold: 50, duplicate: true },
    );
    expect(verdict.score).toBe(100);
  });
});
