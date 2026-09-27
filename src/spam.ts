/**
 * Built-in spam classification. Runs inside the Worker: no third-party
 * service, no extra cost, and submission data never leaves your account.
 *
 * Each signal adds points; a submission scoring at or above the form's
 * threshold is filed as spam (stored, not emailed, shown in the Spam tab).
 * Every signal records a human-readable reason so decisions can be reviewed
 * and corrected in the admin.
 */

export interface SpamVerdict {
  score: number;
  isSpam: boolean;
  reasons: string[];
}

export interface SpamContext {
  /** 0 disables the filter; otherwise the score at which an entry is spam. */
  threshold: number;
  /** An identical submission was received for this form recently. */
  duplicate: boolean;
}

/** Threshold presets offered in the admin. */
export const SPAM_LEVELS = { off: 0, relaxed: 70, balanced: 50, strict: 35 } as const;

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[a-z0-9-]+\.[a-z]{2,}[^\s<>"']*/gi;
const MARKUP_LINK = /\[url[=\]]|<a\s+[^>]*href|\[link[=\]]/i;
const SHORTENERS = /\b(bit\.ly|tinyurl\.com|t\.co|goo\.gl|cutt\.ly|rb\.gy|is\.gd|shorturl\.at|t\.ly|ow\.ly)\//i;

/**
 * Phrases typical of unsolicited marketing, SEO, crypto, gambling and pharma spam.
 * Deliberately avoids words legitimate enquiries use (e.g. "loan", "finance", "quote").
 */
const SPAM_PHRASES: RegExp[] = [
  /\bseo (services?|agency|expert|package)s?\b/i,
  /\b(back ?links?|link ?building|guest ?posts?)\b/i,
  /\b(first page|top rank(ing)?|rank(ing)? (higher|#?1)) (of|on|in) google\b/i,
  /\b(increase|boost|drive) (your )?(website |site )?(traffic|sales|leads)\b/i,
  /\b(web ?site )?(re)?design (and|&) development services\b/i,
  /\b(bitcoin|crypto(currency)?|forex|nft) (investment|trading|profit|opportunit)/i,
  /\b(casino|betting|poker|slots?) (online|bonus|site)s?\b/i,
  /\b(viagra|cialis|levitra|pharmacy online|weight loss pills?)\b/i,
  /\b(porn|xxx|adult (dating|content)|hot singles)\b/i,
  /\b(whats ?app|telegram) me\b/i,
  /\bdear (sir|madam|sir\/madam|website owner|business owner)\b/i,
  /\b(this is not spam|unsubscribe (here|below)|reply (with )?stop)\b/i,
  /\b(outsourc(e|ing) (company|team|services)|virtual assistant services)\b/i,
  /\b(earn|make) \$?\d+[k]? (per|a) (day|week)\b/i,
];

/** A short list of common throwaway-email domains. */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', 'grr.la', '10minutemail.com',
  '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmailo.com', 'yopmail.com', 'yopmail.net',
  'trashmail.com', 'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com',
  'moakt.com', 'mintemail.com', 'mailnesia.com', 'spamgourmet.com', 'emailondeck.com', 'tempinbox.com',
  'mohmal.com', 'burnermail.io', 'mail.tm', 'dropmail.me', 'mailpoof.com', 'tmpmail.org', 'tmail.ws',
]);

const NAME_KEY = /^(full_?name|first_?name|last_?name|name|your_?name)$/i;
const EMAIL_KEY = /e-?mail/i;

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** Long runs of letters with almost no vowels, e.g. "xkqjvzwpt", typical of bot filler. */
function looksLikeGibberish(value: string): boolean {
  const words = value.split(/\s+/).filter((word) => /^[a-z]{10,}$/i.test(word));
  return words.some((word) => {
    const vowels = countMatches(word, /[aeiou]/gi);
    const caseSwitches = countMatches(word, /[a-z][A-Z]|[A-Z][a-z]/g);
    return vowels / word.length < 0.15 || caseSwitches >= word.length / 2;
  });
}

export function classifySubmission(data: Record<string, string>, context: SpamContext): SpamVerdict {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push(reason);
  };

  const values = Object.values(data);
  const text = values.join('\n');

  // Links: the strongest single signal on contact forms.
  const links = countMatches(text, URL_PATTERN);
  if (links >= 3) add(45, `Contains ${links} links`);
  else if (links === 2) add(25, 'Contains 2 links');
  else if (links === 1) add(10, 'Contains a link');
  if (MARKUP_LINK.test(text)) add(40, 'Contains HTML or BBCode links');
  if (SHORTENERS.test(text)) add(20, 'Uses a link shortener');

  // Spammy wording (capped so one long pitch cannot dominate alone).
  const phrases = SPAM_PHRASES.filter((pattern) => pattern.test(text)).length;
  if (phrases) add(Math.min(phrases * 20, 50), `Spam wording (${phrases} match${phrases === 1 ? '' : 'es'})`);

  for (const [key, value] of Object.entries(data)) {
    if (NAME_KEY.test(key)) {
      if (countMatches(value, URL_PATTERN) > 0) add(40, 'Name contains a link');
      else if (value.length > 60) add(15, 'Unusually long name');
      else if (/^\d[\d\s]*$/.test(value)) add(15, 'Name is only numbers');
    }
    if (EMAIL_KEY.test(key)) {
      const domain = value.split('@')[1]?.toLowerCase().trim();
      if (domain && DISPOSABLE_DOMAINS.has(domain)) add(30, `Disposable email address (${domain})`);
    }
  }

  if (looksLikeGibberish(text)) add(20, 'Contains random-looking text');

  const letters = text.replace(/[^a-z]/gi, '');
  if (letters.length >= 30 && countMatches(letters, /[A-Z]/g) / letters.length > 0.7) add(10, 'Mostly capital letters');

  const filled = values.filter((value) => value.length > 0);
  if (filled.length >= 3 && new Set(filled).size === 1) add(25, 'Every field has the same value');

  if (/[​-‍⁠﻿]/.test(text)) add(10, 'Contains hidden (zero-width) characters');

  if (context.duplicate) add(30, 'Duplicate of a recent submission');

  score = Math.min(score, 100);
  return { score, isSpam: context.threshold > 0 && score >= context.threshold, reasons };
}
