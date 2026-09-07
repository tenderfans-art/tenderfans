type Props = {
  searchParams: Promise<{
    status?: string;
  }>;
};

export default async function NotificationVerifiedPage({
  searchParams,
}: Props) {
  const { status } = await searchParams;

  let title = "Email verification";
  let message =
    "We couldn't verify that notification request.";

  if (status === "success") {
    title = "You're following!";
    message =
      "Your email is verified and TenderFans notifications are now active.";
  }

  if (status === "already-verified") {
    title = "Already verified";
    message =
      "This email notification subscription is already active.";
  }

  if (status === "expired") {
    title = "Verification link expired";
    message =
      "That verification link has expired. Follow the Tender or Spot again to request a new one.";
  }

  if (status === "invalid") {
    title = "Invalid verification link";
    message =
      "That verification link is no longer valid.";
  }

  if (status === "error") {
    title = "Something went wrong";
    message =
      "We couldn't verify your notification request. Please try again.";
  }

  return (
    <main className="flow-page">
      <section className="flow-card">
        <div className="eyebrow">TenderFans Notifications</div>

        <h1>{title}</h1>

        <p>{message}</p>

        <a className="btn primary" href="/">
          Back to TenderFans
        </a>
      </section>
    </main>
  );
}
