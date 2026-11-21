-- A source may name its own websites. Existing project-wide websites stay on the project.
ALTER TABLE sources ADD COLUMN website_urls TEXT NOT NULL DEFAULT '[]';
