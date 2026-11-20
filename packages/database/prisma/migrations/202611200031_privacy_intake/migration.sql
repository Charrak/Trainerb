CREATE TABLE data_requests(
 id uuid PRIMARY KEY,type text NOT NULL CHECK(type IN('access','export','deletion','correction')),
 contact_cipher bytea,contact_key_id text, status text NOT NULL DEFAULT 'open' CHECK(status IN('open','identity_check','in_progress','completed','rejected')),
 requested_at timestamptz NOT NULL DEFAULT now(),identity_verified_at timestamptz,processed_at timestamptz,processed_by uuid REFERENCES users,
 decision text CHECK(decision IN('fulfilled','partially_retained','identity_unverified','not_applicable')),
 CHECK((contact_cipher IS NULL)=(contact_key_id IS NULL)), CHECK((processed_at IS NULL)=(contact_cipher IS NOT NULL)),
 CHECK((status IN('completed','rejected'))=(processed_at IS NOT NULL)), CHECK((decision IS NULL)=(processed_at IS NULL)),
 CHECK(status NOT IN('completed','in_progress') OR identity_verified_at IS NOT NULL)
);
CREATE INDEX data_requests_queue ON data_requests(status,id);
