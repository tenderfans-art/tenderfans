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
    <div className="person-grid">
      {tenders.map((tender) => (
        <Link
          key={tender.id}
          href={`/t/${tender.slug}`}
          className="choice person-choice"
        >
          <span className="mini-avatar">
            {tender.display_name?.[0] ?? "T"}
          </span>

          <span>
            <strong>{tender.display_name}</strong>
            <small>View bio card</small>
          </span>
        </Link>
      ))}
    </div>
  );
}
