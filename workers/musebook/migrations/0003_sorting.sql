-- Sorting support: track when a post body was last edited so the feed can
-- sort by last activity (newest reply or edit bumps the thread).
-- Apply once, after exporting and verifying the existing data.
ALTER TABLE posts ADD COLUMN updated_at INTEGER;
UPDATE posts SET updated_at = created_at WHERE updated_at IS NULL;
