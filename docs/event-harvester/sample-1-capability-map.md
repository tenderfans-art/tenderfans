# Event Harvester — Sample 1 Capability Map

**Date:** 2026-09-30  
**Sample size:** 30 Spots  
**Detector baseline:** `ea98401`  
**Status:** Reconciled / Frozen

## Purpose

Sample 1 is the first manually reconciled Event Harvester detector baseline.

The detector output alone is not treated as ground truth. Each Spot was investigated as needed to distinguish:

- a currently supported event source,
- a reusable future adapter opportunity,
- an acquisition/transport problem,
- an attribution or identity problem,
- a genuinely inspected site with no usable event source,
- and a TenderFans Spot that should not currently drive Harvester engineering.

This file is intended to serve as:

1. a regression reference for future detector changes,
2. a historical record of what Sample 1 taught us,
3. a starting taxonomy for a future Admin → Harvester interface.

---

# Capability Taxonomy

These keys are intentionally machine-friendly. Human-facing Admin labels may change later without changing the underlying concepts.

## `supported`

A source technology is identified and TenderFans already has a working adapter/acquisition path for it.

## `adapter_candidate`

A structured source technology is identified and sufficient live inventory exists to build and validate a reusable adapter.

## `adapter_candidate_unproven`

A structured source technology is identified, but the observed instance does not contain enough live inventory to safely build and validate an adapter.

## `vision_adapter_candidate`

Event inventory is presented primarily through calendar/flyer imagery and could potentially be converted into structured events through a future vision/OCR extraction path.

## `browser_transport_required`

Standard HTTP acquisition cannot reliably inspect or acquire the source. Further legitimate browser, alternate transport, feed, API, or related acquisition investigation is required.

This classification does NOT imply that browser execution will necessarily solve the problem.

## `unsupported_indefinitely`

A source is identified, but TenderFans does not currently have a planned reliable ingestion path for it.

## `unreachable_retry`

The site/source could not currently be reached reliably enough to determine its event-source capability. It should be retried rather than classified as having no events.

## `inspected_no_source`

The site was successfully inspected and no usable event inventory/source was found.

This is different from a failed detector scan.

## `not_harvest_target`

The Spot may legitimately belong in TenderFans, but its current business/event profile does not justify Event Harvester engineering effort.

Being a TenderFans Spot does not automatically make a venue an Event Harvester target.

## `identity_resolution`

A discovered website, redirect, or event source cannot yet be safely established as representing the intended TenderFans Spot.

## `shared_source_unresolvable`

Event inventory can be extracted from a shared source, but the source does not expose enough reliable per-event venue identity to assign canonical events safely to the correct TenderFans Spot.

TenderFans must not guess attribution.

---

# Sample 1 Scanner Result

Final reconciled scanner run:

- Spots: 30
- Detected: 13
- No event source: 9
- Transport blocked: 6
- Transport failed: 1
- External redirect: 1
- Supported detections: 6
- Unsupported detections: 10
- Calendar-image detections: 6
- SpotHopper detections: 1
- Shared-event-calendar detections: 1

These are detector measurements, not final capability classifications.

---

# Sample 1 Capability Map

| # | Spot | Detector / Investigation Finding | Capability Key | Notes |
|---|---|---|---|---|
| 1 | Bayboro Brewing Co. | Eventbrite | `supported` | Existing Eventbrite adapter. Already harvested and bootstrapped. |
| 2 | OCC Road House & Museum | WordPress/AJAX source behind blocked acquisition | `browser_transport_required` | Event mechanism was identified during investigation. Standard HTTP acquisition remains the blocker. |
| 3 | Cowboys Dance Hall | Eventbrite + GoDaddy recurring events | `supported` | Existing GoDaddy recurring adapter is the primary solved acquisition path. Already harvested and bootstrapped. |
| 4 | Island Way Grill | No source found | `not_harvest_target` | Fine-dining-oriented Spot. Do not force Event Harvester coverage without evidence of meaningful event inventory. |
| 5 | Caretta on the Gulf | No source found | `not_harvest_target` | Fine-dining-oriented Spot. |
| 6 | Tropico Rooftop Cantina | Transport blocked | `not_harvest_target` | Hotel/rooftop context does not currently justify transport engineering effort. Transport issue remains contextual evidence. |
| 7 | The Spotted Donkey Cantina | Facebook | `unsupported_indefinitely` | Source identified, but Facebook is not currently a planned reliable ingestion path. |
| 8 | Sandbar Grill — Dunedin | CP Multi View Calendar + calendar image | `supported` | Dedicated CP Multi View Calendar adapter exists. Structured CP source takes precedence over the secondary calendar-image signal. |
| 9 | The Sandbar & Grille — Fort Myers | No source found | `not_harvest_target` | Wrong geography / bad sample entry for the intended local benchmark. Do not use it to drive detector engineering. |
| 10 | Toucans Bar & Grill | SpotHopper / SpotApps | `adapter_candidate_unproven` | Platform detected, but observed inventory was empty (`allEvents=[]`). Need a populated SpotHopper implementation before building/testing an adapter. |
| 11 | The Salty Crab Bar & Grill North Beach | Calendar image | `vision_adapter_candidate` | Candidate for image → vision/OCR → normalized event extraction. |
| 12 | Badfins Food + Brew | Transport blocked | `browser_transport_required` | Requires legitimate alternate/browser acquisition investigation. |
| 13 | Frenchy's South Beach Cafe | Transport blocked | `browser_transport_required` | Requires legitimate alternate/browser acquisition investigation. |
| 14 | Salt Cracker Fish Camp | Reachable; no usable source found | `inspected_no_source` | Current evidence supports a genuine no-source result. |
| 15 | Hyatt Regency Clearwater Beach Resort and Suites | Transport blocked | `not_harvest_target` | Resort/hotel context does not currently justify transport engineering effort. |
| 16 | Wave Nightclub at Shephard's | UVTix | `supported` | Dedicated UVTix adapter exists and previously extracted 26 events. Not bootstrapped only because development pivoted before that step. |
| 17 | Ocean Seven Restaurant | Squarespace event inventory / shared calendar | `shared_source_unresolvable` | Inventory is extractable, but underlying records do not reliably distinguish Ocean Seven from Sielo. Do not auto-assign shared events. |
| 18 | Marina Cantina | Reachable; no usable source found | `inspected_no_source` | No current event source identified. |
| 19 | Tate Island Grill — Sandpearl | No source found | `not_harvest_target` | Resort/fine-dining context. |
| 20 | Reefers Social Club | Redirect to branch.beer | `identity_resolution` | Destination/source identity must be resolved before event acquisition can be trusted. |
| 21 | The Boxer Kitchen & Bar | Transport blocked | `browser_transport_required` | Requires legitimate alternate/browser acquisition investigation. |
| 22 | Sielo Rooftop | Eventbrite + Linktree | `supported` | Eventbrite is the actionable supported source. Linktree is secondary/incidental. |
| 23 | Vue 360 Rooftop Bar | No source found; hotel/corporate sitemap noise | `not_harvest_target` | Hotel context; unrelated sitemap surfaces should not create compatibility. |
| 24 | The Deep End | No reliable source found | `not_harvest_target` | Previously discovered similarly named external inventory belonged to another venue. |
| 25 | Evy's Terrace Bar & Bistro | Transport failure | `unreachable_retry` | Do not interpret temporary/unresolved acquisition failure as absence of events. |
| 26 | Jimmy's Fish House & Iguana Bar | Calendar image | `vision_adapter_candidate` | Current live-entertainment page exposes a month/year entertainment calendar image. This finding drove the full-month calendar-image detector improvement. |
| 27 | Crabby's Bar & Grill Clearwater | Calendar image | `vision_adapter_candidate` | Reusable image-calendar family. |
| 28 | Crabby's Beachside Pavilion | Calendar image | `vision_adapter_candidate` | Reusable image-calendar family. |
| 29 | Crabby's Dockside Clearwater | Calendar image | `vision_adapter_candidate` | Reusable image-calendar family. |
| 30 | Sandbar — Opal Sands | No source found | `not_harvest_target` | Resort/fine-dining context. |

---

# Supported Source Families Demonstrated in Sample 1

Sample 1 proves automatic detection of several already-supported acquisition families:

- Eventbrite
- GoDaddy recurring events
- CP Multi View Calendar
- UVTix
- Squarespace event inventory

A technology being technically extractable does not automatically make its events safe to publish. Ocean Seven demonstrates the difference between extraction capability and reliable venue attribution.

---

# Calendar Image Family

The detector currently identifies six calendar-image signals in Sample 1.

Five distinct currently unsupported Spots are meaningful future vision-adapter candidates:

1. The Salty Crab Bar & Grill North Beach
2. Jimmy's Fish House & Iguana Bar
3. Crabby's Bar & Grill Clearwater
4. Crabby's Beachside Pavilion
5. Crabby's Dockside Clearwater

Sandbar Grill — Dunedin also exposes a calendar-image signal, but it already has the superior structured CP Multi View Calendar acquisition path.

Therefore the calendar-image count must not be interpreted as six Spots requiring vision extraction.

---

# Regression Truth Set

Future detector changes should preserve these known Sample-1 findings unless source websites themselves materially change:

- Bayboro → Eventbrite → supported
- Cowboys → GoDaddy recurring events → supported
- Sandbar Dunedin → CP Multi View Calendar → supported
- Wave → UVTix → supported
- Sielo → Eventbrite → supported
- Toucans → SpotHopper → detected, unsupported/unproven
- Salty Crab → calendar image
- Jimmy's → calendar image
- Crabby's Bar & Grill → calendar image
- Crabby's Beachside → calendar image
- Crabby's Dockside → calendar image
- Ocean Seven → Squarespace/shared-calendar condition requiring attribution caution

A known supported source falling to `no_event_source` is a regression unless the underlying website/source has changed.

---

# Important Interpretation Rules

## `no_event_source` is not proof that no events exist

It means the current detector did not identify an event source during that scan.

Jimmy's demonstrated this directly: it initially returned `no_event_source`, but manual investigation found a live entertainment page with a calendar image. The detector was then generically improved to recognize the full-month filename pattern.

## Detection is not publication authority

Finding an event source does not prove that events can safely be assigned to the Spot.

Ocean Seven demonstrates this distinction.

## Structured sources outrank image sources

When a reliable structured source and a calendar image coexist, use the structured source.

Sandbar Dunedin demonstrates this rule through CP Multi View Calendar.

## TenderFans Spot != Event Harvester target

Fine dining, resorts, hotels, and other legitimate TenderFans Spots should not automatically consume Harvester engineering effort when they do not meaningfully participate in the event ecosystem.

## Unknown capability should remain explicit

Do not guess source technology, venue identity, event attribution, or recurrence.

False unsupported is preferable to false compatibility.

---

# Potential Future Admin → Harvester Containers

The capability taxonomy is intentionally suitable for future operational Admin views.

Possible containers:

- Supported
- Adapter Candidates
- Adapter Candidates — Unproven
- Vision Adapter Candidates
- Browser / Transport Required
- Unsupported Indefinitely
- Unreachable / Retry
- Inspected / No Source
- Not Harvest Targets
- Identity Resolution
- Shared Source Unresolvable

These are research/evaluation concepts today.

Do not create database fields, migrations, automated state transitions, or Admin workflow behavior from this document until additional samples validate the taxonomy.

---

# Next Step

Run Sample 2 against the frozen Sample-1 detector baseline without tuning the detector first.

Investigate Sample-2 results individually, identify reusable patterns, and determine whether the capability taxonomy remains sufficient before designing persistent Harvester Admin state.
