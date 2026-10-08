import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

function wrap(
  text: string,
  font: { widthOfTextAtSize: (text: string, size: number) => number },
  size: number,
  width: number,
) {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) current = candidate;
    else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export const exportReportPdf = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }) => {
    const { data: report, error } = await context.supabase
      .from("reports")
      .select("title,period,scope,summary,created_at")
      .eq("id", data.id)
      .single();
    if (error) throw error;
    const pdf = await PDFDocument.create();
    const regular = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const margin = 54;
    let page = pdf.addPage([612, 792]);
    let y = 738;
    const addLines = (text: string, font = regular, size = 10, gap = 14) => {
      for (const line of wrap(text, font, size, 504)) {
        if (y < 62) {
          page = pdf.addPage([612, 792]);
          y = 738;
        }
        page.drawText(line.replace(/[★•]/g, "-"), {
          x: margin,
          y,
          size,
          font,
          color: rgb(0.08, 0.1, 0.16),
        });
        y -= gap;
      }
    };
    page.drawText("SEOVALE", { x: margin, y, size: 11, font: bold, color: rgb(0.04, 0.45, 0.4) });
    y -= 30;
    addLines(report.title, bold, 22, 27);
    y -= 4;
    addLines(
      `${report.period} | ${report.scope} | Generated ${new Date(report.created_at).toLocaleDateString("en-GB")}`,
      regular,
      10,
      16,
    );
    y -= 20;
    for (const block of (report.summary ?? "No summary was generated.").split("\n")) {
      if (!block.trim()) {
        y -= 8;
        continue;
      }
      const heading = block.trim().endsWith(":");
      addLines(block.trim(), heading ? bold : regular, heading ? 12 : 10, heading ? 18 : 14);
    }
    for (const item of pdf.getPages()) {
      item.drawText("Seovale reputation intelligence", {
        x: margin,
        y: 34,
        size: 8,
        font: regular,
        color: rgb(0.42, 0.46, 0.52),
      });
    }
    const bytes = await pdf.save();
    return {
      fileName: `seovale-report-${report.created_at.slice(0, 10)}.pdf`,
      pdfBase64: Buffer.from(bytes).toString("base64"),
    };
  });
