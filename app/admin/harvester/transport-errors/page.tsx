"use client";

import Link from "next/link";
import {
  useEffect,
  useState,
} from "react";
import {
  createClient,
} from "@supabase/supabase-js";

type Finding = {
  id: string;
  venue_id: string;
  venue_name: string;
  detector_status: string;
  website_url: string;
  fetched_url: string | null;
  error: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export default function TransportErrorsPage() {
  const [rows, setRows] =
    useState<Finding[]>([]);
  const [loading, setLoading] =
    useState(true);
  const [error, setError] =
    useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      const {
        data,
        error: rpcError,
      } = await supabase.rpc(
        "admin_event_harvest_transport_findings"
      );

      if (!active) return;

      if (rpcError) {
        setError(rpcError.message);
      } else {
        setRows(
          (data ?? []) as Finding[]
        );
      }

      setLoading(false);
    }

    void load();

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="admin-page">
      <div className="admin-shell">
        <Link
          href="/admin/harvester"
          className="admin-back-link"
        >
          ← Harvester Management
        </Link>

        <div className="admin-page-heading">
          <div>
            <div className="eyebrow">
              EVENT HARVESTER
            </div>
            <h1>
              Transport Errors
            </h1>
            <p>
              Spots whose websites could
              not be reached reliably by
              the scheduled detector.
            </p>
          </div>
        </div>

        {loading ? (
          <p>Loading findings…</p>
        ) : error ? (
          <p>{error}</p>
        ) : rows.length === 0 ? (
          <p>
            No active transport errors.
          </p>
        ) : (
          <div
            style={{
              display: "grid",
              gap: 12,
            }}
          >
            {rows.map((row) => (
              <div
                key={row.id}
                className="admin-tile"
              >
                <div>
                  <strong>
                    {row.venue_name}
                  </strong>
                </div>

                <div>
                  {row.detector_status}
                </div>

                <div>
                  <a
                    href={row.website_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open Spot website
                  </a>
                </div>

                {row.error ? (
                  <div>{row.error}</div>
                ) : null}

                <div>
                  Last seen:{" "}
                  {new Date(
                    row.last_seen_at
                  ).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
