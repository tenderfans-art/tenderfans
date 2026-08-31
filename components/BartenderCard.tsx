import Link from "next/link";
import type { Bartender } from "@/lib/mock-data";

export default function BartenderCard({ bartender }: { bartender: Bartender }) {
  return (
    <Link href={`/t/${bartender.slug}`} className="person-card">
      <div className="person-photo">
        {bartender.photo ? <img src={bartender.photo} alt="" /> : <div className="photo-fallback">{bartender.name.slice(0,1)}</div>}
        {bartender.claimed && <span className="verified">✓</span>}
      </div>
      <div className="person-copy">
        <div className="card-row"><h3>{bartender.name}</h3><strong>{bartender.cheers.toLocaleString()} Cheers</strong></div>
        <p>{bartender.venueName} · {bartender.city}</p>
        <div className="chips">{bartender.tags.slice(0,3).map(tag => <span className="chip" key={tag}>{tag}</span>)}</div>
      </div>
    </Link>
  );
}
