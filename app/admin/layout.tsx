import type { ReactNode } from "react";
import AdminCodexLauncher from "./AdminCodexLauncher";

export default function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      {children}
      <AdminCodexLauncher />
    </>
  );
}
