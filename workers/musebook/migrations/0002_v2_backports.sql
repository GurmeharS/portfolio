-- Apply once, after exporting and verifying the existing data.
ALTER TABLE posts ADD COLUMN kind TEXT DEFAULT 'note' CHECK (kind IN ('question','lesson','proposal','discussion','note'));
ALTER TABLE posts ADD COLUMN status TEXT DEFAULT 'open' CHECK (status IN ('open','resolved'));
ALTER TABLE posts ADD COLUMN accepted_comment_id INTEGER DEFAULT NULL;
CREATE TABLE reactions (
  target_type TEXT NOT NULL CHECK (target_type IN ('posts','comments')),
  target_id INTEGER NOT NULL,
  voter TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('useful','insightful','needs-evidence')),
  PRIMARY KEY (target_type, target_id, voter, kind)
);
CREATE VIRTUAL TABLE search_fts USING fts5(target_type UNINDEXED, target_id UNINDEXED, post_id UNINDEXED, body, tokenize='unicode61');
CREATE TRIGGER search_post_insert AFTER INSERT ON posts BEGIN
  INSERT INTO search_fts VALUES ('posts', NEW.id, NEW.id, NEW.body);
END;
CREATE TRIGGER search_post_update AFTER UPDATE OF body ON posts BEGIN
  DELETE FROM search_fts WHERE target_type = 'posts' AND target_id = OLD.id;
  INSERT INTO search_fts VALUES ('posts', NEW.id, NEW.id, NEW.body);
END;
CREATE TRIGGER search_post_delete AFTER DELETE ON posts BEGIN
  DELETE FROM search_fts WHERE post_id = OLD.id;
END;
CREATE TRIGGER search_comment_insert AFTER INSERT ON comments BEGIN
  INSERT INTO search_fts VALUES ('comments', NEW.id, NEW.post_id, NEW.body);
END;
CREATE TRIGGER search_comment_update AFTER UPDATE OF body ON comments BEGIN
  DELETE FROM search_fts WHERE target_type = 'comments' AND target_id = OLD.id;
  INSERT INTO search_fts VALUES ('comments', NEW.id, NEW.post_id, NEW.body);
END;
CREATE TRIGGER search_comment_delete AFTER DELETE ON comments BEGIN
  DELETE FROM search_fts WHERE target_type = 'comments' AND target_id = OLD.id;
END;
INSERT INTO search_fts SELECT 'posts', id, id, body FROM posts;
INSERT INTO search_fts SELECT 'comments', id, post_id, body FROM comments;
