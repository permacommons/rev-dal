-- PostgreSQL database grants setup
-- Usage:
--   psql -v app_db=libreviews -v app_user=libreviews_user \
--        -v test_db=libreviews_test -v test_user=libreviews_user \
--        -f setup-db-grants.sql

\if :{?app_db}
\else
\echo 'Missing required variable: app_db'
\quit 1
\endif

\if :{?app_user}
\else
\echo 'Missing required variable: app_user'
\quit 1
\endif

\if :{?test_db}
\else
\echo 'Missing required variable: test_db'
\quit 1
\endif

\if :{?test_user}
\else
\echo 'Missing required variable: test_user'
\quit 1
\endif

-- Grant database-level permissions
GRANT ALL PRIVILEGES ON DATABASE :"app_db" TO :"app_user";
GRANT ALL PRIVILEGES ON DATABASE :"test_db" TO :"test_user";

-- Configure the primary application database
\c :"app_db";
GRANT ALL ON SCHEMA public TO :"app_user";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO :"app_user";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO :"app_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO :"app_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO :"app_user";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Configure the test database
\c :"test_db";
GRANT ALL ON SCHEMA public TO :"test_user";
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO :"test_user";
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO :"test_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO :"test_user";
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO :"test_user";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
