import EventsCalendar from "@/components/EventsCalendar";

export default function EventsPage() {
  return (
    <main className="events-page">
      <div className="shell">
        <div className="events-heading">
          <div>
            <h1>What&apos;s happening?</h1>
          </div>
        </div>

        <EventsCalendar />
      </div>
    </main>
  );
}

