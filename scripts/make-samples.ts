// Writes the sample bank letters the demo uses. Harbor Trust Bank does not exist, so neither letter copies a real bank.
import { mkdirSync, writeFileSync } from "node:fs";

function pdf(lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, "\\$&");
  const body = lines.map((l, i) => `BT /F1 ${i === 0 ? 18 : 12} Tf 72 ${720 - i * 26} Td (${esc(l)}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const letter = (holder: string, last4: string) => [
  "Harbor Trust Bank",
  "200 Pier Street, Cleveland, OH 44101",
  "",
  "October 28, 2026",
  "To: Accounts Payable, Bayline Construction",
  `This confirms that ${holder} holds a business checking account with us.`,
  `Account ending: ${last4}`,
  "Account status: open and in good standing since October 2026",
  "",
  "Signed: Dana Reyes, Branch Manager",
];

mkdirSync("public/demo", { recursive: true });
writeFileSync("public/demo/bank-letter-match.pdf", pdf(letter("Sherwin-Williams", "3307")));
writeFileSync("public/demo/bank-letter-wrong.pdf", pdf(letter("SW Remit Services LLC", "9918")));
console.log("Wrote the sample letters to public/demo.");
