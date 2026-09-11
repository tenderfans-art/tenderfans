"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function NewContestPage() {
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const [title, setTitle] = useState("");
  const [prizeText, setPrizeText] = useState("");
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("00:00");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("23:59");
  const [rulesText, setRulesText] = useState("");
  const [isActive, setIsActive] = useState(false);
  const [flyer, setFlyer] = useState<File | null>(null);

  useEffect(() => {
    async function verifyAdmin() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/login";
        return;
      }

      const { data: admin } = await supabase
        .from("platform_admins")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!admin) {
        window.location.href = "/account";
        return;
      }

      setLoading(false);
    }

    verifyAdmin();
  }, []);

  function validateFlyer(file: File) {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
    ];

    if (!allowedTypes.includes(file.type)) {
      return "Flyer must be a JPG, PNG or WebP image.";
    }

    if (file.size > 10 * 1024 * 1024) {
      return "Flyer must be 10 MB or smaller.";
    }

    return "";
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage("");

    if (!title.trim()) {
      setMessage("Enter a contest title.");
      return;
    }

    if (!prizeText.trim()) {
      setMessage("Enter the contest prize.");
      return;
    }

    if (!startDate || !startTime || !endDate || !endTime) {
      setMessage("Enter contest start and end dates/times.");
      return;
    }

    if (!flyer) {
      setMessage("A contest flyer is required.");
      return;
    }

    const flyerError = validateFlyer(flyer);

    if (flyerError) {
      setMessage(flyerError);
      return;
    }

    const startsAt = new Date(`${startDate}T${startTime}`);
    const endsAt = new Date(`${endDate}T${endTime}`);

    if (
      Number.isNaN(startsAt.getTime()) ||
      Number.isNaN(endsAt.getTime())
    ) {
      setMessage("Enter valid contest dates and times.");
      return;
    }

    if (endsAt <= startsAt) {
      setMessage("Contest end must be after contest start.");
      return;
    }

    setSubmitting(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setMessage("You must be signed in.");
      setSubmitting(false);
      return;
    }

    const safeName = flyer.name.replace(
      /[^a-zA-Z0-9._-]/g,
      "-"
    );

    const storagePath =
      `${user.id}/${crypto.randomUUID()}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from("contest-flyers")
      .upload(storagePath, flyer);

    if (uploadError) {
      setMessage(uploadError.message);
      setSubmitting(false);
      return;
    }

    const { data: publicUrlData } = supabase.storage
      .from("contest-flyers")
      .getPublicUrl(storagePath);

    if (isActive) {
      const { error: deactivateError } = await supabase
        .from("contests")
        .update({ is_active: false })
        .eq("is_active", true);

      if (deactivateError) {
        await supabase.storage
          .from("contest-flyers")
          .remove([storagePath]);

        setMessage(deactivateError.message);
        setSubmitting(false);
        return;
      }
    }

    const { error: insertError } = await supabase
      .from("contests")
      .insert({
        title: title.trim(),
        prize_text: prizeText.trim(),
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        flyer_url: publicUrlData.publicUrl,
        flyer_storage_path: storagePath,
        rules_text: rulesText.trim() || null,
        is_active: isActive,
        created_by: user.id,
      });

    if (insertError) {
      await supabase.storage
        .from("contest-flyers")
        .remove([storagePath]);

      setMessage(insertError.message);
      setSubmitting(false);
      return;
    }

    router.push("/admin/contests");
  }

  if (loading) {
    return (
      <main className="flow-page">
        <div className="shell narrow">
          <div className="flow-card">
            <p>Loading contest manager...</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flow-page">
      <div className="shell narrow">
        <section className="flow-card">
          <div className="eyebrow">TENDERFANS ADMIN</div>

          <h1>Create Contest</h1>

          <p className="lead-copy">
            Create a TenderFans contest. Admin-created contests do not
            require approval.
          </p>

          <form
            onSubmit={handleSubmit}
            style={{ display: "grid", gap: "16px" }}
          >
            <label>
              <strong>Contest Title</strong>
              <input
                className="field"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Tampa Bay's Top Tender"
              />
            </label>

            <label>
              <strong>Prize</strong>
              <input
                className="field"
                value={prizeText}
                onChange={(e) => setPrizeText(e.target.value)}
                placeholder="$1,000 Cash Prize"
              />
            </label>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "12px",
              }}
            >
              <label>
                <strong>Start Date</strong>
                <input
                  className="field"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </label>

              <label>
                <strong>Start Time</strong>
                <input
                  className="field"
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              </label>

              <label>
                <strong>End Date</strong>
                <input
                  className="field"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </label>

              <label>
                <strong>End Time</strong>
                <input
                  className="field"
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              </label>
            </div>

            <label>
              <strong>Contest Flyer</strong>
              <input
                className="field"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) =>
                  setFlyer(e.target.files?.[0] ?? null)
                }
              />
            </label>

            <label>
              <strong>Rules / Details</strong>
              <textarea
                className="field"
                value={rulesText}
                onChange={(e) => setRulesText(e.target.value)}
                rows={7}
                placeholder="Contest rules, eligibility, prize details and winner information..."
              />
            </label>

            <label
              style={{
                display: "flex",
                gap: "10px",
                alignItems: "flex-start",
              }}
            >
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                style={{ marginTop: "4px" }}
              />

              <span>
                <strong>Make this the active contest</strong>
                <br />
                <span style={{ color: "#697177" }}>
                  Activating this contest will deactivate any other
                  currently active contest.
                </span>
              </span>
            </label>

            {message && (
              <div className="privacy-note">
                {message}
              </div>
            )}

            <div
              style={{
                display: "flex",
                gap: "10px",
                flexWrap: "wrap",
              }}
            >
              <button
                className="btn primary"
                type="submit"
                disabled={submitting}
              >
                {submitting ? "Saving..." : "Create Contest"}
              </button>

              <Link
                className="btn outline"
                href="/admin/contests"
              >
                Cancel
              </Link>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}
