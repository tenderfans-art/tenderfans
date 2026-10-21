import { redirect } from "next/navigation";

export default function HarvesterErrorsPage() {
  redirect("/admin/harvester/adapter-errors");
}
