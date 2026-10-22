import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatAnswer, parseInbound, verifySignature, withinReplyWindow } from "@/lib/channels/whatsapp";
import { checkUrl, isPrivateAddress } from "@/lib/knowledge/web";
import { capSegments, fileKind, webPageSegments } from "@/lib/knowledge/extract";
import { alertText, teamsCard } from "@/lib/alerts/notify";
import { summaryText } from "@/lib/reports/summary";

describe("WhatsApp webhook", () => {
  const secret = "app-secret";
  const body = JSON.stringify({ hello: "world" });
  const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  it("accepts only Meta's signature over the exact body", () => {
    expect(verifySignature(body, sig, secret)).toBe(true);
    expect(verifySignature(`${body} `, sig, secret)).toBe(false);
    expect(verifySignature(body, sig, "other")).toBe(false);
    expect(verifySignature(body, null, secret)).toBe(false);
    expect(verifySignature(body, "sha256=zz", secret)).toBe(false);
  });

  it("reads text messages and tapped buttons, skipping status updates", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                contacts: [{ wa_id: "447700900123", profile: { name: "Pat" } }],
                messages: [
                  { id: "wamid.1", from: "447700900123", timestamp: "1790000000", type: "text", text: { body: " Hi there " } },
                  { id: "wamid.2", from: "447700900123", timestamp: "1790000001", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "exhibitor", title: "Exhibiting" } } },
                  { id: "wamid.3", from: "447700900123", timestamp: "1790000002", type: "image" },
                ],
              },
            },
            { field: "messages", value: { statuses: [{ id: "x" }] } },
          ],
        },
      ],
    };
    const got = parseInbound(payload);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ id: "wamid.1", from: "447700900123", profileName: "Pat", text: "Hi there", buttonId: null });
    expect(got[1]).toMatchObject({ text: "Exhibiting", buttonId: "exhibitor" });
    expect(parseInbound({ object: "page" })).toEqual([]);
  });

  it("keeps to the 24-hour window and sends one complete message with its sources", () => {
    const now = new Date("2027-05-11T12:00:00Z");
    expect(withinReplyWindow(new Date("2027-05-10T13:00:00Z"), now)).toBe(true);
    expect(withinReplyWindow(new Date("2027-05-10T11:00:00Z"), now)).toBe(false);
    expect(withinReplyWindow(null, now)).toBe(false);
    expect(formatAnswer("Build-up starts at 08:00.", [{ title: "Exhibitor manual", label: "p. 4" }])).toBe(
      "Build-up starts at 08:00.\n\nSource: Exhibitor manual, p. 4",
    );
  });
});

describe("web pages for the knowledge base", () => {
  it("refuses private, local and metadata addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "151.101.1.69", "2a00:1450:4009:81f::200e"]) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(() => checkUrl("http://localhost/admin")).toThrow(/public web/);
    expect(() => checkUrl("http://169.254.169.254/latest/meta-data")).toThrow(/public web/);
    expect(() => checkUrl("file:///etc/passwd")).toThrow(/http and https/);
    expect(() => checkUrl("https://user:pw@example.com")).toThrow(/password/);
    expect(() => checkUrl("https://example.com:8443/")).toThrow(/ports/);
    expect(checkUrl("https://www.ukconstructionweek.com/visit").hostname).toBe("www.ukconstructionweek.com");
  });

  it("keeps the article and drops navigation", () => {
    const html = `<html><head><title>Plan your visit</title></head><body>
      <nav><a href="/">Home</a> <a href="/exhibit">Exhibit</a></nav>
      <article><h1>Plan your visit</h1>
        <p>UK Construction Week London runs from 11 to 13 May 2027 at ExCeL London. The show is free to attend for trade visitors who register in advance.</p>
        <h2>Getting there</h2><p>Take the Elizabeth line to Custom House station, which is next to the venue. Parking is available in the East and West car parks.</p>
      </article><footer>© Media10</footer></body></html>`;
    const { title, segments } = webPageSegments(html, "https://example.com/visit");
    expect(title).toBe("Plan your visit");
    const all = segments.map((s) => `${s.label}: ${s.text}`).join("\n");
    expect(all).toContain("Getting there: Take the Elizabeth line");
    expect(all).not.toContain("Exhibit");
  });

  it("knows which files it can read and caps very long sources", () => {
    expect(fileKind("Manual.PDF", "")).toBe("pdf");
    expect(fileKind("notes.md", null)).toBe("text");
    expect(fileKind("photo.jpg", "image/jpeg")).toBeNull();
    const { segments, truncated } = capSegments([{ text: "x".repeat(1_500_000), label: "a" }, { text: "y".repeat(1_000_000), label: "b" }]);
    expect(truncated).toBe(true);
    expect(segments.reduce((n, s) => n + s.text.length, 0)).toBe(2_000_000);
  });
});

describe("alerts and the weekly summary", () => {
  const alert = {
    kind: "ticket" as const,
    botName: "Exhibitor Help",
    question: "Can we deliver on Sunday?",
    reason: "Asked for a person",
    contact: { name: "Pat Example", company: "Example Signs", stand: "N3-210" },
    link: "https://billie.example/inbox?c=1",
  };

  it("says who, what and why in plain words", () => {
    const { title, lines } = alertText(alert);
    expect(title).toBe("Exhibitor Help: a question needs a reply");
    expect(lines).toContain("From: Pat Example, Example Signs, stand N3-210");
    const card = teamsCard(alert);
    expect(card.attachments[0].content.actions[0]).toMatchObject({ type: "Action.OpenUrl", url: alert.link });
  });

  it("summarises the week", () => {
    const text = summaryText({
      k: { chats: 120, answeredAlonePct: 82, handedOver: 22, emailsDrafted: 40, openGaps: 6, helpfulPct: 91 },
      top: [{ question: "When does build-up start?", times: 18 }],
      link: "https://billie.example/reports",
    });
    expect(text).toContain("Answered by Billie alone: 82%");
    expect(text).toContain("- When does build-up start? (18)");
  });
});
