import type { Venue } from "@/lib/mock-data";

export default function VenueVisual({ venue }: { venue: Venue }) {
  if (venue.claimed && venue.heroImage) {
    return <img className="venue-hero-image" src={venue.heroImage} alt={`${venue.name} hero`} />;
  }

  if (venue.streetViewAvailable) {
    return (
      <div className="map-placeholder street-view">
        <span className="map-label">Google Street View</span>
        <strong>{venue.name}</strong>
        <small>{venue.address}</small>
      </div>
    );
  }

  return (
    <div className="map-placeholder roadmap">
      <div className="road road-a"/><div className="road road-b"/><div className="road road-c"/>
      <span className="map-pin">●</span>
      <span className="map-label">Map view</span>
      <strong>{venue.name}</strong>
      <small>{venue.address}</small>
    </div>
  );
}
