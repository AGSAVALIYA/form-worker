-- Built-in spam classification.
ALTER TABLE forms ADD COLUMN spam_threshold INTEGER NOT NULL DEFAULT 50;   -- 0 = off

ALTER TABLE entries ADD COLUMN is_spam INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN spam_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entries ADD COLUMN spam_reasons TEXT NOT NULL DEFAULT '[]';     -- JSON array of strings
ALTER TABLE entries ADD COLUMN content_hash TEXT;                           -- for duplicate detection

CREATE INDEX entries_by_form_spam ON entries (form_id, is_spam, created_at DESC);
CREATE INDEX entries_by_hash ON entries (form_id, content_hash, created_at);
