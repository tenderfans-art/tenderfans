"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type TenderMessage = {
  id: string;
  message_type: "shout_received" | "event_tagged" | "system";
  title: string;
  body: string;
  action_url: string | null;
  read_at: string | null;
  created_at: string;
};

export default function TenderMessagesPage() {
  const [messages, setMessages] = useState<TenderMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    async function loadMessages() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        window.location.href = "/login";
        return;
      }

      const { data: permissions, error: permissionError } =
        await supabase
          .from("bartender_permissions")
          .select("bartender_id")
          .eq("user_id", user.id);

      if (permissionError) {
        setErrorMessage(permissionError.message);
        setLoading(false);
        return;
      }

      const bartenderId = permissions?.[0]?.bartender_id;

      if (!bartenderId) {
        setErrorMessage("No approved Tender profile found.");
        setLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from("tender_messages")
        .select(
          "id, message_type, title, body, action_url, read_at, created_at"
        )
        .eq("bartender_id", bartenderId)
        .order("created_at", { ascending: false });

      if (error) {
        setErrorMessage(error.message);
        setLoading(false);
        return;
      }

      setMessages((data ?? []) as TenderMessage[]);
      setLoading(false);
    }

    loadMessages();
  }, []);

  async function markRead(id: string) {
    const readAt = new Date().toISOString();

    const { error } = await supabase.rpc(
      "mark_tender_messages_read",
      {
        p_message_ids: [id],
      }
    );

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    setMessages((current) =>
      current.map((message) =>
        message.id === id
          ? { ...message, read_at: message.read_at ?? readAt }
          : message
      )
    );
  }

  async function markAllRead() {
    const unreadIds = messages
      .filter((message) => !message.read_at)
      .map((message) => message.id);

    if (unreadIds.length === 0) return;

    const readAt = new Date().toISOString();

    const { error } = await supabase.rpc(
      "mark_tender_messages_read",
      {
        p_message_ids: unreadIds,
      }
    );

    if (error) {
      setErrorMessage(error.message);
      return;
    }

    setMessages((current) =>
      current.map((message) => ({
        ...message,
        read_at: message.read_at ?? readAt,
      }))
    );
  }

  const unreadCount = messages.filter(
    (message) => !message.read_at
  ).length;

  return (
    <main className="flow-page">
      <div className="shell narrow">
        <section className="flow-card">
          <div className="eyebrow">Tender Account</div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "16px",
              flexWrap: "wrap",
            }}
          >
            <div>
              <h1 style={{ marginBottom: "6px" }}>Messages</h1>

              <p className="lead-copy" style={{ marginBottom: 0 }}>
                Shouts, event updates and messages from TenderFans.
              </p>
            </div>

            <Link
              href="/account/tender"
              className="btn outline"
            >
              Back to Account
            </Link>
          </div>

          {loading && (
            <p style={{ marginTop: "24px" }}>
              Loading messages...
            </p>
          )}

          {errorMessage && (
            <p style={{ marginTop: "24px", color: "crimson" }}>
              {errorMessage}
            </p>
          )}

          {!loading && !errorMessage && (
            <>
              <div
                style={{
                  marginTop: "26px",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                  flexWrap: "wrap",
                }}
              >
                <strong>
                  {unreadCount === 0
                    ? "You're all caught up."
                    : `${unreadCount} unread ${
                        unreadCount === 1 ? "message" : "messages"
                      }`}
                </strong>

                {unreadCount > 0 && (
                  <button
                    type="button"
                    className="btn outline"
                    onClick={markAllRead}
                  >
                    Mark all as read
                  </button>
                )}
              </div>

              {messages.length === 0 ? (
                <div
                  style={{
                    marginTop: "18px",
                    padding: "22px",
                    border: "1px solid #d7d1c6",
                    borderRadius: "14px",
                  }}
                >
                  <strong>No messages yet.</strong>
                  <p
                    style={{
                      margin: "6px 0 0",
                      color: "#697177",
                    }}
                  >
                    Shouts, event updates and TenderFans messages
                    will appear here.
                  </p>
                </div>
              ) : (
                <div
                  style={{
                    marginTop: "18px",
                    display: "grid",
                    gap: "10px",
                  }}
                >
                  {messages.map((message) => {
                    const content = (
                      <>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: "14px",
                            alignItems: "flex-start",
                          }}
                        >
                          <div>
                            {!message.read_at && (
                              <div
                                className="eyebrow"
                                style={{ marginBottom: "4px" }}
                              >
                                NEW
                              </div>
                            )}

                            <strong>{message.title}</strong>
                          </div>

                          <span
                            style={{
                              flexShrink: 0,
                              fontSize: "0.76rem",
                              color: "#697177",
                            }}
                          >
                            {new Date(
                              message.created_at
                            ).toLocaleDateString()}
                          </span>
                        </div>

                        <p
                          style={{
                            margin: "6px 0 0",
                            color: "#697177",
                            lineHeight: 1.5,
                          }}
                        >
                          {message.body}
                        </p>
                      </>
                    );

                    const style = {
                      display: "block",
                      padding: "16px",
                      border: message.read_at
                        ? "1px solid #d7d1c6"
                        : "2px solid #172735",
                      borderRadius: "14px",
                      background: "#fff",
                      color: "inherit",
                      textDecoration: "none",
                    };

                    if (message.action_url) {
                      return (
                        <Link
                          key={message.id}
                          href={message.action_url}
                          style={style}
                          onClick={() => {
                            if (!message.read_at) {
                              void markRead(message.id);
                            }
                          }}
                        >
                          {content}
                        </Link>
                      );
                    }

                    return (
                      <button
                        key={message.id}
                        type="button"
                        onClick={() => {
                          if (!message.read_at) {
                            void markRead(message.id);
                          }
                        }}
                        style={{
                          ...style,
                          width: "100%",
                          textAlign: "left",
                          font: "inherit",
                          cursor: message.read_at
                            ? "default"
                            : "pointer",
                        }}
                      >
                        {content}
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
