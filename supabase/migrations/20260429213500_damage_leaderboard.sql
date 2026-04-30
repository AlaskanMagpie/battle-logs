create table if not exists public.damage_leaderboard (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  username text,
  damage integer not null check (damage >= 0),
  phase text not null check (phase in ('win', 'lose')),
  duration_ticks integer not null check (duration_ticks >= 0),
  match_mode text not null check (match_mode in ('ai', 'pvp', 'fallback_ai')),
  map_id text,
  client_match_id text
);

alter table public.damage_leaderboard enable row level security;

create index if not exists damage_leaderboard_top_damage_idx
  on public.damage_leaderboard (damage desc, duration_ticks asc, created_at asc);

drop policy if exists "damage leaderboard public read" on public.damage_leaderboard;
create policy "damage leaderboard public read"
  on public.damage_leaderboard
  for select
  to anon, authenticated
  using (true);

drop policy if exists "damage leaderboard constrained anonymous insert" on public.damage_leaderboard;
create policy "damage leaderboard constrained anonymous insert"
  on public.damage_leaderboard
  for insert
  to anon, authenticated
  with check (
    damage between 0 and 2000000000
    and duration_ticks between 0 and 2000000000
    and phase in ('win', 'lose')
    and match_mode in ('ai', 'pvp', 'fallback_ai')
    and (username is null or char_length(username) <= 32)
    and (map_id is null or char_length(map_id) <= 128)
    and (client_match_id is null or char_length(client_match_id) <= 96)
  );
