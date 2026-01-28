CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name VARCHAR(255) NOT NULL,
  canonical_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255),
  content TEXT,
  _rev_user UUID NOT NULL,
  _rev_date TIMESTAMP NOT NULL,
  _rev_id UUID NOT NULL,
  _old_rev_of UUID,
  _rev_deleted BOOLEAN DEFAULT FALSE,
  _rev_tags TEXT[] DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_revisions_current
  ON revisions (_old_rev_of, _rev_deleted)
  WHERE _old_rev_of IS NULL AND _rev_deleted = false;

CREATE INDEX IF NOT EXISTS idx_revisions_old_rev_of
  ON revisions (_old_rev_of)
  WHERE _old_rev_of IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_canonical_name
  ON users (canonical_name);

CREATE INDEX IF NOT EXISTS idx_users_email
  ON users (email);
