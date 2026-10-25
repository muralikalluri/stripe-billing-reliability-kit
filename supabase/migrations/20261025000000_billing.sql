-- Stripe billing on Supabase: the same tables as the Next.js and Spring Boot implementations
-- (docs/api-contract.md), plus a job queue, row level security and the SQL functions the Edge Functions call.
-- Every write path goes through a function below, so locking, ordering and the access policy live in one place.

-- ---------------------------------------------------------------- shared contract (unchanged)
create table if not exists public.users (
  id text primary key not null,
  email text not null,
  created_at timestamptz default now() not null,
  constraint users_email_unique unique (email)
);
create table if not exists public.customers (
  user_id text primary key not null references public.users (id),
  stripe_customer_id text not null,
  constraint customers_stripe_customer_id_unique unique (stripe_customer_id)
);
create table if not exists public.entitlements (
  user_id text primary key not null references public.users (id),
  plan text not null,
  seats integer default 1 not null,
  valid_until timestamptz
);
create table if not exists public.subscriptions (
  id text primary key not null,
  user_id text not null references public.users (id),
  stripe_subscription_id text not null,
  status text not null,
  price_id text not null,
  quantity integer default 1 not null,
  current_period_end timestamptz,
  cancel_at_period_end boolean default false not null,
  updated_from_event_created bigint,
  updated_at timestamptz default now() not null,
  current_period_start timestamptz
);
create unique index if not exists subscriptions_stripe_subscription_id_uq on public.subscriptions using btree (stripe_subscription_id);
create table if not exists public.webhook_events (
  event_id text primary key not null,
  type text not null,
  received_at timestamptz default now() not null,
  processed_at timestamptz,
  status text default 'received' not null,
  error text,
  attempts integer default 0 not null
);
create table if not exists public.reconcile_runs (
  id text primary key not null,
  trigger text not null,
  started_at timestamptz not null,
  finished_at timestamptz not null,
  complete boolean not null,
  report jsonb not null
);

-- ---------------------------------------------------------------- Supabase-only state
-- Transactional outbox: a job row is written in the SAME transaction as its webhook_events row
-- (same shape as the Spring Boot implementation's event_jobs).
create table if not exists public.event_jobs (
  event_id text primary key references public.webhook_events (event_id) on delete cascade,
  payload jsonb not null,
  run_after timestamptz not null default now(),
  retries integer not null default 0,
  locked_until timestamptz
);
create index if not exists event_jobs_due_idx on public.event_jobs (run_after);

-- Short leases instead of session advisory locks: PostgREST calls don't share a session.
create table if not exists public.billing_leases (
  name text primary key,
  locked_until timestamptz not null
);

-- ---------------------------------------------------------------- auth.users -> public.users
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.users (id, email)
  values (new.id::text, coalesce(new.email, new.id::text || '@users.noreply.local'))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created_billing on auth.users;
create trigger on_auth_user_created_billing after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------- row level security
-- Users may read their own subscription rows and entitlement; nothing else. Only the service role writes.
alter table public.users enable row level security;
alter table public.customers enable row level security;
alter table public.entitlements enable row level security;
alter table public.subscriptions enable row level security;
alter table public.webhook_events enable row level security;
alter table public.reconcile_runs enable row level security;
alter table public.event_jobs enable row level security;
alter table public.billing_leases enable row level security;
drop policy if exists "own entitlement" on public.entitlements;
create policy "own entitlement" on public.entitlements for select to authenticated using (user_id = (select auth.uid())::text);
drop policy if exists "own subscriptions" on public.subscriptions;
create policy "own subscriptions" on public.subscriptions for select to authenticated using (user_id = (select auth.uid())::text);

-- ---------------------------------------------------------------- access policy (THE single source of truth)
-- Mirrors nextjs/src/lib/entitlements/derive.ts and DeriveEntitlement.java; a test compares them case by case.
-- trialing/active: plan until period end + 3 days renewal buffer (no buffer once cancel_at_period_end is set)
-- past_due: plan until the failed period's START + 3 days grace; everything else (and unknown plan/dates): free.
create or replace function public.derive_entitlement(
  p_status text, p_plan text, p_quantity integer,
  p_period_start timestamptz, p_period_end timestamptz, p_cancel_at_period_end boolean
) returns table (plan text, seats integer, valid_until timestamptz)
language sql immutable set search_path = '' as $$
  select case when ok then p_plan else 'free' end,
         case when ok then greatest(1, coalesce(p_quantity, 1)) else 1 end,
         case when ok then v end
  from (
    select v, (p_plan is not null and v is not null) as ok from (
      select case
        when p_status in ('trialing', 'active') and p_period_end is not null then
          case when p_cancel_at_period_end then p_period_end else p_period_end + interval '3 days' end
        when p_status = 'past_due' and p_period_start is not null then p_period_start + interval '3 days'
        else null
      end as v
    ) a
  ) b
$$;

-- Best entitlement over all of a user's subscriptions: highest plan rank, then latest valid_until.
-- p_price_plans maps Stripe price ids to plan names, e.g. {"price_123": "pro"} (built from env in the Edge Functions).
create or replace function public.compute_entitlement(p_user_id text, p_price_plans jsonb)
returns table (plan text, seats integer, valid_until timestamptz)
language sql stable set search_path = '' as $$
  select e.plan, e.seats, e.valid_until from (
    select d.plan, d.seats, d.valid_until
      from public.subscriptions s
      cross join lateral public.derive_entitlement(s.status, p_price_plans ->> s.price_id, s.quantity,
        s.current_period_start, s.current_period_end, s.cancel_at_period_end) d
     where s.user_id = p_user_id
    union all select 'free', 1, null::timestamptz
  ) e
  order by case e.plan when 'team' then 2 when 'pro' then 1 else 0 end desc, e.valid_until desc nulls last
  limit 1
$$;

create or replace function public.recompute_entitlement(p_user_id text, p_price_plans jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare e record;
begin
  -- Per-user lock, always taken AFTER the per-subscription lock (no deadlocks).
  perform pg_advisory_xact_lock(hashtext('user:' || p_user_id));
  select * into e from public.compute_entitlement(p_user_id, p_price_plans);
  insert into public.entitlements (user_id, plan, seats, valid_until) values (p_user_id, e.plan, e.seats, e.valid_until)
  on conflict (user_id) do update set plan = excluded.plan, seats = excluded.seats, valid_until = excluded.valid_until;
end $$;

-- What the signed-in user can use right now (expired entitlements read as free). Safe for the browser.
create or replace function public.my_entitlement() returns table (plan text, seats integer, valid_until timestamptz)
language sql stable security invoker set search_path = '' as $$
  select coalesce(max(case when e.valid_until > now() then e.plan end), 'free'),
         coalesce(max(case when e.valid_until > now() then e.seats end), 1),
         max(case when e.valid_until > now() then e.valid_until end)
    from public.entitlements e where e.user_id = (select auth.uid())::text
$$;

-- ---------------------------------------------------------------- webhook ingest (atomic insert + enqueue)
create or replace function public.ingest_stripe_event(p_id text, p_type text, p_payload jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.webhook_events (event_id, type) values (p_id, p_type) on conflict (event_id) do nothing;
  get diagnostics n = row_count;           -- 1 when this delivery is the first one
  if n = 1 then
    insert into public.event_jobs (event_id, payload) values (p_id, p_payload);
  end if;
  return n = 1;                            -- false = duplicate delivery, already accepted
end $$;

-- ---------------------------------------------------------------- worker queue
create or replace function public.claim_event_jobs(p_limit integer default 10, p_lease_seconds integer default 60)
returns table (event_id text, payload jsonb)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  with due as (
    select j.event_id from public.event_jobs j
     where j.run_after <= now() and (j.locked_until is null or j.locked_until < now())
     order by j.run_after
     limit p_limit
     for update skip locked
  ), claimed as (
    update public.event_jobs j set locked_until = now() + make_interval(secs => p_lease_seconds)
      from due where j.event_id = due.event_id
    returning j.event_id, j.payload
  ), marked as (
    update public.webhook_events w set status = 'processing', attempts = w.attempts + 1, error = null
      from claimed where w.event_id = claimed.event_id
    returning w.event_id
  )
  select c.event_id, c.payload from claimed c join marked m on m.event_id = c.event_id;
end $$;

create or replace function public.complete_event_job(p_event_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.webhook_events set status = 'processed', processed_at = now(), error = null where event_id = p_event_id;
  delete from public.event_jobs where event_id = p_event_id;
end $$;

-- Exponential backoff: 5s, 10s, 20s ... capped at 1h; after p_max_retries the job parks until requeued.
create or replace function public.fail_event_job(p_event_id text, p_error text, p_max_retries integer default 10) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.webhook_events set status = 'failed', error = left(p_error, 2000) where event_id = p_event_id;
  update public.event_jobs
     set retries = retries + 1,
         locked_until = null,
         run_after = case when retries + 1 >= p_max_retries then 'infinity'::timestamptz
                          else now() + least(interval '1 hour', interval '5 seconds' * power(2, retries)) end
   where event_id = p_event_id;
end $$;

-- Admin: retry a failed event now (the "retry" button in the other implementations).
create or replace function public.requeue_event(p_event_id text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.event_jobs set run_after = now(), retries = 0, locked_until = null where event_id = p_event_id;
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- ---------------------------------------------------------------- subscription sync (lock + compare-and-set)
-- Called with a subscription fetched from the Stripe API (never trust the event payload).
-- Event path: p_version = event.created; an older event never overwrites newer state.
-- Reconcile path: p_version = null and p_fetched_at = DB time before the Stripe fetch; if a webhook updated the
-- row after that, the (possibly stale) snapshot is NOT written. Returns 'applied' or 'stale'.
create or replace function public.apply_subscription(
  p_stripe_subscription_id text, p_stripe_customer_id text, p_metadata_user_id text,
  p_status text, p_price_id text, p_quantity integer,
  p_period_start timestamptz, p_period_end timestamptz, p_cancel_at_period_end boolean,
  p_version bigint, p_fetched_at timestamptz, p_price_plans jsonb
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_user text;
  v_existing public.subscriptions%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext(p_stripe_subscription_id));
  if (p_price_plans ->> p_price_id) is null then
    raise exception 'unknown price %: check STRIPE_PRICE_* env vars', p_price_id;   -- fail loudly, never grant "free" silently
  end if;
  select c.user_id into v_user from public.customers c where c.stripe_customer_id = p_stripe_customer_id;
  if v_user is null then v_user := p_metadata_user_id; end if;
  if v_user is null or not exists (select 1 from public.users u where u.id = v_user) then
    raise exception 'no user for stripe customer %', p_stripe_customer_id;           -- throw, never guess
  end if;

  select * into v_existing from public.subscriptions s where s.stripe_subscription_id = p_stripe_subscription_id;
  if found then
    if v_existing.user_id <> v_user then
      raise exception 'subscription % belongs to another user; refusing to reassign', p_stripe_subscription_id;
    end if;
    if p_version is not null and v_existing.updated_from_event_created is not null and v_existing.updated_from_event_created > p_version then
      return 'stale';
    end if;
    if p_version is null and p_fetched_at is not null and v_existing.updated_at > p_fetched_at then
      return 'stale';
    end if;
    update public.subscriptions set
      status = p_status, price_id = p_price_id, quantity = coalesce(p_quantity, 1),
      current_period_start = p_period_start, current_period_end = p_period_end,
      cancel_at_period_end = p_cancel_at_period_end, updated_at = now(),
      updated_from_event_created = coalesce(p_version, v_existing.updated_from_event_created)  -- reconcile never moves the event clock
    where stripe_subscription_id = p_stripe_subscription_id;
  else
    insert into public.subscriptions (id, user_id, stripe_subscription_id, status, price_id, quantity,
      current_period_start, current_period_end, cancel_at_period_end, updated_from_event_created)
    values ('sub_' || p_stripe_subscription_id, v_user, p_stripe_subscription_id, p_status, p_price_id, coalesce(p_quantity, 1),
      p_period_start, p_period_end, p_cancel_at_period_end, p_version);
  end if;
  perform public.recompute_entitlement(v_user, p_price_plans);
  return 'applied';
end $$;

-- ---------------------------------------------------------------- leases and clock
create or replace function public.acquire_lease(p_name text, p_seconds integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into public.billing_leases (name, locked_until) values (p_name, now() + make_interval(secs => p_seconds))
  on conflict (name) do update set locked_until = excluded.locked_until
    where public.billing_leases.locked_until < now();
  get diagnostics n = row_count;
  return n = 1;
end $$;
create or replace function public.release_lease(p_name text) returns void
language sql security definer set search_path = '' as $$ delete from public.billing_leases where name = p_name $$;
create or replace function public.billing_now() returns timestamptz language sql stable as $$ select now() $$;

-- ---------------------------------------------------------------- privileges
-- Server-side functions: service role only. (Supabase grants EXECUTE to anon/authenticated by default.)
do $$
declare f text;
begin
  foreach f in array array[
    'handle_new_auth_user()', 'recompute_entitlement(text, jsonb)', 'ingest_stripe_event(text, text, jsonb)',
    'claim_event_jobs(integer, integer)', 'complete_event_job(text)', 'fail_event_job(text, text, integer)',
    'requeue_event(text)', 'apply_subscription(text, text, text, text, text, integer, timestamptz, timestamptz, boolean, bigint, timestamptz, jsonb)',
    'acquire_lease(text, integer)', 'release_lease(text)', 'compute_entitlement(text, jsonb)', 'billing_now()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
grant execute on function public.my_entitlement() to authenticated;
