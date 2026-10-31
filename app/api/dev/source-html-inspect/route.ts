import { NextResponse } from "next/server";
import { signedHarvesterFetch } from "@/lib/event-harvester/signed-fetch";
import { runWithTransportRecovery } from "@/lib/event-harvester/transport-recovery-context";

export const dynamic = "force-dynamic";

const TARGET = "https://category36taphouse.com/events";

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const proxy = process.env.TENDERFANS_TRANSPORT_PROXY_URL;

  if (!proxy) {
    return NextResponse.json(
      { error: "Recovery proxy not configured" },
      { status: 500 }
    );
  }

  try {
    const response = await runWithTransportRecovery(
      proxy,
      () => signedHarvesterFetch(
        TARGET,
        {
          headers: {
            "User-Agent": "TenderFans Event Harvester/1.0",
            "Accept": "text/html",
          },
        },
        proxy
      )
    );

    const html = await response.text();

    const markers = [
      "wordpress",
      "wp-content",
      "elementor",
      "wix",
      "squarespace",
      "weebly",
      "editmysite",
      "squareup",
      "toasttab",
      "spoton",
      "eventbrite",
      "ticketleap",
      "tribe-events",
      "the-events-calendar",
      "schema.org/Event",
      "application/ld+json",
      "__NEXT_DATA__",
      "__NUXT__",
      "cloudflare",
      "cf-chl",
    ];

    const platformMarkers = markers
      .map(marker => ({
        marker,
        count:
          html.toLowerCase().split(marker.toLowerCase()).length - 1,
      }))
      .filter(item => item.count > 0);

    const excerpts: string[] = [];

    const eventPattern =
      /bandingo|music bingo|murder mystery|sold out|event|calendar|ticket|startDate/gi;

    let match: RegExpExecArray | null;

    while (
      (match = eventPattern.exec(html)) &&
      excerpts.length < 30
    ) {
      const start = Math.max(0, match.index - 180);
      const end = Math.min(html.length, match.index + 350);

      excerpts.push(
        html.slice(start, end)
          .replace(/<script[\s\S]*?<\/script>/gi, "[SCRIPT]")
          .replace(/\s+/g, " ")
          .slice(0, 530)
      );

      eventPattern.lastIndex =
        Math.max(eventPattern.lastIndex, match.index + 100);
    }

    const eventMarkup = [
      /"@type"\s*:\s*"Event"/gi,
      /"startDate"\s*:/gi,
      /data-event/gi,
      /event-card/gi,
      /event-list/gi,
      /<iframe\b[^>]*>/gi,
    ].map(pattern => {
      const matches = [...html.matchAll(pattern)];

      return {
        pattern: pattern.source,
        count: matches.length,
        examples: matches.slice(0, 3).map(item =>
          html.slice(
            Math.max(0, item.index! - 100),
            Math.min(html.length, item.index! + 250)
          ).replace(/\s+/g, " ")
        ),
      };
    });

    const links = [
      ...html.matchAll(
        /<(?:a|iframe|script)\b[^>]*(?:href|src)=["']([^"']+)["']/gi
      ),
    ]
      .map(match => match[1])
      .filter(url =>
        /event|calendar|ticket|music|bingo|booking|reservation/i.test(url)
      )
      .filter(url =>
        !/signature|token|auth|key|secret|captcha|challenge/i.test(url)
      )
      .map(url => url.split("?")[0])
      .filter((url, index, all) => all.indexOf(url) === index)
      .slice(0, 35);

    return NextResponse.json({
      status: response.status,
      finalUrl: response.url,
      htmlBytes: html.length,
      platformMarkers,
      excerpts,
      eventMarkup,
      links,
    });

  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error
        ? error.message
        : String(error),
    }, { status: 500 });
  }
}
