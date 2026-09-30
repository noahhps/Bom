-- Bom's remote relay.
--
-- A Bom server (the "host") runs on someone's own machine, next to Ollama.
-- It is usually behind a home router, so nothing can dial it. Instead it dials
-- out to this project's Realtime service and holds one private broadcast
-- channel open; the web client and the desktop app join the same channel and
-- send it requests. This file is everything the database has to know for that:
--
--   bom_hosts          one row per linked device, owned by one account
--   bom_pairings       short-lived: a device waiting for its owner to approve it
--   bom_pair_failures  wrong codes typed, so guessing one can be throttled
--
-- and the policies that decide who may use a host's channel: its owner and the
-- device itself, nobody else. Every write goes through the `bom-pair` edge
-- function (service role) or a SECURITY DEFINER function below -- no client can
-- insert, update or delete a row directly.

-- -- hosts ------------------------------------------------------------------

create table if not exists public.bom_hosts (
  id              uuid primary key default gen_random_uuid(),
  -- The account that approved the pairing. Only this account's clients may
  -- talk to the host.
  owner_id        uuid not null references auth.users (id) on delete cascade,
  -- The device's own sign-in: an account the edge function creates for it at
  -- pairing time. The device never holds its owner's credentials, and deleting
  -- this account is what unlinks it -- every session it had dies with it.
  device_user_id  uuid unique references auth.users (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80),
  platform        text check (platform is null or char_length(platform) <= 40),
  created_at      timestamptz not null default now(),
  -- Refreshed about once a minute while the host is connected.
  last_seen_at    timestamptz
);

create index if not exists bom_hosts_owner_idx on public.bom_hosts (owner_id);

alter table public.bom_hosts enable row level security;

-- Read-only to clients: an owner sees their devices, a device sees itself.
drop policy if exists "bom: owner or device reads host" on public.bom_hosts;
create policy "bom: owner or device reads host"
  on public.bom_hosts for select
  to authenticated
  using (owner_id = (select auth.uid()) or device_user_id = (select auth.uid()));

-- -- pairings ---------------------------------------------------------------
--
-- No policies at all: with RLS on, that means no client can read or write
-- this table. Only the edge function, holding the service role, touches it.

create table if not exists public.bom_pairings (
  id                uuid primary key default gen_random_uuid(),
  -- What the person types: 8 characters, shown on the device's screen.
  user_code         text not null unique,
  -- What the device polls with: 256 random bits, stored only as a SHA-256.
  device_code_hash  text not null unique,
  device_name       text not null check (char_length(device_name) between 1 and 80),
  platform          text,
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  approved_by       uuid references auth.users (id) on delete cascade,
  host_id           uuid references public.bom_hosts (id) on delete cascade,
  -- The device's credentials, held only between approval and the device's
  -- next poll, which deletes the row.
  device_email      text,
  device_secret     text
);

create index if not exists bom_pairings_expiry_idx on public.bom_pairings (expires_at);

alter table public.bom_pairings enable row level security;

create table if not exists public.bom_pair_failures (
  id       bigint generated always as identity primary key,
  user_id  uuid not null references auth.users (id) on delete cascade,
  at       timestamptz not null default now()
);

create index if not exists bom_pair_failures_user_idx on public.bom_pair_failures (user_id, at);

alter table public.bom_pair_failures enable row level security;

-- -- who may use a channel --------------------------------------------------
--
-- A host's channel is `bom:host:<host id>`. The id is a random UUID that only
-- its owner can read, so the name is not guessable -- but that is a second
-- line, not the first. The first is this check, applied by Realtime to every
-- private channel join and every message sent on one.

create or replace function public.bom_can_use_channel(topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  host uuid;
begin
  if topic is null
     or topic !~ '^bom:host:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  host := substring(topic from 10)::uuid;
  return exists (
    select 1
      from public.bom_hosts h
     where h.id = host
       and (h.owner_id = (select auth.uid()) or h.device_user_id = (select auth.uid()))
  );
end;
$$;

revoke execute on function public.bom_can_use_channel(text) from public, anon;
grant execute on function public.bom_can_use_channel(text) to authenticated;

drop policy if exists "bom: owner or device listens" on realtime.messages;
create policy "bom: owner or device listens"
  on realtime.messages for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and public.bom_can_use_channel((select realtime.topic()))
  );

drop policy if exists "bom: owner or device sends" on realtime.messages;
create policy "bom: owner or device sends"
  on realtime.messages for insert
  to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and public.bom_can_use_channel((select realtime.topic()))
  );

-- -- the device's heartbeat -------------------------------------------------
--
-- So the device list can say which hosts are up. The device may touch only
-- its own row, and only this column.

create or replace function public.bom_host_heartbeat()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.bom_hosts
     set last_seen_at = now()
   where device_user_id = (select auth.uid());
$$;

revoke execute on function public.bom_host_heartbeat() from public, anon;
grant execute on function public.bom_host_heartbeat() to authenticated;
