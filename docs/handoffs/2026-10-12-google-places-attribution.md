# TenderFans — Event Harvester Milestone
Date: October 12, 2026
Milestone: Google Places Address-Based Venue Attribution

## Achievement

Implemented and validated a generic Google Places discovery workflow
for first-party event venue attribution.

The system can discover actual businesses when an event publisher
provides a geographic venue label alongside a street address.

## Architecture

- Google Places Text Search using publisher venue evidence.
- Address-only Text Search when sufficient location evidence exists.
- Nearby Search around an address result to discover actual businesses.
- Deduplication of Google candidates by Place ID.
- Rejection of plain street-address placeholders.
- Exact-address business candidate qualification.
- Existing name-based identity matching retained.
- Ambiguous or unresolved identities remain outside automatic publication.
- Admin-review workflow retained for unresolved event venues.

## Validated Cases

1. 41 Baymont St, Clearwater, FL 33767
   Google business: Frenchy's Original Cafe
   Address qualified: true
   Google qualified: true
   Review only: false

2. 501 Causeway Blvd, Dunedin, FL 34698
   Google business: Frenchy's Stone Crab and Seafood Market
   Address qualified: true
   Google qualified: true
   Review only: false

3. 483 Mandalay Ave, Clearwater Beach, FL 33767
   No qualifying candidate returned.
   No automatic qualification.

4. 1 Causeway Blvd, Dunedin, FL 34698
   No qualifying candidate returned.
   No automatic qualification.

Integration tests: 4/4 passed.

Note: Cases 3 and 4 did not establish exhaustive
multi-business ambiguity handling.

## Build Validation

- npx tsc --noEmit: PASS
- git diff --check: PASS
- npm run build: PASS
- Next.js 16.3.3

## Important Remaining Work

- Verify behavior when multiple actual Google businesses share
  one exact street address.
- Verify Supabase Spot upsert and event ingestion end-to-end.
- Verify the Admin unresolved-event review and approval replay.
- Confirm migration 075 is applied in the target database.
- Verify production Vercel deployment and relevant routes.
- Continue reviewing the next first-party event publisher group.

## Development Agreement

- Never implement venue-specific fixes to generic attribution logic.
- Inspect existing code before patching.
- Use the smallest compatible change.
- Bundle related terminal operations and tests.
- Prefer guarded, terminal-executable patches.
- Avoid repeated inspections when current evidence is sufficient.
- Run TypeScript and production build before deployment.
- Stage intended files explicitly.
- Preserve unrelated work and never delete files without review.
- Prepare a detailed handoff before extended development breaks.
