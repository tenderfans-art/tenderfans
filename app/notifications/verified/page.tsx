import Link from "next/link";

type PageProps = {
  searchParams: Promise<{
    status?: string;
    type?: string;
    name?: string;
  }>;
};

export default async function NotificationVerifiedPage({
  searchParams,
}: PageProps) {
  const params = await searchParams;

  const status = params.status ?? "";
  const type = params.type ?? "follow";
  const name = params.name?.trim() ?? "";

  let eyebrow = "TenderFans Notifications";
  let title = "Verification complete.";
  let message =
    "Your notification preferences have been updated.";

  if (status === "success") {
    if (type === "follow") {
      title = name
        ? `You're following ${name}!`
        : "You're following!";

      message =
        "Your email is verified and email notifications are now active.";
    } else {
      title = "Reminder confirmed!";

      message =
        "Your email is verified and your event reminder is now active.";
    }
  }

  if (status === "already-verified") {
    title =
      type === "reminder"
        ? "Reminder already verified."
        : "Already following.";

    message =
      "This email address has already been verified.";
  }

  if (status === "expired") {
    title = "Verification link expired.";

    message =
      type === "reminder"
        ? "Set the event reminder again to request a new verification email."
        : "Follow the Tender or Spot again to request a new verification email.";
  }

  if (status === "invalid") {
    title = "Invalid verification link.";

    message =
      "This verification link is not valid.";
  }

  if (status === "error") {
    title = "We couldn't verify that.";

    message =
      "Something went wrong while verifying your notification request.";
  }

  return (
    <section
      style={{
        minHeight: "520px",
        display: "grid",
        placeItems: "center",
        padding: "42px 20px",
      }}
    >
      <div
        style={{
          width: "min(560px, 100%)",
          padding: "34px 36px",
          border: "1px solid #ddd7cb",
          borderRadius: "24px",
          background: "#fff",
          textAlign: "center",
          boxShadow:
            "0 14px 34px rgba(14, 28, 37, 0.07)",
        }}
      >
        <div
          className="eyebrow"
          style={{
            marginBottom: "10px",
          }}
        >
          {eyebrow}
        </div>

        <h1
          style={{
            margin: "0 0 12px",
            fontSize: "clamp(2rem, 4vw, 2.7rem)",
            lineHeight: 1.05,
          }}
        >
          {title}
        </h1>

        <p
          style={{
            margin:
              "0 auto 22px",
            maxWidth: "440px",
            fontSize: "1.05rem",
            lineHeight: 1.55,
            color: "#657078",
          }}
        >
          {message}
        </p>

        <Link
          href="/"
          className="btn primary"
          style={{
            display: "inline-flex",
            justifyContent: "center",
          }}
        >
          Back to TenderFans
        </Link>
      </div>
    </section>
  );
}
