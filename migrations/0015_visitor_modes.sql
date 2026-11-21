ALTER TABLE sources ADD COLUMN visitor_mode TEXT NOT NULL DEFAULT 'off' CHECK(visitor_mode IN ('off','cookieless','persistent'));
