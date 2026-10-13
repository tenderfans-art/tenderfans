# Event Detector — Enriched Pre-Refresh Baseline

Original capture: 2026-10-13T01:02:05.154Z
Original Git commit: f6d2a8454f7173290445c87af4b2afa953a9ce1c

## Population and coverage

- All Spots: 316
- Eligible Spots: 291
- Eligible with validated first-party source: 86
- Eligible without validated first-party source: 205
- Eligible with any enabled source: 86
- Eligible without any enabled source: 205
- Without first-party source or active finding: 96
- With first-party source and active finding: 4
- Multiple active categories: 0

## Enabled sources by provider

| Provider | Source records |
|---|---:|
| first_party | 125 |

## Enabled first-party adapters

| Adapter type | Source records |
|---|---:|
| schema_org_events | 22 |
| spothopper_events | 21 |
| calendar_image | 16 |
| tribe_rest | 14 |
| squarespace_events | 12 |
| eventbrite_organizer | 11 |
| google_calendar | 8 |
| next_rsc_events | 3 |
| eventscalendar_events | 3 |
| godaddy_menu_recurring | 2 |
| wordpress_event_feed | 2 |
| beatgig_events | 2 |
| uvtix_events | 2 |
| ics | 1 |
| sociablekit_facebook_events | 1 |
| pwpc_events_calendar | 1 |
| eventer_events | 1 |
| cp_multi_view_calendar | 1 |
| shopify_events | 1 |
| bandzoogle_events | 1 |

## Findings by category

| Category | Active Spots | Historical Spots |
|---|---:|---:|
| calendar_image | 13 | 30 |
| facebook | 19 | 117 |
| browser_required | 2 | 4 |
| challenge_encountered | 0 | 2 |
| transport | 32 | 117 |
| no_source | 47 | 70 |
| html_error | 0 | 0 |

## Interpretation

- Validated sources remain successful even with zero events.
- Source coverage and event inventory are separate measurements.
- Active findings can coexist with validated sources.
- Historical findings remain visible after resolution.
- Missing active findings do not prove a Spot was scanned.
- This baseline uses only the original saved snapshot.

