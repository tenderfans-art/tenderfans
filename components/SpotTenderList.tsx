import Link from "next/link";

type Tender = {
  id: string;
  slug: string;
  display_name: string;
};

export default function SpotTenderList({
  tenders,
}: {
  tenders: Tender[];
}) {
  if (!tenders.length) {
    return (
      <div className="gallery-empty">
        No current Tender profiles are listed for this spot yet.
      </div>
    );
  }

  return (
    <div className="spot-tender-list">
      {tenders.map((tender) => (
        <Link
          key={tender.id}
          href={`/t/${tender.slug}`}
          className="spot-tender-card"
        >
          <span className="spot-tender-avatar">
            {tender.display_name?.[0] ?? "T"}
          </span>

          <span className="spot-tender-copy">
            <strong>{tender.display_name}</strong>
            <small>View Tender profile</small>
          </span>
        </Link>
      ))}
    </div>
  );
}
