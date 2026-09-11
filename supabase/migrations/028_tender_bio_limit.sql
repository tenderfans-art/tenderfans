-- ============================================================
-- 028 TENDER BIO LENGTH LIMIT
-- ============================================================

alter table public.bartenders
drop constraint if exists bartenders_bio_length_check;

alter table public.bartenders
add constraint bartenders_bio_length_check
check (
  bio is null
  or char_length(bio) <= 300
);
