ALTER TABLE data_requests ADD COLUMN erased_user_id uuid REFERENCES users, ADD COLUMN profile_erased_at timestamptz,
 ADD CONSTRAINT data_request_erasure_evidence CHECK((erased_user_id IS NULL)=(profile_erased_at IS NULL) AND
 (profile_erased_at IS NULL OR (type='deletion' AND identity_verified_at IS NOT NULL AND status IN('in_progress','completed'))));
