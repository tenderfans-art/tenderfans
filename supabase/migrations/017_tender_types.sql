-- ============================================================
-- 017_tender_types.sql
-- Expand the existing Tender architecture to support multiple
-- Tender types without renaming or replacing legacy bartender
-- tables, IDs, permissions, relationships, or RPCs.
-- ============================================================

create table if not exists public.tender_types (
  key text primary key,
  label text not null unique,
  description text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

insert into public.tender_types (
  key,
  label,
  description,
  active,
  sort_order
)
values
  (
    'bartender',
    'Bartender',
    'A Tender primarily serving guests from behind the bar.',
    true,
    10
  ),
  (
    'tabletender',
    'Tabletender',
    'A Tender primarily serving guests at tables or on the floor.',
    true,
    20
  )
on conflict (key) do update
set
  label = excluded.label,
  description = excluded.description,
  active = excluded.active,
  sort_order = excluded.sort_order;

alter table public.bartenders
  add column if not exists tender_type text;

update public.bartenders
set tender_type = 'bartender'
where tender_type is null;

alter table public.bartenders
  alter column tender_type set default 'bartender';

alter table public.bartenders
  alter column tender_type set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'bartenders_tender_type_fkey'
      and conrelid = 'public.bartenders'::regclass
  ) then
    alter table public.bartenders
      add constraint bartenders_tender_type_fkey
      foreign key (tender_type)
      references public.tender_types(key);
  end if;
end
$$;

alter table public.tender_types enable row level security;

drop policy if exists "public tender types" on public.tender_types;

create policy "public tender types"
on public.tender_types
for select
using (active = true);

create index if not exists bartenders_tender_type_idx
  on public.bartenders(tender_type);
