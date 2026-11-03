import "server-only";
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { dayLabel, rangeLabel } from "@/lib/bots/show-days";
import { usd, usdFine } from "@/lib/ai/pricing";
import { MINUTES_SAVED } from "./bot-week";
import type { ShowReport } from "./show-report";

/**
 * The end-of-show report as an A4 PDF (pdf-lib, no browser needed). The
 * built-in Helvetica only has Western European characters, so text is made
 * safe for it first: Turkish letters become their nearest plain letter,
 * anything else it can't show is left out.
 */

const A4 = { w: 595.28, h: 841.89 };
const M = 48;
const INK = rgb(0.09, 0.13, 0.12);
const MUTED = rgb(0.36, 0.42, 0.4);
const PRIMARY = rgb(0.05, 0.42, 0.36);
const LINE = rgb(0.86, 0.9, 0.88);
const SOFT = rgb(0.95, 0.97, 0.96);

/** Characters Helvetica (WinAnsi) can draw, beyond plain ASCII and Latin-1. */
const EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const NEAREST: Record<string, string> = {
  ı: "i",
  İ: "I",
  ł: "l",
  Ł: "L",
  đ: "d",
  Đ: "D",
  "→": "->",
};

export function pdfSafe(text: string): string {
  let out = "";
  for (const ch of text.replace(/\s+/g, " ")) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || EXTRA.has(ch)) {
      out += ch;
      continue;
    }
    if (NEAREST[ch]) {
      out += NEAREST[ch];
      continue;
    }
    // ş → s, ğ → g, ő → o: the letter without its mark, if that's drawable.
    const base = ch.normalize("NFKD").replace(/\p{M}/gu, "");
    if (base && base !== ch && [...base].every((c) => c.codePointAt(0)! <= 0xff)) out += base;
  }
  return out.replace(/ {2,}/g, " ").trim();
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of pdfSafe(text).split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      if (line) lines.push(line);
      // A word too long for the line is cut.
      let w = word;
      while (font.widthOfTextAtSize(w, size) > width && w.length > 1) w = w.slice(0, -1);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

const n = (x: number) => x.toLocaleString("en-GB");

export async function showReportPdf(r: ShowReport, made = new Date()): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(pdfSafe(`${r.botName}: end-of-show report`));
  pdf.setCreator("Billie");
  pdf.setProducer("Billie");
  pdf.setCreationDate(made);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - M;
  const width = A4.w - 2 * M;
  const room = (h: number) => {
    if (y - h < M + 24) {
      page = pdf.addPage([A4.w, A4.h]);
      y = A4.h - M;
    }
  };
  const text = (
    s: string,
    opts: {
      size?: number;
      f?: PDFFont;
      color?: ReturnType<typeof rgb>;
      x?: number;
      w?: number;
      gap?: number;
    } = {},
  ) => {
    const size = opts.size ?? 10;
    const lines = wrap(s, opts.f ?? font, size, opts.w ?? width);
    for (const line of lines) {
      room(size + 4);
      page.drawText(line, {
        x: opts.x ?? M,
        y: y - size,
        size,
        font: opts.f ?? font,
        color: opts.color ?? INK,
      });
      y -= size + (opts.gap ?? 4);
    }
  };
  const heading = (s: string) => {
    room(40);
    y -= 14;
    text(s, { size: 13, f: bold, gap: 8 });
  };

  // Header.
  text("END-OF-SHOW REPORT", { size: 8.5, f: bold, color: PRIMARY, gap: 6 });
  text(r.botName, { size: 22, f: bold, gap: 6 });
  text([r.showName, rangeLabel({ from: r.from, to: r.to })].filter(Boolean).join(" · "), {
    size: 11,
    color: MUTED,
    gap: 16,
  });

  // The numbers, in boxes: four a row.
  const tiles: [string, string][] = [
    [n(r.chats), "chats"],
    [r.alonePct === null ? "-" : `${r.alonePct}%`, "answered by Billie alone"],
    [n(r.handedOver), "passed to the team"],
    [`${r.hours}`, `hours saved (about)`],
    [n(r.emails), "emails in"],
    [n(r.emailsDrafted), "email replies drafted"],
    [n(r.requests), "requests from chats"],
    r.costPerChatMicros !== null
      ? [usdFine(r.costPerChatMicros), `Claude cost a chat (${usd(r.costMicros ?? 0)} in all)`]
      : [r.helpfulPct === null ? "-" : `${r.helpfulPct}%`, "of rated answers were helpful"],
  ];
  const gap = 8;
  const boxW = (width - gap * 3) / 4;
  const boxH = 58;
  for (let row = 0; row < 2; row++) {
    room(boxH + gap);
    for (let col = 0; col < 4; col++) {
      const [value, label] = tiles[row * 4 + col];
      const x = M + col * (boxW + gap);
      page.drawRectangle({
        x,
        y: y - boxH,
        width: boxW,
        height: boxH,
        color: SOFT,
        borderColor: LINE,
        borderWidth: 0.75,
      });
      page.drawText(pdfSafe(value), { x: x + 10, y: y - 26, size: 17, font: bold, color: INK });
      wrap(label, font, 8.5, boxW - 20)
        .slice(0, 2)
        .forEach((line, i) =>
          page.drawText(line, { x: x + 10, y: y - 40 - i * 10, size: 8.5, font, color: MUTED }),
        );
    }
    y -= boxH + gap;
  }
  text(
    `Hours saved counts ${MINUTES_SAVED.chat} minutes for each chat Billie answered alone and ${MINUTES_SAVED.email} for each email reply it drafted.${r.whatsapp ? ` ${n(r.whatsapp)} of the chats were on WhatsApp.` : ""}`,
    { size: 8.5, color: MUTED, gap: 4 },
  );

  if (r.days.length) {
    heading("Chats each day");
    const cols = [M, M + 250, M + 340];
    room(16);
    page.drawText("Day", { x: cols[0], y: y - 9, size: 9, font: bold, color: MUTED });
    page.drawText("Chats", { x: cols[1], y: y - 9, size: 9, font: bold, color: MUTED });
    page.drawText("Passed to the team", {
      x: cols[2],
      y: y - 9,
      size: 9,
      font: bold,
      color: MUTED,
    });
    y -= 15;
    for (const d of r.days) {
      room(15);
      page.drawLine({
        start: { x: M, y: y + 2 },
        end: { x: M + width, y: y + 2 },
        thickness: 0.5,
        color: LINE,
      });
      page.drawText(pdfSafe(dayLabel(d.day)), {
        x: cols[0],
        y: y - 10,
        size: 10,
        font,
        color: INK,
      });
      page.drawText(n(d.chats), { x: cols[1], y: y - 10, size: 10, font, color: INK });
      page.drawText(n(d.handedOver), { x: cols[2], y: y - 10, size: 10, font, color: INK });
      y -= 15;
    }
  }

  const list = (title: string, items: string[], empty?: string) => {
    if (!items.length && !empty) return;
    heading(title);
    if (!items.length) return text(empty!, { color: MUTED });
    items.forEach((item, i) => text(`${i + 1}.  ${item}`, { gap: 5 }));
  };
  list(
    "Most asked",
    r.mostAsked.map((q) => `${q.question} (${n(q.times)})`),
  );
  list(
    "Why chats went to the team",
    r.reasons.map((x) => `${x.label} (${n(x.n)})`),
  );
  list(
    "Requests from chats",
    r.requestsByType.map((x) => `${x.name} (${n(x.n)})`),
  );
  heading("To fix before the next show");
  if (!r.couldntAnswer.length && !r.unhelpful.length)
    text("Nothing: every question had an answer, and none was marked unhelpful.", { color: MUTED });
  if (r.couldntAnswer.length) {
    text("Questions Billie couldn't answer (add the answer on the Knowledge page):", {
      f: bold,
      gap: 6,
    });
    r.couldntAnswer.forEach((g) =>
      text(`•  ${g.question}${g.askCount > 1 ? ` (asked ${n(g.askCount)} times)` : ""}`, {
        x: M + 8,
        w: width - 8,
      }),
    );
    y -= 6;
  }
  if (r.unhelpful.length) {
    text("Answers people marked unhelpful (fix them under Knowledge → To improve):", {
      f: bold,
      gap: 6,
    });
    r.unhelpful.forEach((u) =>
      text(`•  ${u.question}${u.count > 1 ? ` (${n(u.count)} times)` : ""}`, {
        x: M + 8,
        w: width - 8,
      }),
    );
  }

  // Footers: what it is and where, on every page.
  const pages = pdf.getPages();
  const madeOn = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(made);
  pages.forEach((p, i) => {
    p.drawText(pdfSafe(`Billie · ${r.botName} · made ${madeOn}`), {
      x: M,
      y: M - 20,
      size: 8,
      font,
      color: MUTED,
    });
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, {
      x: A4.w - M - font.widthOfTextAtSize(label, 8),
      y: M - 20,
      size: 8,
      font,
      color: MUTED,
    });
  });
  return pdf.save();
}
