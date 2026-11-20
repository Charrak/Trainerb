-- A dedicated monitor needs SELECT on this single-row view only. Never expose
-- addresses, object keys, order references, message bodies or provider errors.
-- Keep frequent probes on large historical tables away from fulfilled orders and scanned media.
CREATE INDEX orders_paid_unfulfilled_age ON public.orders(paid_at)
 WHERE payment_state='paid' AND fulfillment_state<>'fulfilled';
CREATE INDEX course_media_scan_error_age ON public.course_media_uploads(scanned_at) WHERE status='scan_error';
CREATE INDEX course_media_promotion_stalled ON public.course_media_uploads(approved_at)
 WHERE status='clean' AND approved_at IS NOT NULL AND promoted_asset_id IS NULL AND rights_withdrawn_at IS NULL;
CREATE VIEW public.operations_probe_v1 WITH (security_barrier=true) AS
SELECT
 EXISTS (SELECT FROM public.automation_jobs WHERE kind='email.send' AND ref_type='email_outbox'
   AND status='queued' AND run_after <= now()-interval '10 minutes') AS mail_overdue,
 EXISTS (SELECT FROM public.automation_jobs WHERE kind='email.send' AND ref_type='email_outbox'
   AND status='running' AND (lease_until IS NULL OR lease_until <= now()-interval '5 minutes')) AS mail_lease_stalled,
 EXISTS (SELECT FROM public.automation_jobs WHERE kind='email.send' AND ref_type='email_outbox'
   AND status='failed' AND finished_at >= now()-interval '24 hours') AS mail_failed_24h,
 -- Match the eligibility rule used by issueNextCertificate, including
 -- cancellation for a deleted user. Future retry_at alone is not a stall.
 EXISTS (SELECT FROM public.certificates c JOIN public.completion_records r ON r.id=c.completion_id
   JOIN public.course_access a ON a.id=r.access_id JOIN public.users u ON u.id=a.user_id
   JOIN public.certificate_templates t ON t.id=c.template_id
   WHERE c.status='queued' AND t.approved_at IS NOT NULL AND
     (u.status='deleted' OR (u.status='active' AND a.revoked_at IS NULL AND a.suspended_at IS NULL)) AND
     (c.retry_at <= now()-interval '10 minutes' OR c.attempts >= 3)) AS certificate_stalled,
 EXISTS (SELECT FROM public.course_media_uploads WHERE status='pending_scan'
   AND created_at <= now()-interval '30 minutes') AS scan_overdue,
 EXISTS (SELECT FROM public.course_media_uploads WHERE status='scan_error' AND scanned_at >= now()-interval '24 hours') AS scan_failed_24h,
 EXISTS (SELECT FROM public.course_media_uploads WHERE status='clean' AND approved_at IS NOT NULL
   AND promoted_asset_id IS NULL AND rights_withdrawn_at IS NULL
   AND (approved_at <= now()-interval '30 minutes' OR promotion_error IS NOT NULL)) AS promotion_stalled,
 EXISTS (SELECT FROM public.orders WHERE payment_state='paid' AND fulfillment_state<>'fulfilled'
   AND paid_at <= now()-interval '15 minutes') AS paid_unfulfilled;
REVOKE ALL ON public.operations_probe_v1 FROM PUBLIC;
