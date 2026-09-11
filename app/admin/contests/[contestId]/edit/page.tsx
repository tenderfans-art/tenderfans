"use client";

import Link from "next/link";
import {
  FormEvent,
  useEffect,
  useState,
} from "react";
import {
  useParams,
  useRouter,
} from "next/navigation";
import { supabase } from "@/lib/supabase";

type Contest = {
  id: string;
  title: string;
  prize_text: string;
  starts_at: string;
  ends_at: string;
  flyer_url: string | null;
  flyer_storage_path: string | null;
  rules_text: string | null;
  is_active: boolean;
};

export default function EditContestPage() {
  const params = useParams<{ contestId: string }>();
  const router = useRouter();

  const contestId = params.contestId;

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  const [title, setTitle] = useState("");
  const [prizeText, setPrizeText] = useState("");

  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");

  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");

  const [rulesText, setRulesText] = useState("");
  const [isActive, setIsActive] = useState(false);

  const [currentFlyerUrl, setCurrentFlyerUrl] =
    useState("");

  const [currentFlyerPath, setCurrentFlyerPath] =
    useState("");

  const [replacementFlyer, setReplacementFlyer] =
    useState<File | null>(null);

  useEffect(() => {
    async function loadContest() {
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

      const { data, error } = await supabase
        .from("contests")
        .select(`
          id,
          title,
          prize_text,
          starts_at,
          ends_at,
          flyer_url,
          flyer_storage_path,
          rules_text,
          is_active
        `)
        .eq("id", contestId)
        .maybeSingle();

      if (error || !data) {
        setMessage(
          error?.message || "Contest could not be found."
        );
        setLoading(false);
        return;
      }

      const contest = data as Contest;

      const start = new Date(contest.starts_at);
      const end = new Date(contest.ends_at);

      setTitle(contest.title);
      setPrizeText(contest.prize_text);
      setRulesText(contest.rules_text ?? "");
      setIsActive(contest.is_active);

      setCurrentFlyerUrl(contest.flyer_url ?? "");
      setCurrentFlyerPath(
        contest.flyer_storage_path ?? ""
      );

      setStartDate(
        [
          start.getFullYear(),
          String(start.getMonth() + 1).padStart(2, "0"),
          String(start.getDate()).padStart(2, "0"),
        ].join("-")
      );

      setStartTime(
        [
          String(start.getHours()).padStart(2, "0"),
          String(start.getMinutes()).padStart(2, "0"),
        ].join(":")
      );

      setEndDate(
        [
          end.getFullYear(),
          String(end.getMonth() + 1).padStart(2, "0"),
          String(end.getDate()).padStart(2, "0"),
        ].join("-")
      );

      setEndTime(
        [
          String(end.getHours()).padStart(2, "0"),
          String(end.getMinutes()).padStart(2, "0"),
        ].join(":")
      );

      setLoading(false);
    }

    loadContest();
  }, [contestId]);

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

  async function handleSubmit(
    e: FormEvent<HTMLFormElement>
  ) {
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

    if (
      !startDate ||
      !startTime ||
      !endDate ||
      !endTime
    ) {
      setMessage(
        "Enter contest start and end dates/times."
      );
      return;
    }

    const startsAt = new Date(
      `${startDate}T${startTime}`
    );

    const endsAt = new Date(
      `${endDate}T${endTime}`
    );

    if (
      Number.isNaN(startsAt.getTime()) ||
      Number.isNaN(endsAt.getTime())
    ) {
      setMessage("Enter valid contest dates and times.");
      return;
    }

    if (endsAt <= startsAt) {
      setMessage(
        "Contest end must be after contest start."
      );
      return;
    }

    if (replacementFlyer) {
      const flyerError =
        validateFlyer(replacementFlyer);

      if (flyerError) {
        setMessage(flyerError);
        return;
      }
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

    let nextFlyerUrl = currentFlyerUrl;
    let nextFlyerPath = currentFlyerPath;
    let newFlyerPath = "";

    if (replacementFlyer) {
      const safeName =
        replacementFlyer.name.replace(
          /[^a-zA-Z0-9._-]/g,
          "-"
        );

      newFlyerPath =
        `${user.id}/${crypto.randomUUID()}-${safeName}`;

      const { error: uploadError } =
        await supabase.storage
          .from("contest-flyers")
          .upload(
            newFlyerPath,
            replacementFlyer
          );

      if (uploadError) {
        setMessage(uploadError.message);
        setSubmitting(false);
        return;
      }

      const { data: publicUrlData } =
        supabase.storage
          .from("contest-flyers")
          .getPublicUrl(newFlyerPath);

      nextFlyerUrl =
        publicUrlData.publicUrl;

      nextFlyerPath = newFlyerPath;
    }

    /*
     * If this contest is being activated,
     * deactivate any currently active contest first.
     */
    if (isActive) {
      const { error: deactivateError } =
        await supabase
          .from("contests")
          .update({ is_active: false })
          .eq("is_active", true);

      if (deactivateError) {
        if (newFlyerPath) {
          await supabase.storage
            .from("contest-flyers")
            .remove([newFlyerPath]);
        }

        setMessage(deactivateError.message);
        setSubmitting(false);
        return;
      }
    }

    const { error: updateError } =
      await supabase
        .from("contests")
        .update({
          title: title.trim(),
          prize_text: prizeText.trim(),
          starts_at: startsAt.toISOString(),
          ends_at: endsAt.toISOString(),
          flyer_url: nextFlyerUrl || null,
          flyer_storage_path:
            nextFlyerPath || null,
          rules_text:
            rulesText.trim() || null,
          is_active: isActive,
          updated_at: new Date().toISOString(),
        })
        .eq("id", contestId);

    if (updateError) {
      if (newFlyerPath) {
        await supabase.storage
          .from("contest-flyers")
          .remove([newFlyerPath]);
      }

      setMessage(updateError.message);
      setSubmitting(false);
      return;
    }

    /*
     * New contest data is safely saved.
     * Now remove the superseded flyer.
     */
    if (
      newFlyerPath &&
      currentFlyerPath &&
      currentFlyerPath !== newFlyerPath
    ) {
      const { error: removeError } =
        await supabase.storage
          .from("contest-flyers")
          .remove([currentFlyerPath]);

      if (removeError) {
        console.error(
          "Old contest flyer cleanup failed:",
          removeError
        );
      }
    }

    router.push("/admin/contests");
  }

  if (loading) {
    return (
      <main className="flow-page">
        <div className="shell narrow">
          <div className="flow-card">
            <p>Loading contest...</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flow-page">
      <div className="shell narrow">
        <section className="flow-card">
          <div className="eyebrow">
            TENDERFANS ADMIN
          </div>

          <h1>Edit Contest</h1>

          <p className="lead-copy">
            Update contest details or replace the
            contest artwork.
          </p>

          <form
            onSubmit={handleSubmit}
            style={{
              display: "grid",
              gap: "16px",
            }}
          >
            <label>
              <strong>Contest Title</strong>
              <input
                className="field"
                value={title}
                onChange={(e) =>
                  setTitle(e.target.value)
                }
              />
            </label>

            <label>
              <strong>Prize</strong>
              <input
                className="field"
                value={prizeText}
                onChange={(e) =>
                  setPrizeText(e.target.value)
                }
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
                  onChange={(e) =>
                    setStartDate(e.target.value)
                  }
                />
              </label>

              <label>
                <strong>Start Time</strong>
                <input
                  className="field"
                  type="time"
                  value={startTime}
                  onChange={(e) =>
                    setStartTime(e.target.value)
                  }
                />
              </label>

              <label>
                <strong>End Date</strong>
                <input
                  className="field"
                  type="date"
                  value={endDate}
                  onChange={(e) =>
                    setEndDate(e.target.value)
                  }
                />
              </label>

              <label>
                <strong>End Time</strong>
                <input
                  className="field"
                  type="time"
                  value={endTime}
                  onChange={(e) =>
                    setEndTime(e.target.value)
                  }
                />
              </label>
            </div>

            {currentFlyerUrl && (
              <div>
                <strong>Current Flyer</strong>

                <div
                  style={{
                    marginTop: "8px",
                    maxWidth: "260px",
                  }}
                >
                  <img
                    src={currentFlyerUrl}
                    alt="Current contest flyer"
                    style={{
                      display: "block",
                      width: "100%",
                      borderRadius: "12px",
                    }}
                  />
                </div>
              </div>
            )}

            <label>
              <strong>Replace Flyer</strong>

              <input
                className="field"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) =>
                  setReplacementFlyer(
                    e.target.files?.[0] ?? null
                  )
                }
              />

              <span
                style={{
                  display: "block",
                  marginTop: "5px",
                  color: "#697177",
                  fontSize: "0.8rem",
                }}
              >
                Leave blank to keep the current flyer.
              </span>
            </label>

            <label>
              <strong>Rules / Details</strong>

              <textarea
                className="field"
                value={rulesText}
                onChange={(e) =>
                  setRulesText(e.target.value)
                }
                rows={7}
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
                onChange={(e) =>
                  setIsActive(e.target.checked)
                }
                style={{ marginTop: "4px" }}
              />

              <span>
                <strong>
                  Make this the active contest
                </strong>

                <br />

                <span style={{ color: "#697177" }}>
                  Only one TenderFans contest can
                  be active at a time.
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
                type="submit"
                className="btn primary"
                disabled={submitting}
              >
                {submitting
                  ? "Saving..."
                  : "Save Contest"}
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
