"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { bartenders, venues } from "@/lib/mock-data";
import { supabase } from "@/lib/supabase";
import GooglePlacePicker from "@/components/GooglePlacePicker";

export default function ShoutFlow({
  initialTenderSlug,
  contestMode = false,
}: {
  initialTenderSlug?: string;
  contestMode?: boolean;
}) {
  const [step, setStep] = useState(1);
  const [venueQuery, setVenueQuery] = useState("");
  const [venueId, setVenueId] = useState("");
  const [bartenderQuery, setBartenderQuery] = useState("");
  const [bartenderId, setBartenderId] = useState("");
  const [traits, setTraits] = useState<string[]>([]);
  const [liveTraits, setLiveTraits] = useState<string[]>([]);
  const [voices, setVoices] = useState<string[]>([]);
  const [liveVenues, setLiveVenues] = useState<any[]>([]);
  const [liveBartenders, setLiveBartenders] = useState<any[]>([]);
  const [searchTenders, setSearchTenders] = useState<any[]>([]);
  const [googleVenue, setGoogleVenue] = useState<any>(null);

  const [contestPhone, setContestPhone] = useState("");
  const [contestTermsAccepted, setContestTermsAccepted] = useState(false);
  const [marketingSmsConsent, setMarketingSmsConsent] = useState(false);
  const [contestCode, setContestCode] = useState("");
  const [contestChallengeId, setContestChallengeId] = useState("");
  const [contestPendingVoice, setContestPendingVoice] = useState("");
  const [contestMessage, setContestMessage] = useState("");
  const [contestSubmitting, setContestSubmitting] = useState(false);
  const [developmentCode, setDevelopmentCode] = useState("");
  useEffect(() => {
    const loadOptions = async () => {
      const { data: traitData } = await supabase.from("traits").select("label").eq("audience", "bartender").eq("active", true).order("id");
      const { data: voiceData } = await supabase.from("voices").select("name").eq("active", true).order("id");
      const { data: venueData } = await supabase
        .from("venues")
        .select("id, slug, name, city, street_address, state_region")
        .eq("status", "active")
        .order("name");

      const { data: tenderData, error: tenderSearchError } =
        await supabase
          .from("bartender_venues")
          .select(`
            bartender_id,
            venue_id,
            is_primary,
            bartenders!inner(
              id,
              slug,
              display_name,
              status
            ),
            venues!inner(
              id,
              slug,
              name,
              city,
              street_address,
              state_region,
              status
            )
          `)
          .eq("is_current", true)
          .eq("bartenders.status", "active")
          .eq("venues.status", "active")
          .order("is_primary", { ascending: false });

      if (tenderSearchError) {
        console.error(
          "Could not load Tenders for Shout search:",
          tenderSearchError
        );
      }

      setLiveTraits((traitData ?? []).map(t => t.label));
      setVoices((voiceData ?? []).map(v => v.name));
      setLiveVenues(venueData ?? []);
      setSearchTenders(tenderData ?? []);
    };
    loadOptions();
  }, []);

  useEffect(() => {
    if (!initialTenderSlug) return;

    async function loadContestTender() {
      const { data: tender, error: tenderError } = await supabase
        .from("bartenders")
        .select("id, slug, display_name, status")
        .eq("slug", initialTenderSlug)
        .eq("status", "active")
        .maybeSingle();

      if (tenderError || !tender) {
        console.error("Could not load contest Tender:", tenderError);
        return;
      }

      const { data: relationships, error: relationshipError } =
        await supabase
          .from("bartender_venues")
          .select("venue_id, is_primary")
          .eq("bartender_id", tender.id)
          .eq("is_current", true)
          .order("is_primary", { ascending: false })
          .limit(1);

      if (relationshipError || !relationships?.length) {
        console.error(
          "Could not load contest Tender Spot:",
          relationshipError
        );
        return;
      }

      const selectedRelationship = relationships[0];
      const selectedVenueId = selectedRelationship.venue_id;

      const { data: venue, error: venueError } = await supabase
        .from("venues")
        .select("id, slug, name, city, street_address, state_region")
        .eq("id", selectedVenueId)
        .eq("status", "active")
        .maybeSingle();

      if (venueError || !venue) {
        console.error("Could not load contest Spot:", venueError);
        return;
      }

      setLiveVenues((current) => [
        ...current.filter((item) => item.id !== venue.id),
        venue,
      ]);

      setVenueId(venue.id);

      setLiveBartenders((current) => [
        ...current.filter((item) => item.id !== tender.id),
        tender,
      ]);

      setBartenderId(tender.id);
      setStep(3);
    }

    loadContestTender();
  }, [initialTenderSlug]);

  useEffect(() => {
  async function loadBartenders() {
    if (!venueId) {
      setLiveBartenders([]);
      return;
    }

    const { data, error } = await supabase
      .from("bartender_venues")
      .select("bartender_id, bartenders(id, slug, display_name, status)")
      .eq("venue_id", venueId)
      .eq("is_current", true);

    if (error) {
      console.error(error);
      setLiveBartenders([]);
      return;
    }

    setLiveBartenders((data ?? []).map((row:any) => row.bartenders).filter(Boolean));
  }

  loadBartenders();
}, [venueId]);

  const selectedVenue = liveVenues.find(v => v.id === venueId);
  const selectedBartender = liveBartenders.find(b => b.id === bartenderId);
  const venueMatches = useMemo(
    () =>
      venueQuery.trim()
        ? liveVenues
            .filter((v) =>
              `${v.name ?? ""} ${v.city ?? ""}`
                .toLowerCase()
                .includes(venueQuery.trim().toLowerCase())
            )
            .slice(0, 5)
        : [],
    [liveVenues, venueQuery]
  );

  const tenderMatches = useMemo(() => {
    const query = venueQuery.trim().toLowerCase();

    if (!query) return [];

    const seen = new Set<string>();

    return searchTenders
      .filter((row: any) => {
        const tender = Array.isArray(row.bartenders)
          ? row.bartenders[0]
          : row.bartenders;

        return tender?.display_name
          ?.toLowerCase()
          .includes(query);
      })
      .filter((row: any) => {
        const tender = Array.isArray(row.bartenders)
          ? row.bartenders[0]
          : row.bartenders;

        if (!tender?.id || seen.has(tender.id)) {
          return false;
        }

        seen.add(tender.id);
        return true;
      })
      .slice(0, 5);
  }, [searchTenders, venueQuery]);

  const bartenderMatches = useMemo(
    () =>
      liveBartenders
        .filter((b) =>
          b.display_name
            .toLowerCase()
            .includes(bartenderQuery.toLowerCase())
        )
        .slice(0, 5),
    [liveBartenders, bartenderQuery]
  );
  const toggleTrait = (trait:string) => setTraits(current => current.includes(trait) ? current.filter(t=>t!==trait) : current.length < 5 ? [...current, trait] : current);

  async function submitContestShout(
    voiceOverride?: string
  ) {
    if (!selectedBartender || !selectedVenue) return false;

    const voice =
      voiceOverride ||
      contestPendingVoice ||
      (document.querySelector(
        ".voice-row select"
      ) as HTMLSelectElement | null)?.value ||
      "";

    if (!voice) {
      setContestMessage("Select a Shout style.");
      return false;
    }

    setContestPendingVoice(voice);
    setContestSubmitting(true);
    setContestMessage("");

    try {
      const response = await fetch("/api/contest/shout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          bartenderId: selectedBartender.id,
          venueId: selectedVenue.id,
          voiceName: voice,
          traits,
        }),
      });

      const result = await response.json();

      if (response.ok) {
        setContestSubmitting(false);
        setStep(4);
        return true;
      }

      if (result?.needsVerification) {
        setContestSubmitting(false);
        setStep(5);
        return false;
      }

      if (result?.cooldown) {
        let message =
          result.error ||
          "You already gave this Tender a contest Shout within the last 7 days.";

        if (result.nextEligibleAt) {
          const next = new Date(result.nextEligibleAt);

          if (!Number.isNaN(next.getTime())) {
            message += ` You can Shout this Tender again ${next.toLocaleString()}.`;
          }
        }

        setContestMessage(message);
        setContestSubmitting(false);
        return false;
      }

      setContestMessage(
        result?.error ||
          "Could not save your contest Shout."
      );
      setContestSubmitting(false);
      return false;
    } catch (error) {
      console.error("Contest Shout failed:", error);

      setContestMessage(
        "Could not save your contest Shout."
      );
      setContestSubmitting(false);
      return false;
    }
  }

  async function sendContestVerification() {
    setContestSubmitting(true);
    setContestMessage("");
    setDevelopmentCode("");

    try {
      const response = await fetch(
        "/api/contest/verification/send",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            phone: contestPhone,
            contestTermsAccepted,
            marketingOptIn: marketingSmsConsent,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        setContestMessage(
          result?.error ||
            "Could not send the verification code."
        );
        setContestSubmitting(false);
        return;
      }

      setContestChallengeId(result.challengeId);
      setDevelopmentCode(
        result.developmentCode || ""
      );
      setContestCode("");
      setStep(6);
      setContestSubmitting(false);
    } catch (error) {
      console.error(
        "Contest verification send failed:",
        error
      );

      setContestMessage(
        "Could not send the verification code."
      );
      setContestSubmitting(false);
    }
  }

  async function verifyContestPhone() {
    if (!contestChallengeId) {
      setContestMessage(
        "Request a new verification code."
      );
      return;
    }

    setContestSubmitting(true);
    setContestMessage("");

    try {
      const response = await fetch(
        "/api/contest/verification/check",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            phone: contestPhone,
            challengeId: contestChallengeId,
            code: contestCode,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        setContestMessage(
          result?.error ||
            "That verification code could not be confirmed."
        );
        setContestSubmitting(false);
        return;
      }

      setContestSubmitting(false);

      /*
       * The successful verification response installs the
       * HttpOnly contest cookie. Submit the pending Shout
       * immediately using that newly verified identity.
       */
      await submitContestShout(
        contestPendingVoice
      );
    } catch (error) {
      console.error(
        "Contest verification check failed:",
        error
      );

      setContestMessage(
        "Could not verify that phone number."
      );
      setContestSubmitting(false);
    }
  }

  return <div className="flow-card">
    {step === 1 && <div className="flow-step">
      <div className="eyebrow">Step 1</div>
      <h1>Where do they work?</h1>
      <p>
        We search TenderFans first. If the spot is new, the production version will fall through to Google Places to select the real business and address.
      </p>

      <input
        className="field"
        value={venueQuery}
        onChange={e => setVenueQuery(e.target.value)}
        placeholder="Start typing a bar, brewery or spot..."
      />

      <div className="choice-list">
        {tenderMatches.map((row:any) => {
          const tender = Array.isArray(row.bartenders)
            ? row.bartenders[0]
            : row.bartenders;

          const spot = Array.isArray(row.venues)
            ? row.venues[0]
            : row.venues;

          if (!tender || !spot) return null;

          return (
            <button
              key={`tender-${tender.id}`}
              className="choice person-choice shout-search-tender"
              onClick={() => {
                setVenueId(spot.id);

                setLiveVenues(current => [
                  ...current.filter(v => v.id !== spot.id),
                  spot,
                ]);

                setLiveBartenders(current => [
                  ...current.filter(b => b.id !== tender.id),
                  tender,
                ]);

                setBartenderId(tender.id);
                setBartenderQuery(tender.display_name);
              }}
            >
              <span className="mini-avatar">
                {tender.display_name?.[0]}
              </span>

              <span className="shout-search-tender-copy">
                <span className="shout-search-tender-topline">
                  <strong>{tender.display_name}</strong>
                  <small className="shout-search-type">TENDER</small>
                </span>

                <span className="shout-search-spot-name">
                  {spot.name}
                </span>

                {spot.city && (
                  <span className="shout-search-city">
                    {spot.city}
                  </span>
                )}
              </span>
            </button>
          );
        })}

        {venueMatches.map(v => (
          <button
            key={`spot-${v.id}`}
            className={`choice ${venueId===v.id ? "selected" : ""}`}
            onClick={() => {
              setVenueId(v.id);
              setBartenderId("");
              setBartenderQuery("");
            }}
          >
            <strong>{v.name}</strong>
            <span>
              {[v.street_address, v.city, v.state_region]
                .filter(Boolean)
                .join(", ")}
            </span>
          </button>
        ))}
      </div>

      {venueQuery &&
       !venueMatches.length &&
       !tenderMatches.length && (
        <div className="new-entity">
          <strong>We don't have this spot yet.</strong>
          <span>Search Google for the exact location:</span>

          <GooglePlacePicker onSelect={async (place:any) => {
        try {
          const verifyResponse = await fetch("/api/google/place", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ placeId: place.id }),
          });

          if (!verifyResponse.ok) {
            console.error("Could not verify Google Place.");
            return;
          }

          const result = await verifyResponse.json();
          const verifiedPlace = result.place;
          const verifiedVenueId = result.venueId;

          setGoogleVenue(verifiedPlace);
          setVenueId(verifiedVenueId);

          const { data: newVenue } = await supabase
            .from("venues")
            .select("id, slug, name, city, street_address, state_region")
            .eq("id", verifiedVenueId)
            .single();

          if (newVenue) {
            setLiveVenues(current => [
              ...current.filter(v => v.id !== newVenue.id),
              newVenue,
            ]);
          }
        } catch (error) {
          console.error("Google Place selection failed:", error);
        }
          }} />

          {googleVenue && (
            <div>
              <strong>{googleVenue.name}</strong>
              <span>{googleVenue.address}</span>
            </div>
          )}
        </div>
      )}

      <button
        className="btn primary"
        disabled={!venueId}
        onClick={() => setStep(bartenderId ? 3 : 2)}
      >
        Continue
      </button>
    </div>}
    {step === 2 && <div className="flow-step"><button className="back" onClick={()=>setStep(1)}>← Change spot</button><div className="eyebrow">Step 2</div><h1>Who deserves the shout?</h1><p>{selectedVenue?.name} selected. Existing profiles at this spot appear before we allow a new Tender to be created.</p><input className="field" value={bartenderQuery} onChange={e=>setBartenderQuery(e.target.value)} placeholder="Tender name..."/>
      <div className="choice-list">{bartenderMatches.map(b => <button key={b.id} className={`choice person-choice ${bartenderId===b.id?"selected":""}`} onClick={()=>setBartenderId(b.id)}><span className="mini-avatar">{b.display_name[0]}</span><span><strong>{b.display_name}</strong><small>Current Tender at {selectedVenue?.name}</small></span></button>)}</div>
      {bartenderQuery && !bartenderMatches.length && <div className="new-entity"><strong>No close match found.</strong><span>Create {bartenderQuery} as a Tender at {selectedVenue?.name}.</span><button className="btn secondary" onClick={async()=>{const { data, error } = await supabase.rpc("create_bartender_at_venue",{p_display_name: bartenderQuery,p_venue_id: venueId});if(error){console.error(error);return;}const { data:newBartender } = await supabase.from("bartenders").select("id, slug, display_name, status").eq("id",data).single();if(newBartender){setLiveBartenders(current=>[...current,newBartender]);setBartenderId(newBartender.id);}}}>Add this Tender</button></div>}
      <button className="btn primary" disabled={!bartenderId} onClick={()=>setStep(3)}>That's them</button>
    </div>}
    {step === 3 && <div className="flow-step">
      {!initialTenderSlug && (
        <button className="back" onClick={()=>setStep(2)}>
          ← Change tender
        </button>
      )}

      <div className="eyebrow">
        {contestMode ? "Contest Shout" : "Step 3"}
      </div>

      <h1>What makes {selectedBartender?.name} great?</h1>

      <p>
        Choose up to five. There is intentionally no public free-text review box.
      </p>

      <div className="trait-grid">
        {liveTraits.map(t => (
          <button
            className={`trait-button ${traits.includes(t) ? "selected" : ""}`}
            key={t}
            onClick={()=>toggleTrait(t)}
          >
            {traits.includes(t) ? "✓ " : ""}{t}
          </button>
        ))}
      </div>

      <div className="voice-row">
        <label>Shout style</label>
        <select className="field">
          {voices.map(v => <option key={v}>{v}</option>)}
        </select>
      </div>

      <button
        className="btn primary"
        disabled={
          !traits.length ||
          !selectedBartender ||
          !selectedVenue ||
          contestSubmitting
        }
        onClick={async()=>{
          if(!selectedBartender || !selectedVenue) return;

          const voice =
            (document.querySelector(
              ".voice-row select"
            ) as HTMLSelectElement)?.value ?? "";

          if (contestMode) {
            setContestPendingVoice(voice);
            await submitContestShout(voice);
            return;
          }

          const { error } = await supabase.rpc(
            "create_shoutout",
            {
              p_bartender_id: selectedBartender.id,
              p_venue_id: selectedVenue.id,
              p_voice_name: voice,
              p_traits: traits
            }
          );

          if(error){
            console.error(error);
            alert("Could not save shoutout.");
            return;
          }

          setStep(4);
        }}
      >
        {contestSubmitting
          ? "Submitting..."
          : "Give 'em a Shout"}
      </button>

      {contestMode && contestMessage && (
        <div
          className="privacy-note"
          style={{ marginTop: "14px" }}
        >
          {contestMessage}
        </div>
      )}
    </div>}
    {step === 4 && <div className="success">
      <span className="success-mark">T</span>

      <div className="eyebrow">
        {contestMode ? "Contest Shout counted" : "Shout sent"}
      </div>

      <h1>Props delivered.</h1>

      <p>
        {contestMode
          ? `Your verified Shout counts toward ${selectedBartender?.display_name}'s contest total.`
          : `Your selections add to ${selectedBartender?.display_name}'s TenderFans profile.`}
      </p>

      <Link
        href={`/t/${selectedBartender?.slug}`}
        className="btn primary"
      >
        View their bio card
      </Link>
    </div>}
    {contestMode && step === 5 && (
      <div className="flow-step">
        <button
          className="back"
          type="button"
          onClick={() => {
            setContestMessage("");
            setStep(3);
          }}
        >
          ← Back to Shout
        </button>

        <div className="eyebrow">Contest Verification</div>

        <h1>Verify your Shout.</h1>

        <p>
          Enter your mobile number to verify this contest Shout.
          No TenderFans account is required.
        </p>

        <label>
          <strong>Mobile number</strong>

          <input
            className="field"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={contestPhone}
            onChange={(e) =>
              setContestPhone(e.target.value)
            }
            placeholder="(727) 555-1234"
          />
        </label>

        <div
          className="privacy-note"
          style={{
            marginTop: "12px",
            display: "grid",
            gap: "14px",
          }}
        >
          <label
            style={{
              display: "flex",
              gap: "10px",
              alignItems: "flex-start",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={contestTermsAccepted}
              onChange={(e) =>
                setContestTermsAccepted(e.target.checked)
              }
              style={{ marginTop: "4px" }}
            />

            <span>
              <strong>Contest verification acknowledgment</strong>
              <br />
              I understand that my mobile number is being used
              to verify contest participation and enforce
              TenderFans contest eligibility rules.
            </span>
          </label>

          <div
            style={{
              borderTop: "1px solid #d7d1c6",
              paddingTop: "14px",
            }}
          >
            <label
              style={{
                display: "flex",
                gap: "10px",
                alignItems: "flex-start",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={marketingSmsConsent}
                onChange={(e) =>
                  setMarketingSmsConsent(e.target.checked)
                }
                style={{ marginTop: "4px" }}
              />

              <span>
                <strong>
                  Yes, send me occasional TenderFans texts.
                </strong>

                <br />

                I&apos;d like to receive texts about TenderFans
                contests, local bars, events and promotions.
                Message frequency varies. Message and data rates
                may apply. Consent is optional and is not required
                to participate in the contest.
              </span>
            </label>
          </div>
        </div>

        {contestMessage && (
          <div
            className="privacy-note"
            style={{ marginTop: "12px" }}
          >
            {contestMessage}
          </div>
        )}

        <button
          type="button"
          className="btn primary"
          disabled={
            !contestPhone.trim() ||
            !contestTermsAccepted ||
            contestSubmitting
          }
          onClick={sendContestVerification}
        >
          {contestSubmitting
            ? "Sending..."
            : "Send Verification Code"}
        </button>
      </div>
    )}

    {contestMode && step === 6 && (
      <div className="flow-step">
        <button
          className="back"
          type="button"
          onClick={() => {
            setContestMessage("");
            setContestCode("");
            setStep(5);
          }}
        >
          ← Change phone number
        </button>

        <div className="eyebrow">Contest Verification</div>

        <h1>Enter your code.</h1>

        <p>
          Enter the 6-digit verification code sent to
          your mobile number.
        </p>

        {developmentCode && (
          <div
            className="privacy-note"
            style={{ marginBottom: "14px" }}
          >
            Development verification code:{" "}
            <strong>{developmentCode}</strong>
          </div>
        )}

        <label>
          <strong>Verification code</strong>

          <input
            className="field"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={contestCode}
            onChange={(e) =>
              setContestCode(
                e.target.value
                  .replace(/\D/g, "")
                  .slice(0, 6)
              )
            }
            placeholder="000000"
          />
        </label>

        {contestMessage && (
          <div
            className="privacy-note"
            style={{ marginTop: "12px" }}
          >
            {contestMessage}
          </div>
        )}

        <button
          type="button"
          className="btn primary"
          disabled={
            contestCode.length !== 6 ||
            contestSubmitting
          }
          onClick={verifyContestPhone}
        >
          {contestSubmitting
            ? "Verifying..."
            : "Verify & Count My Shout"}
        </button>
      </div>
    )}
  </div>;
}
