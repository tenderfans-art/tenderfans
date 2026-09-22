import Link from "next/link";

type Audience = "public" | "tenders" | "spots";

type HowContent = {
  eyebrow: string;
  title: string;
  intro: string;
  steps: {
    title: string;
    text: string;
  }[];
  whyTitle: string;
  whyText: string;
  actionTitle: string;
  actionText: string;
  primary: {
    label: string;
    href: string;
  };
  secondary: {
    label: string;
    href: string;
  };
};

const content: Record<Audience, HowContent> = {
  public: {
    eyebrow: "How TenderFans Works",
    title: "Great hospitality deserves a shout.",
    intro:
      "TenderFans is built around a simple idea: recognize the people and places that make going out memorable — without turning it into another review site.",
    steps: [
      {
        title: "Find your spot.",
        text:
          "Search for the bar, brewery, restaurant or other hospitality spot where somebody made your experience better.",
      },
      {
        title: "Find your Tender.",
        text:
          "A Tender is anyone who makes your experience better from their side of the counter — Bartenders, Tabletenders (Servers), Budtenders, and more. Choose the Tender who deserves the recognition. If they're new to TenderFans, you can help get their profile started.",
      },
      {
        title: "Give them a Shout.",
        text:
          "Tell the community what they do well using positive traits and a shout style. No anonymous rants. No comment section. Just recognition for great hospitality.",
      },
      {
        title: "Build a reputation.",
        text:
          "Shouts add up. Over time, they show what each Tender is known for and help people discover the personalities behind their favorite spots.",
      },
    ],
    whyTitle: "People are more than a star rating.",
    whyText:
      "Traditional review sites usually rate the business. TenderFans puts the spotlight on the people creating the experience. Tenders can claim their profiles, add their own bio and imagery, and build a presence around the reputation their guests are already creating. Establishments benefit too. Great people help great spots get discovered.",
    actionTitle: "Someone deserve a Shout?",
    actionText: "Give them their props.",
    primary: {
      label: "Give a Shout",
      href: "/shout",
    },
    secondary: {
      label: "Discover TenderFans",
      href: "/discover",
    },
  },

  tenders: {
    eyebrow: "TenderFans for Tenders",
    title: "Your reputation should move with you.",
    intro:
      "TenderFans gives hospitality workers a place to build an identity around the work they do, the people they serve and the reputation they earn — even when the Spot behind them changes.",
    steps: [
      {
        title: "Claim your profile.",
        text:
          "Find your Tender profile and claim it. Once your connection is verified, you can take control of your Tender presence on TenderFans.",
      },
      {
        title: "Make it yours.",
        text:
          "Add your bio, photos and current Spots so guests can recognize you, follow you and find where you're working.",
      },
      {
        title: "Build through Shouts.",
        text:
          "Guest Shouts become part of your Tender presence, showing the positive traits and hospitality style people recognize you for.",
      },
      {
        title: "Stay connected.",
        text:
          "Tender Messages, followers and Spot connections help keep you connected as your hospitality career moves from one place to another.",
      },
    ],
    whyTitle: "Hospitality workers deserve their own identity.",
    whyText:
      "Your work is bigger than one shift or one establishment. TenderFans is designed to give Tenders a portable presence that can grow throughout a hospitality career. As the Tender community grows, Tender Health, Tender Money, Tender Families and Tender Tools are intended to expand that community into resources and opportunities built around hospitality workers.",
    actionTitle: "Ready to make it yours?",
    actionText: "Find and claim your Tender profile.",
    primary: {
      label: "Claim Profile",
      href: "/claim",
    },
    secondary: {
      label: "Find Tenders",
      href: "/discover",
    },
  },

  spots: {
    eyebrow: "TenderFans for Spots & Reps",
    title: "Great people make great Spots.",
    intro:
      "TenderFans gives hospitality establishments and industry partners a place to participate in a community built around the people, places and experiences that keep hospitality moving.",
    steps: [
      {
        title: "Claim your Spot.",
        text:
          "Verified Spot representatives can claim their establishment and manage its presence on TenderFans.",
      },
      {
        title: "Keep your Spot current.",
        text:
          "Manage photos, menus, specials and the Tenders currently associated with your Spot so guests can see what's happening now.",
      },
      {
        title: "Put events in front of people.",
        text:
          "Publish events for your Spot and reach people following the establishment as well as guests connected to current Tenders working there.",
      },
      {
        title: "Connect with the community.",
        text:
          "TenderFans helps Spots and industry representatives participate in a hospitality community centered on positive recognition, discovery and stronger connections.",
      },
    ],
    whyTitle: "The people and the place belong together.",
    whyText:
      "TenderFans doesn't separate great hospitality from the establishments where it happens. Spot profiles connect guests with current Tenders, events and useful information while giving verified representatives tools to keep their presence accurate. Industry partners can participate through promotions, events and future opportunities designed for the hospitality community.",
    actionTitle: "Part of the hospitality community?",
    actionText: "Claim your Spot or explore TenderFans partnerships.",
    primary: {
      label: "Claim a Spot",
      href: "/claim",
    },
    secondary: {
      label: "Partners",
      href: "/partners",
    },
  },
};

export default async function HowItWorksPage({
  searchParams,
}: {
  searchParams: Promise<{ for?: string }>;
}) {
  const params = await searchParams;

  const audience: Audience =
    params.for === "tenders"
      ? "tenders"
      : params.for === "spots"
        ? "spots"
        : "public";

  const page = content[audience];

  return (
    <main className="flow-page">
      <div className="shell how-it-works-page">

        <section className="how-hero">
          <span className="eyebrow">{page.eyebrow}</span>
          <h1>{page.title}</h1>
          <p>{page.intro}</p>
        </section>

        <nav
          className="how-audience-nav"
          aria-label="How TenderFans works for"
        >
          <Link
            href="/how-it-works"
            className={audience === "public" ? "active" : ""}
          >
            Public Users
          </Link>

          <span aria-hidden="true">|</span>

          <Link
            href="/how-it-works?for=tenders"
            className={audience === "tenders" ? "active" : ""}
          >
            Tenders
          </Link>

          <span aria-hidden="true">|</span>

          <Link
            href="/how-it-works?for=spots"
            className={audience === "spots" ? "active" : ""}
          >
            Spots &amp; Reps
          </Link>
        </nav>

        <section className="how-steps">
          {page.steps.map((step, index) => (
            <div className="how-step" key={step.title}>
              <span className="how-number">
                {String(index + 1).padStart(2, "0")}
              </span>

              <div>
                <h2>{step.title}</h2>
                <p>{step.text}</p>
              </div>
            </div>
          ))}
        </section>

        <section className="how-why">
          <span className="eyebrow">Why TenderFans?</span>
          <h2>{page.whyTitle}</h2>
          <p>{page.whyText}</p>
        </section>

        <section className="how-rule">
          <span className="eyebrow light">The TenderFans Rule</span>
          <h2>ALL stars. No takedowns. Just props.</h2>
          <p>
            TenderFans is for celebrating great hospitality — not tearing
            people down.
          </p>
        </section>

        <section className="how-actions">
          <h2>{page.actionTitle}</h2>
          <p>{page.actionText}</p>

          <div className="how-buttons">
            <Link href={page.primary.href} className="btn primary">
              {page.primary.label}
            </Link>

            <Link href={page.secondary.href} className="btn outline">
              {page.secondary.label}
            </Link>
          </div>
        </section>

      </div>
    </main>
  );
}
