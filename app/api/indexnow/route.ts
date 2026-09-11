import { NextRequest, NextResponse } from "next/server";
import { submitIndexNow } from "@/lib/indexnow";

function extractSitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)]
    .map((match) => match[1]?.trim())
    .filter((url): url is string => Boolean(url));
}

export async function POST(request: NextRequest) {
  const expectedSecret = process.env.INDEXNOW_ADMIN_SECRET;

  if (!expectedSecret) {
    return NextResponse.json(
      { error: "IndexNow admin secret is not configured." },
      { status: 500 }
    );
  }

  const auth = request.headers.get("authorization");

  if (auth !== `Bearer ${expectedSecret}`) {
    return NextResponse.json(
      { error: "Unauthorized." },
      { status: 401 }
    );
  }

  let body: {
    all?: boolean;
    urls?: string[];
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body." },
      { status: 400 }
    );
  }

  let urls: string[] = [];

  if (body.all === true) {
    const sitemapResponse = await fetch(
      "https://tenderfans.com/sitemap.xml",
      { cache: "no-store" }
    );

    if (!sitemapResponse.ok) {
      return NextResponse.json(
        {
          error: "Could not load TenderFans sitemap.",
          status: sitemapResponse.status,
        },
        { status: 502 }
      );
    }

    urls = extractSitemapUrls(await sitemapResponse.text());
  } else if (Array.isArray(body.urls)) {
    urls = body.urls;
  }

  if (!urls.length) {
    return NextResponse.json(
      { error: "No URLs supplied." },
      { status: 400 }
    );
  }

  const result = await submitIndexNow(urls);

  return NextResponse.json(result, {
    status: result.ok ? 200 : 502,
  });
}
