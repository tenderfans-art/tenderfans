"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { bartenders, venues } from "@/lib/mock-data";
import { supabase } from "@/lib/supabase";
import GooglePlacePicker from "@/components/GooglePlacePicker";

export default function ShoutFlow() {
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
  const [googleVenue, setGoogleVenue] = useState<any>(null);
  useEffect(() => {
    const loadOptions = async () => {
      const { data: traitData } = await supabase.from("traits").select("label").eq("audience", "bartender").eq("active", true).order("id");
      const { data: voiceData } = await supabase.from("voices").select("name").eq("active", true).order("id");
      const { data: venueData } = await supabase.from("venues").select("id, slug, name, city, street_address, state_region").eq("status", "active").order("name");
      setLiveTraits((traitData ?? []).map(t => t.label));
      setVoices((voiceData ?? []).map(v => v.name));
      setLiveVenues(venueData ?? []);
    };
    loadOptions();
  }, []);

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
  const venueMatches = useMemo(() => liveVenues.filter(v => (v.name + " " + v.city).toLowerCase().includes(venueQuery.toLowerCase())).slice(0,5), [liveVenues, venueQuery]);
  const bartenderMatches = useMemo(() => liveBartenders.filter(b => b.display_name.toLowerCase().includes(bartenderQuery.toLowerCase())).slice(0,5), [liveBartenders, bartenderQuery]);
  const toggleTrait = (trait:string) => setTraits(current => current.includes(trait) ? current.filter(t=>t!==trait) : current.length < 5 ? [...current, trait] : current);

  return <div className="flow-card">
    {step === 1 && <div className="flow-step"><div className="eyebrow">Step 1</div><h1>Where do they work?</h1><p>We search TenderFans first. If the spot is new, the production version will fall through to Google Places to select the real business and address.</p><input className="field" value={venueQuery} onChange={e=>setVenueQuery(e.target.value)} placeholder="Start typing a bar, brewery or spot..."/>
      <div className="choice-list">{venueMatches.map(v => <button key={v.id} className={`choice ${venueId===v.id?"selected":""}`} onClick={()=>setVenueId(v.id)}><strong>{v.name}</strong><span>{[v.street_address, v.city, v.state_region].filter(Boolean).join(", ")}</span></button>)}</div>
      {venueQuery && !venueMatches.length && <div className="new-entity"><strong>We don't have this spot yet.</strong><span>Search Google for the exact location:</span><GooglePlacePicker onSelect={async (place:any) => {
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
      }} />{googleVenue && <div><strong>{googleVenue.name}</strong><span>{googleVenue.address}</span></div>}</div>}
      <button className="btn primary" disabled={!venueId} onClick={()=>setStep(2)}>Continue</button>
    </div>}
    {step === 2 && <div className="flow-step"><button className="back" onClick={()=>setStep(1)}>← Change spot</button><div className="eyebrow">Step 2</div><h1>Who deserves the shout?</h1><p>{selectedVenue?.name} selected. Existing profiles at this spot appear before we allow a new bartender to be created.</p><input className="field" value={bartenderQuery} onChange={e=>setBartenderQuery(e.target.value)} placeholder="Bartender name..."/>
      <div className="choice-list">{bartenderMatches.map(b => <button key={b.id} className={`choice person-choice ${bartenderId===b.id?"selected":""}`} onClick={()=>setBartenderId(b.id)}><span className="mini-avatar">{b.display_name[0]}</span><span><strong>{b.display_name}</strong><small>Current bartender at {selectedVenue?.name}</small></span></button>)}</div>
      {bartenderQuery && !bartenderMatches.length && <div className="new-entity"><strong>No close match found.</strong><span>Create {bartenderQuery} as a bartender at {selectedVenue?.name}.</span><button className="btn secondary" onClick={async()=>{const { data, error } = await supabase.rpc("create_bartender_at_venue",{p_display_name: bartenderQuery,p_venue_id: venueId});if(error){console.error(error);return;}const { data:newBartender } = await supabase.from("bartenders").select("id, slug, display_name, status").eq("id",data).single();if(newBartender){setLiveBartenders(current=>[...current,newBartender]);setBartenderId(newBartender.id);}}}>Add this bartender</button></div>}
      <button className="btn primary" disabled={!bartenderId} onClick={()=>setStep(3)}>That's them</button>
    </div>}
    {step === 3 && <div className="flow-step"><button className="back" onClick={()=>setStep(2)}>← Change tender</button><div className="eyebrow">Step 3</div><h1>What makes {selectedBartender?.name} great?</h1><p>Choose up to five. There is intentionally no public free-text review box.</p><div className="trait-grid">{liveTraits.map(t=><button className={`trait-button ${traits.includes(t)?"selected":""}`} key={t} onClick={()=>toggleTrait(t)}>{traits.includes(t)?"✓ ":""}{t}</button>)}</div><div className="voice-row"><label>Shout style</label><select className="field">{voices.map(v => <option key={v}>{v}</option>)}</select></div><button className="btn primary" disabled={!traits.length || !selectedBartender || !selectedVenue} onClick={async()=>{if(!selectedBartender||!selectedVenue)return;const voice=(document.querySelector(".voice-row select") as HTMLSelectElement)?.value??"";const{error}=await supabase.rpc("create_shoutout",{p_bartender_id:selectedBartender.id,p_venue_id:selectedVenue.id,p_voice_name:voice,p_traits:traits});if(error){console.error(error);alert("Could not save shoutout.");return;}setStep(4);}}>Give 'em a Shout</button></div>}
    {step === 4 && <div className="success"><span className="success-mark">T</span><div className="eyebrow">Shout sent</div><h1>Props delivered.</h1><p>Your selections add to {selectedBartender?.display_name}&apos;s TenderFans profile.</p><Link href={`/t/${selectedBartender?.slug}`} className="btn primary">View their bio card</Link></div>}
  </div>;
}
