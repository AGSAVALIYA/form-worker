-- Forms: one row per form (or per site) that may submit to this Worker.
CREATE TABLE forms (
  id                TEXT PRIMARY KEY,                -- URL slug: /api/forms/<id>/submissions
  name              TEXT NOT NULL,
  api_key_hash      TEXT NOT NULL,                   -- SHA-256 (hex) of the server-to-server API key
  allowed_origins   TEXT NOT NULL DEFAULT '[]',      -- JSON array of origins allowed to post from a browser
  notify_emails     TEXT NOT NULL DEFAULT '[]',      -- JSON array of addresses to notify
  redirect_url      TEXT,                            -- where plain HTML form posts are sent afterwards
  require_turnstile INTEGER NOT NULL DEFAULT 0,      -- browser posts must include a valid Turnstile token
  retention_days    INTEGER NOT NULL DEFAULT 365,    -- entries older than this are deleted automatically
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL
);

-- Entries: one row per submission.
CREATE TABLE entries (
  id              TEXT PRIMARY KEY,
  form_id         TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  created_at      TEXT NOT NULL,
  data            TEXT NOT NULL,                     -- JSON object of submitted fields
  meta            TEXT NOT NULL DEFAULT '{}',        -- JSON: origin, source page, kind, …
  notify_status   TEXT NOT NULL DEFAULT 'pending',   -- pending | sent | failed | skipped
  notify_attempts INTEGER NOT NULL DEFAULT 0,
  notify_error    TEXT
);

CREATE INDEX entries_by_form ON entries (form_id, created_at DESC);
CREATE INDEX entries_by_status ON entries (notify_status, created_at);
