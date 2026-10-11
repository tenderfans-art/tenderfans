-- Trusted first-party source registration is server-only.
-- Preserve function bodies, source attribution, and sharing behavior.

REVOKE ALL ON FUNCTION public.upsert_first_party_event_source(
  uuid, text, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.upsert_global_first_party_event_source(
  text, text, text, text, jsonb
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.upsert_first_party_event_source(
  uuid, text, text, text, text, jsonb
) TO service_role;

GRANT EXECUTE ON FUNCTION public.upsert_global_first_party_event_source(
  text, text, text, text, jsonb
) TO service_role;
