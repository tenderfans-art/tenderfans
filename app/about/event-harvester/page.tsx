import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "TenderFans Event Harvester",
  description:
    "Information about the TenderFans Event Harvester and its crawling practices.",
};

export default function EventHarvesterPage() {
  return (
    <div className="flow-page">
      <div className="shell how-it-works-page">
        <section className="how-hero">
          <span className="eyebrow">TenderFans Crawler</span>
          <h1>TenderFans Event Harvester</h1>
          <p>
            TenderFans Event Harvester is an automated crawler operated by
            TenderFans LLC. It discovers publicly available event information
            from hospitality venue websites for inclusion in TenderFans event
            listings and discovery.
          </p>
        </section>

        <section className="how-steps">
          <div className="how-step">
            <span className="how-number">01</span>
            <div>
              <h2>Crawler identification</h2>
              <p>
                User-Agent: <code>TenderFans Event Harvester/1.0</code>
              </p>
              <p>
                TenderFans uses Web Bot Auth to cryptographically identify
                supported crawler requests.
              </p>
            </div>
          </div>

          <div className="how-step">
            <span className="how-number">02</span>
            <div>
              <h2>What we access</h2>
              <p>
                The harvester accesses publicly available pages and resources
                relevant to venue events, including event listings, calendars,
                and related event information. TenderFans links event
                information back to its original source when available.
              </p>
            </div>
          </div>

          <div className="how-step">
            <span className="how-number">03</span>
            <div>
              <h2>Crawling practices</h2>
              <p>
                TenderFans respects robots.txt and applicable crawl directives
                and uses reasonable request rates. The crawler is not intended
                to access authenticated, private, or restricted content.
              </p>
            </div>
          </div>

          <div className="how-step">
            <span className="how-number">04</span>
            <div>
              <h2>Operator</h2>
              <p>
                TenderFans LLC
                <br />
                tenderfans.com
              </p>
            </div>
          </div>

          <div className="how-step">
            <span className="how-number">05</span>
            <div>
              <h2>Questions or concerns</h2>
              <p>
                Website operators with questions about TenderFans Event
                Harvester or its access to their site can contact TenderFans at{" "}
                <a href="mailto:info@tenderfans.com">info@tenderfans.com</a>.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
