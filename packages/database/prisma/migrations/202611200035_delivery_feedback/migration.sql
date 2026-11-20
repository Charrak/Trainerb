-- Deduplicate authenticated Postmark events; never persist the address or the raw report.
CREATE TABLE newsletter_feedback (
 server_id text NOT NULL, event_id text NOT NULL, kind text NOT NULL CHECK(kind IN ('bounced','complained')),
 send_outbox_id uuid NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(server_id,event_id,kind));
