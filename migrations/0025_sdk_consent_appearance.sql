-- Consent presentation lives in the installed SDK snippet; visitor_mode remains source policy.
ALTER TABLE sources DROP COLUMN consent_prompt;
ALTER TABLE sources DROP COLUMN consent_theme;
