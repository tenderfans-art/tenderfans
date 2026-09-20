"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Tender = {
  id: string;
  slug: string;
  display_name: string;
  started_at: string | null;
};

export default function SpotTendersPage() {
  const params = useParams();
  const venueId = params.venueId as string;

  const [spotName, setSpotName] = useState("");
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [endingId, setEndingId] = useState<string | null>(null);

  useEffect(() => {
    async function loadPage() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/login";
        return;
      }

      const { data: permission, error: permissionError } =
        await supabase
          .from("venue_permissions")
          .select("venue_id, can_edit")
          .eq("venue_id", venueId)
          .eq("user_id", user.id)
          .maybeSingle();

      if (
        permissionError ||
        !permission ||
        !permission.can_edit
      ) {
        setMessage(
          permissionError?.message ??
            "You do not have permission to manage this Spot."
        );
        setLoading(false);
        return;
      }

      const { data: venue, error: venueError } =
        await supabase
          .from("venues")
          .select("name")
          .eq("id", venueId)
          .single();

      if (venueError) {
        setMessage(venueError.message);
        setLoading(false);
        return;
      }

      setSpotName(venue.name);

      const { data: relationships, error: relationshipError } =
        await supabase
          .from("bartender_venues")
          .select(`
            bartender_id,
            started_at,
            bartenders (
              id,
              slug,
              display_name
            )
          `)
          .eq("venue_id", venueId)
          .eq("is_current", true);

      if (relationshipError) {
        setMessage(relationshipError.message);
        setLoading(false);
        return;
      }

      const currentTenders: Tender[] = [];

      for (const relationship of relationships ?? []) {
        const bartender = Array.isArray(relationship.bartenders)
          ? relationship.bartenders[0]
          : relationship.bartenders;

        if (bartender) {
          currentTenders.push({
            id: bartender.id,
            slug: bartender.slug,
            display_name: bartender.display_name,
            started_at: relationship.started_at,
          });
        }
      }

      currentTenders.sort((a, b) =>
        a.display_name.localeCompare(b.display_name)
      );

      setTenders(currentTenders);
      setLoading(false);
    }

    loadPage();
  }, [venueId]);

  async function endAssociation(tender: Tender) {
    const confirmed = window.confirm(
      `End ${tender.display_name}'s current association with ${spotName}? ` +
        `They will no longer appear as a current Tender at this Spot. ` +
        `Their Tender profile and relationship history will not be deleted.`
    );

    if (!confirmed) return;

    setEndingId(tender.id);
    setMessage("");

    const { error } = await supabase.rpc(
      "end_spot_tender_association",
      {
        p_venue_id: venueId,
        p_bartender_id: tender.id,
      }
    );

    if (error) {
      setMessage(error.message);
      setEndingId(null);
      return;
    }

    setTenders((current) =>
      current.filter((item) => item.id !== tender.id)
    );

    setEndingId(null);
  }

  return (
    <main className="flow-page">
      <div className="shell">
        <div
          className="flow-card"
          style={{
            maxWidth: "760px",
            margin: "0 auto",
          }}
        >
          <div className="eyebrow">Spot Owner Account</div>
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: "14px",
              flexWrap: "wrap",
            }}
          >
            <h1 style={{ marginBottom: 0 }}>
              Manage Tenders
            </h1>

            {spotName && (
              <span
                style={{
                  color: "#697177",
                  fontSize: "1rem",
                }}
              >
                Current Tenders at {spotName}.
              </span>
            )}
          </div>

          <div style={{ marginBottom: "24px" }}>
            <Link href="/account/spot">
              ← Back to Spot dashboard
            </Link>
          </div>

          {loading && <p>Loading current Tenders...</p>}

          {message && (
            <p style={{ color: "crimson" }}>
              {message}
            </p>
          )}

          {!loading && !message && tenders.length === 0 && (
            <div
              style={{
                padding: "18px",
                border: "1px solid #ddd",
                borderRadius: "14px",
              }}
            >
              <strong>No current Tenders.</strong>
              <p style={{ marginBottom: 0 }}>
                There are no current Tender profiles associated
                with this Spot.
              </p>
            </div>
          )}

          {!loading && tenders.length > 0 && (
            <div
              style={{
                borderTop: "1px solid #d7d1c6",
              }}
            >
              {tenders.map((tender) => (
                <div
                  key={tender.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) 150px auto",
                    alignItems: "center",
                    gap: "16px",
                    padding: "12px 0",
                    borderBottom: "1px solid #d7d1c6",
                  }}
                >
                  <div>
                    <Link
                      href={`/t/${tender.slug}`}
                      style={{
                        color: "inherit",
                        textDecoration: "none",
                      }}
                    >
                      <strong>{tender.display_name}</strong>
                    </Link>
                  </div>

                  <div
                    style={{
                      fontSize: "0.84rem",
                      color: "#697177",
                    }}
                  >
                    {tender.started_at
                      ? new Date(
                          `${tender.started_at}T00:00:00`
                        ).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })
                      : "Start date unavailable"}
                  </div>

                  <button
                    type="button"
                    disabled={endingId === tender.id}
                    onClick={() => endAssociation(tender)}
                    style={{
                      padding: "7px 10px",
                      border: "1px solid #b9b2a8",
                      borderRadius: "8px",
                      background: "transparent",
                      cursor:
                        endingId === tender.id
                          ? "default"
                          : "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {endingId === tender.id
                      ? "Ending..."
                      : "End Association"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
