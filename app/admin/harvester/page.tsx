import HarvesterDashboard from "./HarvesterDashboard";

export default async function AdminHarvesterPage({
  searchParams,
}: {
  searchParams: Promise<{ market?: string }>;
}) {
  const params = await searchParams;

  return (
    <HarvesterDashboard
      marketKey={typeof params.market === "string"
        ? params.market
        : ""}
    />
  );
}
