DROP TYPE IF EXISTS list_type CASCADE; CREATE TYPE list_type AS ENUM ('public', 'private', 'temporary');
DROP TYPE IF EXISTS list_optin CASCADE; CREATE TYPE list_optin AS ENUM ('single', 'double');
DROP TYPE IF EXISTS list_status CASCADE; CREATE TYPE list_status AS ENUM ('active', 'archived');
DROP TYPE IF EXISTS subscriber_status CASCADE; CREATE TYPE subscriber_status AS ENUM ('enabled', 'disabled', 'blocklisted');
DROP TYPE IF EXISTS subscription_status CASCADE; CREATE TYPE subscription_status AS ENUM ('unconfirmed', 'confirmed', 'unsubscribed');
DROP TYPE IF EXISTS campaign_status CASCADE; CREATE TYPE campaign_status AS ENUM ('draft', 'running', 'scheduled', 'paused', 'cancelled', 'finished');
DROP TYPE IF EXISTS campaign_type CASCADE; CREATE TYPE campaign_type AS ENUM ('regular', 'optin');
DROP TYPE IF EXISTS content_type CASCADE; CREATE TYPE content_type AS ENUM ('richtext', 'html', 'plain', 'markdown', 'visual');
DROP TYPE IF EXISTS bounce_type CASCADE; CREATE TYPE bounce_type AS ENUM ('soft', 'hard', 'complaint');
DROP TYPE IF EXISTS template_type CASCADE; CREATE TYPE template_type AS ENUM ('campaign', 'campaign_visual', 'tx');
DROP TYPE IF EXISTS user_type CASCADE; CREATE TYPE user_type AS ENUM ('user', 'api');
DROP TYPE IF EXISTS user_status CASCADE; CREATE TYPE user_status AS ENUM ('enabled', 'disabled');
DROP TYPE IF EXISTS role_type CASCADE; CREATE TYPE role_type AS ENUM ('user', 'list');
DROP TYPE IF EXISTS twofa_type CASCADE; CREATE TYPE twofa_type AS ENUM ('none', 'totp');

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- subscribers
DROP TABLE IF EXISTS subscribers CASCADE;
CREATE TABLE subscribers (
    id              SERIAL PRIMARY KEY,
    uuid uuid       NOT NULL UNIQUE,
    email           TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    attribs         JSONB NOT NULL DEFAULT '{}',
    status          subscriber_status NOT NULL DEFAULT 'enabled',

    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
DROP INDEX IF EXISTS idx_subs_email; CREATE UNIQUE INDEX idx_subs_email ON subscribers(LOWER(email));
DROP INDEX IF EXISTS idx_subs_status; CREATE INDEX idx_subs_status ON subscribers(status);
DROP INDEX IF EXISTS idx_subs_id_status; CREATE INDEX idx_subs_id_status ON subscribers(id, status);
DROP INDEX IF EXISTS idx_subs_created_at; CREATE INDEX idx_subs_created_at ON subscribers(created_at);
DROP INDEX IF EXISTS idx_subs_updated_at; CREATE INDEX idx_subs_updated_at ON subscribers(updated_at);

-- lists
DROP TABLE IF EXISTS lists CASCADE;
CREATE TABLE lists (
    id              SERIAL PRIMARY KEY,
    uuid            uuid NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    type            list_type NOT NULL,
    optin           list_optin NOT NULL DEFAULT 'single',
    status          list_status NOT NULL DEFAULT 'active',
    tags            VARCHAR(100)[],
    description     TEXT NOT NULL DEFAULT '',

    created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updat…2265 tokens truncated…ing_window_rate', '10000'),
    ('app.cache_slow_queries', 'false'),
    ('app.cache_slow_queries_interval', '"0 3 * * *"'),
    ('app.enable_public_archive', 'true'),
    ('app.enable_public_subscription_page', 'true'),
    ('app.enable_public_archive_rss_content', 'true'),
    ('app.send_optin_confirmation', 'true'),
    ('app.check_updates', 'true'),
    ('app.notify_emails', '[]'),
    ('app.lang', '"en"'),
    ('privacy.individual_tracking', 'false'),
    ('privacy.disable_tracking', 'false'),
    ('privacy.unsubscribe_header', 'true'),
    ('privacy.allow_blocklist', 'true'),
    ('privacy.allow_export', 'true'),
    ('privacy.allow_wipe', 'true'),
    ('privacy.allow_preferences', 'true'),
    ('privacy.exportable', '["profile", "subscriptions", "campaign_views", "link_clicks"]'),
    ('privacy.domain_blocklist', '[]'),
    ('privacy.domain_allowlist', '[]'),
    ('privacy.record_optin_ip', 'false'),
    ('security.captcha', '{"altcha": {"enabled": false, "complexity": 300000}, "hcaptcha": {"enabled": false, "key": "", "secret": ""}}'),
    ('security.oidc', '{"enabled": false, "provider_url": "", "provider_name": "", "client_id": "", "client_secret": "", "auto_create_users": false, "default_user_role_id": null, "default_list_role_id": null}'),
    ('security.cors_origins', '[]'),
    ('upload.provider', '"filesystem"'),
    ('upload.max_file_size', '5000'),
    ('upload.extensions', '["jpg","jpeg","png","gif","svg","*"]'),
    ('upload.filesystem.upload_path', '"uploads"'),
    ('upload.filesystem.upload_uri', '"/uploads"'),
    ('upload.s3.url', '"https://ap-south-1.s3.amazonaws.com"'),
    ('upload.s3.public_url', '""'),
    ('upload.s3.aws_access_key_id', '""'),
    ('upload.s3.aws_secret_access_key', '""'),
    ('upload.s3.aws_default_region', '"ap-south-1"'),
    ('upload.s3.bucket', '""'),
    ('upload.s3.bucket_domain', '""'),
    ('upload.s3.bucket_path', '"/"'),
    ('upload.s3.bucket_type', '"public"'),
    ('upload.s3.expiry', '"167h"'),
    ('smtp',
        '[{"enabled":true, "host":"smtp.yoursite.com","port":25,"auth_protocol":"cram","username":"username","password":"password","hello_hostname":"","max_conns":10,"idle_timeout":"15s","wait_timeout":"5s","max_msg_retries":2,"tls_type":"STARTTLS","tls_skip_verify":false,"email_headers":[]},
          {"enabled":false, "host":"smtp.gmail.com","port":465,"auth_protocol":"login","username":"username@gmail.com","password":"password","hello_hostname":"","max_conns":10,"idle_timeout":"15s","wait_timeout":"5s","max_msg_retries":2,"tls_type":"TLS","tls_skip_verify":false,"email_headers":[]}]'),
    ('messengers', '[]'),
    ('bounce.enabled', 'false'),
    ('bounce.webhooks_enabled', 'false'),
    ('bounce.actions', '{"soft": {"count": 2, "action": "none"}, "hard": {"count": 1, "action": "blocklist"}, "complaint" : {"count": 1, "action": "blocklist"}}'),
    ('bounce.ses_enabled', 'false'),
    ('bounce.sendgrid_enabled', 'false'),
    ('bounce.sendgrid_key', '""'),
    ('bounce.postmark', '{"enabled": false, "username": "", "password": ""}'),
    ('bounce.forwardemail', '{"enabled": false, "key": ""}'),
    ('bounce.lettermint', '{"enabled": false, "key": ""}'),
    ('bounce.mailboxes',
        '[{"enabled":false, "type": "pop", "host":"pop.yoursite.com","port":995,"auth_protocol":"userpass","username":"username","password":"password","return_path": "bounce@listmonk.yoursite.com","scan_interval":"15m","tls_enabled":true,"tls_skip_verify":false}]'),
    ('appearance.admin.custom_css', '""'),
    ('appearance.admin.custom_js', '""'),
    ('appearance.public.custom_css', '""'),
    ('appearance.public.custom_js', '""'),
    ('maintenance.db', '{"vacuum": false, "vacuum_cron_interval": "0 2 * * *"}');

-- bounces
DROP TABLE IF EXISTS bounces CASCADE;
CREATE TABLE bounces (
    id               SERIAL PRIMARY KEY,
    subscriber_id    INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE ON UPDATE CASCADE,
    campaign_id      INTEGER NULL REFERENCES campaigns(id) ON DELETE SET NULL ON UPDATE CASCADE,
    type             bounce_type NOT NULL DEFAULT 'hard',
    source           TEXT NOT NULL DEFAULT '',
    meta             JSONB NOT NULL DEFAULT '{}',
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
DROP INDEX IF EXISTS idx_bounces_sub_id; CREATE INDEX idx_bounces_sub_id ON bounces(subscriber_id);
DROP INDEX IF EXISTS idx_bounces_camp_id; CREATE INDEX idx_bounces_camp_id ON bounces(campaign_id);
DROP INDEX IF EXISTS idx_bounces_source; CREATE INDEX idx_bounces_source ON bounces(source);
DROP INDEX IF EXISTS idx_bounces_date; CREATE INDEX idx_bounces_date ON bounces(created_at);

-- roles
DROP TABLE IF EXISTS roles CASCADE;
CREATE TABLE roles (
    id               SERIAL PRIMARY KEY,
    type             role_type NOT NULL DEFAULT 'user',
    parent_id        INTEGER NULL REFERENCES roles(id) ON DELETE CASCADE ON UPDATE CASCADE,
    list_id          INTEGER NULL REFERENCES lists(id) ON DELETE CASCADE ON UPDATE CASCADE,
    permissions      TEXT[] NOT NULL DEFAULT '{}',
    name             TEXT NULL,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_roles ON roles (parent_id, list_id);
CREATE UNIQUE INDEX idx_roles_name ON roles (type, name) WHERE name IS NOT NULL;

-- users
DROP TABLE IF EXISTS users CASCADE;
CREATE TABLE users (
    id               SERIAL PRIMARY KEY,
    username         TEXT NOT NULL UNIQUE,
    password_login   BOOLEAN NOT NULL DEFAULT false,
    password         TEXT NULL,
    email            TEXT NOT NULL UNIQUE,
    name             TEXT NOT NULL,
    avatar           TEXT NULL,
    type             user_type NOT NULL DEFAULT 'user',
    user_role_id     INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    list_role_id     INTEGER NULL REFERENCES roles(id) ON DELETE CASCADE,
    status           user_status NOT NULL DEFAULT 'disabled',
    twofa_type       twofa_type NOT NULL DEFAULT 'none',
    twofa_key        TEXT NULL,
    loggedin_at      TIMESTAMP WITH TIME ZONE NULL,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- user sessions
DROP TABLE IF EXISTS sessions CASCADE;
CREATE TABLE sessions (
    id TEXT NOT NULL PRIMARY KEY,
    data JSONB DEFAULT '{}'::jsonb NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now() NOT NULL
);
DROP INDEX IF EXISTS idx_sessions; CREATE INDEX idx_sessions ON sessions (id, created_at);

-- materialized views

-- dashboard stats
DROP MATERIALIZED VIEW IF EXISTS mat_dashboard_counts;
CREATE MATERIALIZED VIEW mat_dashboard_counts AS
    WITH subs AS (
        SELECT COUNT(*) AS num, status FROM subscribers GROUP BY status
    )
    SELECT NOW() AS updated_at,
        JSON_BUILD_OBJECT(
            'subscribers', JSON_BUILD_OBJECT(
                'total', (SELECT SUM(num) FROM subs),
                'blocklisted', (SELECT num FROM subs WHERE status='blocklisted'),
                'orphans', (
                    SELECT COUNT(id) FROM subscribers
                    LEFT JOIN subscriber_lists ON (subscribers.id = subscriber_lists.subscriber_id)
                    WHERE subscriber_lists.subscriber_id IS NULL
                )
            ),
            'lists', JSON_BUILD_OBJECT(
                'total', (SELECT COUNT(*) FROM lists),
                'private', (SELECT COUNT(*) FROM lists WHERE type='private'),
                'public', (SELECT COUNT(*) FROM lists WHERE type='public'),
                'optin_single', (SELECT COUNT(*) FROM lists WHERE optin='single'),
                'optin_double', (SELECT COUNT(*) FROM lists WHERE optin='double')
            ),
            'campaigns', JSON_BUILD_OBJECT(
                'total', (SELECT COUNT(*) FROM campaigns),
                'by_status', (
                    SELECT JSON_OBJECT_AGG (status, num) FROM
                    (SELECT status, COUNT(*) AS num FROM campaigns GROUP BY status) r
                )
            ),
            'messages', (SELECT SUM(sent) AS messages FROM campaigns)
        ) AS data;
DROP INDEX IF EXISTS mat_dashboard_stats_idx; CREATE UNIQUE INDEX mat_dashboard_stats_idx ON mat_dashboard_counts (updated_at);


DROP MATERIALIZED VIEW IF EXISTS mat_dashboard_charts;
CREATE MATERIALIZED VIEW mat_dashboard_charts AS
    WITH clicks AS (
        SELECT JSON_AGG(ROW_TO_JSON(row))
        FROM (
            WITH viewDates AS (
              SELECT created_at::DATE AS to_date,
                     created_at::DATE - INTERVAL '30 DAY' AS from_date
                     FROM link_clicks ORDER BY id DESC LIMIT 1
            )
            SELECT COUNT(*) AS count, created_at::DATE as date FROM link_clicks
              WHERE created_at >= (SELECT from_date FROM viewDates)
                AND created_at < (SELECT to_date FROM viewDates) + INTERVAL '1 day'
              GROUP by date ORDER BY date
        ) row
    ),
    views AS (
        SELECT JSON_AGG(ROW_TO_JSON(row))
        FROM (
            WITH viewDates AS (
              SELECT created_at::DATE AS to_date,
                     created_at::DATE - INTERVAL '30 DAY' AS from_date
                     FROM campaign_views ORDER BY id DESC LIMIT 1
            )
            SELECT COUNT(*) AS count, created_at::DATE as date FROM campaign_views
              WHERE created_at >= (SELECT from_date FROM viewDates)
                AND created_at < (SELECT to_date FROM viewDates) + INTERVAL '1 day'
              GROUP by date ORDER BY date
        ) row
    )
    SELECT NOW() AS updated_at, JSON_BUILD_OBJECT('link_clicks', COALESCE((SELECT * FROM clicks), '[]'),
                                  'campaign_views', COALESCE((SELECT * FROM views), '[]')
                                ) AS data;
DROP INDEX IF EXISTS mat_dashboard_charts_idx; CREATE UNIQUE INDEX mat_dashboard_charts_idx ON mat_dashboard_charts (updated_at);

-- subscriber counts stats for lists
DROP MATERIALIZED VIEW IF EXISTS mat_list_subscriber_stats;
CREATE MATERIALIZED VIEW mat_list_subscriber_stats AS
    SELECT NOW() AS updated_at, lists.id AS list_id, subscriber_lists.status, COUNT(subscriber_lists.status) AS subscriber_count FROM lists
    LEFT JOIN subscriber_lists ON (subscriber_lists.list_id = lists.id)
    GROUP BY lists.id, subscriber_lists.status
    UNION ALL
    SELECT NOW() AS updated_at, 0 AS list_id, NULL AS status, COUNT(id) AS subscriber_count FROM subscribers;
DROP INDEX IF EXISTS mat_list_subscriber_stats_idx; CREATE UNIQUE INDEX mat_list_subscriber_stats_idx ON mat_list_subscriber_stats (list_id, status);
