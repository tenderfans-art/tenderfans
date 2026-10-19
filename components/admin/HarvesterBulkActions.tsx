"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

type Spot = {
  id: string;
  name: string;
};

type Props = {
  bucket: "transport" | "no_source";
  selected: Spot[];
  onComplete: (completedIds: string[]) => void;
};

export default function HarvesterBulkActions({
  bucket,
  selected,
  onComplete,
}: Props) {
  const [action, setAction] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  async function apply() {
    if (busy || !action || selected.length === 0) {
      return;
    }

    const operation =
      action === "archive" ? "Archive" : "Remove";

    const warning =
      action === "remove"
        ? "This uses the existing Manage Spots removal " +
          "mechanism. Removed Spots will no longer be public."
        : "Archived Spots retain their historical records.";

    if (
      !window.confirm(
        `${operation} ${selected.length} selected ` +
        `Spot(s)?\n\n${warning}`
      )
    ) {
      return;
    }

    // Snapshot the selection to prevent changes during processing.
    const batch = [...selected];

    setBusy(true);
    setError("");
    setProgress("");

    const completed: string[] = [];
    const failures: string[] = [];

    for (let index = 0; index < batch.length; index++) {
      const spot = batch[index];

      setProgress(`${index + 1} / ${batch.length}`);

      try {
        const result =
          action === "archive"
            ? await supabase.rpc(
                "admin_archive_harvest_spot",
                {
                  p_venue_id: spot.id,
                  p_bucket: bucket,
                }
              )
            : await supabase.rpc(
                "admin_remove_spot",
                {
                  p_venue_id: spot.id,
                }
              );

        if (result.error) {
          failures.push(
            `${spot.name}: ${result.error.message}`
          );
        } else {
          completed.push(spot.id);
        }
      } catch (caught) {
        failures.push(
          `${spot.name}: ${
            caught instanceof Error
              ? caught.message
              : "Unexpected error"
          }`
        );
      }
    }

    if (completed.length) {
      onComplete(completed);
    }

    setProgress(
      `${completed.length} succeeded; ` +
      `${failures.length} failed`
    );

    if (failures.length) {
      setError(failures.join("\n"));
    }

    setBusy(false);
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        flexWrap: "wrap",
      }}
    >
      <select
        aria-label="Bulk Spot action"
        value={action}
        disabled={busy || selected.length === 0}
        onChange={(event) =>
          setAction(event.target.value)
        }
      >
        <option value="">Bulk actions</option>
        <option value="archive">Archive selected</option>
        <option value="remove">Remove selected</option>
      </select>

      <button
        type="button"
        className="btn outline"
        disabled={
          busy ||
          !action ||
          selected.length === 0
        }
        onClick={apply}
      >
        {busy ? "Processing..." : "Apply"}
      </button>

      {progress && (
        <small>{progress}</small>
      )}

      {error && (
        <p
          role="alert"
          style={{
            color: "crimson",
            whiteSpace: "pre-wrap",
            width: "100%",
          }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
