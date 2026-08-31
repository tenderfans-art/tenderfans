"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { bartenderTraits, bartenders, venues } from "@/lib/mock-data";

export default function ShoutFlow() {
  const [step, setStep] = useState(1);
  const [venueQuery, setVenueQuery] = useState("");
  const [venueId, setVenueId] = useState("");
  const [bartenderQuery, setBartenderQuery] = useState("");
  const [bartenderId, setBartenderId] = useState("");
  const [traits, setTraits] = useState<string[]>([]);
  const selectedVenue = venues.find(v => v.id === venueId);
  const selectedBartender = bartenders.find(b => b.id === bartenderId);
  const venueMatches = useMemo(() => venues.filter(v => `${v.name} ${v.city}`.toLowerCase().includes(venueQuery.toLowerCase())).slice(0,5), [venueQuery]);
  const bartenderMatches = useMemo(() => bartenders.filter(b => b.venueSlug === selectedVenue?.slug && b.name.toLowerCase().includes(bartenderQuery.toLowerCase())).slice(0,5), [selectedVenue, bartenderQuery]);
  const toggleTrait = (trait:string) => setTraits(current => current.includes(trait) ? current.filter(t=>t!==trait) : current.length < 5 ? [...current, trait] : current);

  return <div className="flow-card">
    <div className="flow-progress"><span className={step>=1?"active":""}>1 Spot</span><span className={step>=2?"active":""}>2 Tender</span><span className={step>=3?"active":""}>3 Props</span></div>
    {step === 1 && <div className="flow-step"><div className="eyebrow">Step 1</div><h1>Where do they work?</h1><p>We search TenderFans first. If the spot is new, the production version will fall through to Google Places to select the real business and address.</p><input className="field" value={venueQuery} onChange={e=>setVenueQuery(e.target.value)} placeholder="Start typing a bar, brewery or spot..."/>
      <div className="choice-list">{venueMatches.map(v => <button key={v.id} className={`choice ${venueId===v.id?"selected":""}`} onClick={()=>setVenueId(v.id)}><strong>{v.name}</strong><span>{v.address}</span></button>)}</div>
      {venueQuery && !venueMatches.length && <div className="new-entity"><strong>We don't have this spot yet.</strong><span>Production: open Google Places suggestions → select exact location → create the TenderFans spot automatically.</span></div>}
      <button className="btn primary" disabled={!venueId} onClick={()=>setStep(2)}>Continue</button>
    </div>}
    {step === 2 && <div className="flow-step"><button className="back" onClick={()=>setStep(1)}>← Change spot</button><div className="eyebrow">Step 2</div><h1>Who deserves the shout?</h1><p>{selectedVenue?.name} selected. Existing profiles at this spot appear before we allow a new bartender to be created.</p><input className="field" value={bartenderQuery} onChange={e=>setBartenderQuery(e.target.value)} placeholder="Bartender name..."/>
      <div className="choice-list">{bartenderMatches.map(b => <button key={b.id} className={`choice person-choice ${bartenderId===b.id?"selected":""}`} onClick={()=>setBartenderId(b.id)}><span className="mini-avatar">{b.name[0]}</span><span><strong>{b.name} {b.claimed && "✓"}</strong><small>{b.cheers} Cheers · {b.tags.slice(0,2).join(" · ")}</small></span></button>)}</div>
      {bartenderQuery && !bartenderMatches.length && <div className="new-entity"><strong>No close match found.</strong><span>Production: run fuzzy + alias matching, show probable bio cards, then allow “This is someone else” before creating a new profile.</span></div>}
      <button className="btn primary" disabled={!bartenderId} onClick={()=>setStep(3)}>That's them</button>
    </div>}
    {step === 3 && <div className="flow-step"><button className="back" onClick={()=>setStep(2)}>← Change tender</button><div className="eyebrow">Step 3</div><h1>What makes {selectedBartender?.name} great?</h1><p>Choose up to five. There is intentionally no public free-text review box.</p><div className="trait-grid">{bartenderTraits.map(t=><button className={`trait-button ${traits.includes(t)?"selected":""}`} key={t} onClick={()=>toggleTrait(t)}>{traits.includes(t)?"✓ ":""}{t}</button>)}</div><div className="voice-row"><label>Shout style</label><select className="field"><option>The Regular</option><option>Cocktail Fan</option><option>Game-Day Crowd</option><option>Vacation Mode</option><option>Local Favorite</option></select></div><button className="btn primary" disabled={!traits.length} onClick={()=>setStep(4)}>Give 'em a Shout</button></div>}
    {step === 4 && <div className="success"><span className="success-mark">T</span><div className="eyebrow">Shout sent</div><h1>Props delivered.</h1><p>Your selections add to {selectedBartender?.name}'s positive TenderFans profile.</p><Link href={`/t/${selectedBartender?.slug}`} className="btn primary">View their bio card</Link></div>}
  </div>;
}
