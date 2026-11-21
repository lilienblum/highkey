-- Installation snippet preferences only; existing sites keep their own consent flow.
ALTER TABLE sources ADD COLUMN consent_prompt TEXT NOT NULL DEFAULT 'site'
  CHECK(consent_prompt IN ('site','bar','corner'));
ALTER TABLE sources ADD COLUMN consent_theme TEXT NOT NULL DEFAULT 'auto'
  CHECK(consent_theme IN ('auto','light','dark'));
