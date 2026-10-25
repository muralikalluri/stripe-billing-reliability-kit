-- Run ONCE per deployed project (SQL editor), after deploying the functions. Not a migration on purpose:
-- it needs your project URL and a key stored in Vault, which differ per project.
-- 1) Store the URL and service key in Vault (never paste keys into cron job text):
--    select vault.create_secret('https://<project-ref>.supabase.co', 'billing_project_url');
--    select vault.create_secret('<service-role or sb_secret_ key>', 'billing_service_key');
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Retry failed/leftover events every minute (the webhook function normally processes them immediately).
select cron.schedule('stripe-worker', '* * * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'billing_project_url') || '/functions/v1/stripe-worker',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'billing_service_key'))
  )
$$);

-- Nightly reconcile at 03:00 UTC.
select cron.schedule('stripe-reconcile', '0 3 * * *', $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'billing_project_url') || '/functions/v1/stripe-reconcile?trigger=nightly',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'billing_service_key')),
    timeout_milliseconds := 120000
  )
$$);
