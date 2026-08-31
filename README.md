# TenderFans V1

A deliberately small public product with an extensible hospitality data model.

## V1 public surface
- `/` — search/discovery home
- `/shout` — venue-first structured shout-out flow
- `/t/[slug]` — permanent bartender bio card/profile URL (QR-ready)
- `/s/[slug]` — permanent Spot profile URL (QR-ready)
- `/claim` — bartender/business claim entry point

## Product rules baked into the architecture
- Users do not write public reviews/comments.
- Public users do not upload images.
- Bartender and business records exist independently of login accounts.
- Claims grant permissions; they do not replace entity IDs.
- Shout-outs always point to durable `bartender_id` + `venue_id`.
- Duplicate bartenders are merged into a canonical ID; aliases are retained.
- A bartender can have multiple current/historical venue relationships.
- A business can have multiple authorized owners/managers.
- Owner/bartender galleries share one permissioned `media_assets` system.
- Venue creation is designed for TenderFans DB search first, then Google Places fallback.
- Unclaimed venue image order: Google Street View → standard roadmap → branded fallback.
- Claimed venue image order: owner hero → gallery → map fallbacks.
- Analytics are aggregate-friendly; no user location-history model is included.

## Near-future modules reserved in schema
Events, promoted events, menu links, product/affiliate/sponsored links, competitions, competition entries and awards.

## Google implementation notes
The current UI uses mock map panels. Production wiring should use Google Places for new venue resolution and Street View/Static Maps dynamically rather than storing Google imagery in Supabase.

## Run
```bash
npm install
npm run dev
```

## Current landing-page prototype
The locked two-silhouette bar artwork is now at `public/landing-bar.png`.

Desktop assignment:
- **Male / left silhouette:** public `Give a Shout` entry.
- **Female / right silhouette:** bartender / owner login, profile claim, account creation.

The UI panels are real HTML overlays positioned over the black silhouette interiors. Mobile intentionally switches to stacked touch-friendly action cards rather than shrinking forms into the figures.

### Instant preview without installing packages
Open `prototype-preview.html` directly in a browser. It includes the landing-page interaction and a clickable mock `Spot → Tender → Props` flow without requiring Next.js or npm.
