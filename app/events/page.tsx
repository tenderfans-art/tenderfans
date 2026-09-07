import EventsCalendar from "@/components/EventsCalendar";

export default function EventsPage() {
  return (
    <main className="events-page">
      <div className="shell">
        <div className="events-heading">
          <div>
            <div className="eyebrow">TenderFans Events</div>
            <h1>What&apos;s happening?</h1>
            <p>
              Find live music, trivia, watch parties, specials and other
              happenings at Spots around town.
            </p>
          </div>
        </div>

        <EventsCalendar />
      </div>
    </main>
  );
}
