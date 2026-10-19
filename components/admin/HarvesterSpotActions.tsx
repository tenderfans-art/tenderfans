"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

type Props = {
  venueId: string;
  venueName: string;
  bucket: "transport" | "no_source";
  onComplete: (venueId: string) => void;
};

export default function HarvesterSpotActions({
  venueId,
  venueName,
  bucket,
  onComplete,
}: Props) {
  const [action, setAction] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function execute() {
    if (!action || busy) return;

    const message =
      action === "remove"
        ? `Remove ${venueName} from TenderFans?\n\n` +
          "The Spot will no longer be publicly available, " +
          "but historical records will be retained."
        : `Archive ${venueName} from Harvester review?`;

    if (!window.confirm(message)) return;

    setBusy(true);
    setError("");

    const result =
      action === "remove"
        ? await supabase.rpc("admin_remove_spot", {
            p_venue_id: venueId,
          })
        : await supabase.rpc("admin_archive_harvest_spot", {
            p_venue_id: venueId,
            p_bucket: bucket,
          });

    setBusy(false);

    if (result.error) {
      setError(result.error.message);
      return;
    }

    onComplete(venueId);
  }

  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: "6px",
      flexWrap: "wrap",
    }}>
      <select
        aria-label={`Action for ${venueName}`}
        value={action}
        disabled={busy}
        onChange={(event) => setAction(event.target.value)}
        style={{ maxWidth: "105px" }}
      >
        <option value="">Actions</option>
        <option value="archive">Archive</option>
        <option value="remove">Remove</option>
      </select>

      <button
        type="button"
        className="btn outline"
        disabled={!action || busy}
        onClick={execute}
        style={{ padding: "5px 9px", fontSize: ".7rem" }}
      >
        {busy ? "..." : "Apply"}
      </button>

      {error && (
        <span role="alert" style={{ color: "crimson" }}>
          {error}
        </span>
      )}
    </div>
  );
}
