import PDFDocument from "pdfkit";

/**
 * LPO (Local Purchase Order) PDF generator.
 *
 * One internal purchase order can be split across several suppliers, so each
 * supplier receives its own LPO document containing only its lines.
 */

export interface LpoLine {
  materialName: string;
  sku: string;
  quantity: number;
  unitOfMeasure: string;
  unitCost: number;
}

export interface LpoSupplier {
  name: string;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
}

export interface LpoPdfInput {
  lpoNumber: string;
  poNumber: string;
  requisitionNumber?: string | null;
  date: Date;
  expectedDelivery?: Date | null;
  notes?: string | null;
  supplier: LpoSupplier;
  lines: LpoLine[];
}

const COMPANY = {
  name: process.env.COMPANY_NAME?.trim() || "KIB Group",
  address: process.env.COMPANY_ADDRESS?.trim() || "",
  phone: process.env.COMPANY_PHONE?.trim() || "",
  email: process.env.COMPANY_EMAIL?.trim() || "procurement@kibgroup.com",
};

const CURRENCY = process.env.LPO_CURRENCY?.trim() || "NGN";
const DEFAULT_TERMS =
  "Please supply the items listed above in accordance with the agreed specifications. " +
  "Quote this LPO number on all correspondence, invoices and delivery documents.";

const money = (value: number) =>
  `${CURRENCY} ${new Intl.NumberFormat("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0)}`;

const formatDate = (value?: Date | null) =>
  value
    ? value.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : "—";

function drawTableHeader(doc: PDFKit.PDFDocument, y: number) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  doc.rect(left, y, width, 22).fill("#171717");
  doc.restore();

  doc.fillColor("#FFFFFF").font("Helvetica-Bold").fontSize(8);
  const columns = tableColumns(left);
  doc.text("#", columns.no, y + 7, { width: columns.noWidth });
  doc.text("Description", columns.desc, y + 7, { width: columns.descWidth });
  doc.text("SKU", columns.sku, y + 7, { width: columns.skuWidth });
  doc.text("Qty", columns.qty, y + 7, { width: columns.qtyWidth, align: "right" });
  doc.text("UOM", columns.uom, y + 7, { width: columns.uomWidth });
  doc.text("Unit Price", columns.price, y + 7, { width: columns.priceWidth, align: "right" });
  doc.text("Amount", columns.amount, y + 7, { width: columns.amountWidth, align: "right" });

  return y + 22;
}

function tableColumns(left: number) {
  const noWidth = 22;
  const descWidth = 150;
  const skuWidth = 58;
  const qtyWidth = 48;
  const uomWidth = 40;
  const priceWidth = 78;
  const amountWidth = 119;

  const no = left;
  const desc = no + noWidth;
  const sku = desc + descWidth;
  const qty = sku + skuWidth;
  const uom = qty + qtyWidth;
  const price = uom + uomWidth;
  const amount = price + priceWidth;

  return {
    no, noWidth, desc, descWidth, sku, skuWidth, qty, qtyWidth,
    uom, uomWidth, price, priceWidth, amount, amountWidth,
    totalWidth: noWidth + descWidth + skuWidth + qtyWidth + uomWidth + priceWidth + amountWidth,
  };
}

export function generateLpoPdf(input: LpoPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: 40,
        bufferPages: true,
        info: {
          Title: `LPO ${input.lpoNumber}`,
          Author: COMPANY.name,
          Subject: `Local Purchase Order for ${input.supplier.name}`,
        },
      });

      const chunks: Buffer[] = [];
      doc.on("data", (chunk: Buffer) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      render(doc, input);

      // Footer page numbers.
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        const previousBottomMargin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc
          .font("Helvetica")
          .fontSize(7)
          .fillColor("#999999")
          .text(
            `Page ${i + 1} of ${range.count}`,
            doc.page.margins.left,
            doc.page.height - 26,
            {
              width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
              align: "right",
              lineBreak: false,
            }
          );
        doc.page.margins.bottom = previousBottomMargin;
      }

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function render(doc: PDFKit.PDFDocument, input: LpoPdfInput) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  // -------------------------------------------------------------------------
  // Header
  // -------------------------------------------------------------------------
  doc.fillColor("#171717").font("Helvetica-Bold").fontSize(18).text(COMPANY.name, left, 40);

  doc.font("Helvetica").fontSize(8).fillColor("#737373");
  let companyY = 64;
  if (COMPANY.address) {
    doc.text(COMPANY.address, left, companyY, { width: 280 });
    companyY += 11;
  }
  const contact = [COMPANY.phone, COMPANY.email].filter(Boolean).join("  ·  ");
  if (contact) {
    doc.text(contact, left, companyY, { width: 280 });
  }

  doc.fillColor("#171717").font("Helvetica-Bold").fontSize(14).text("LOCAL PURCHASE ORDER", left, 40, {
    width,
    align: "right",
  });
  doc.font("Helvetica-Bold").fontSize(9).text(`LPO No: ${input.lpoNumber}`, left, 62, {
    width,
    align: "right",
  });
  doc.font("Helvetica").fontSize(8).fillColor("#555555").text(`Date: ${formatDate(input.date)}`, left, 76, {
    width,
    align: "right",
  });
  doc.text(`Ref: ${input.poNumber}`, left, 88, { width, align: "right" });

  doc
    .moveTo(left, 108)
    .lineTo(right, 108)
    .lineWidth(1)
    .strokeColor("#D9D9D9")
    .stroke();

  // -------------------------------------------------------------------------
  // Supplier / delivery blocks
  // -------------------------------------------------------------------------
  const blockY = 120;
  const half = width / 2 - 10;

  doc.fillColor("#999999").font("Helvetica-Bold").fontSize(7).text("SUPPLIER", left, blockY, {
    width: half,
  });
  doc.fillColor("#171717").font("Helvetica-Bold").fontSize(10).text(input.supplier.name, left, blockY + 12, {
    width: half,
  });

  doc.font("Helvetica").fontSize(8).fillColor("#555555");
  let supplierY = blockY + 28;
  const supplierLines = [
    input.supplier.contactPerson,
    input.supplier.address,
    input.supplier.email,
    input.supplier.phone,
  ].filter(Boolean) as string[];
  for (const line of supplierLines) {
    doc.text(line, left, supplierY, { width: half });
    supplierY += 11;
  }

  const rightX = left + width / 2 + 10;
  doc.fillColor("#999999").font("Helvetica-Bold").fontSize(7).text("DELIVER TO", rightX, blockY, {
    width: half,
  });
  doc.fillColor("#171717").font("Helvetica-Bold").fontSize(10).text(COMPANY.name, rightX, blockY + 12, {
    width: half,
  });
  doc.font("Helvetica").fontSize(8).fillColor("#555555");
  let deliverY = blockY + 28;
  if (COMPANY.address) {
    doc.text(COMPANY.address, rightX, deliverY, { width: half });
    deliverY += 11;
  }
  if (input.requisitionNumber) {
    doc.text(`Requisition: ${input.requisitionNumber}`, rightX, deliverY, { width: half });
    deliverY += 11;
  }
  if (input.expectedDelivery) {
    doc.text(`Expected delivery: ${formatDate(input.expectedDelivery)}`, rightX, deliverY, { width: half });
    deliverY += 11;
  }

  // -------------------------------------------------------------------------
  // Line items table
  // -------------------------------------------------------------------------
  let y = Math.max(205, supplierY + 12, deliverY + 12);
  y = drawTableHeader(doc, y);

  const columns = tableColumns(left);
  const bottomLimit = doc.page.height - doc.page.margins.bottom - 150;

  input.lines.forEach((line, index) => {
    doc.font("Helvetica").fontSize(8);
    const descHeight = doc.heightOfString(line.materialName, { width: columns.descWidth - 8 });
    const rowHeight = Math.max(22, descHeight + 10);

    if (y + rowHeight > bottomLimit) {
      doc.addPage();
      y = drawTableHeader(doc, doc.page.margins.top);
    }

    if (index % 2 === 1) {
      doc.save();
      doc.rect(left, y, columns.totalWidth, rowHeight).fill("#FAFAFA");
      doc.restore();
    }

    doc
      .moveTo(left, y + rowHeight)
      .lineTo(left + columns.totalWidth, y + rowHeight)
      .lineWidth(0.5)
      .strokeColor("#E9E9E9")
      .stroke();

    const amount = Number(line.quantity) * Number(line.unitCost);
    const textY = y + 6;

    doc.fillColor("#171717").font("Helvetica").fontSize(8);
    doc.text(String(index + 1), columns.no, textY, { width: columns.noWidth });
    doc.text(line.materialName, columns.desc, textY, { width: columns.descWidth - 8 });
    doc.text(line.sku || "—", columns.sku, textY, { width: columns.skuWidth });
    doc.text(String(line.quantity), columns.qty, textY, { width: columns.qtyWidth, align: "right" });
    doc.text(line.unitOfMeasure, columns.uom, textY, { width: columns.uomWidth });
    doc.text(money(Number(line.unitCost)), columns.price, textY, {
      width: columns.priceWidth,
      align: "right",
    });
    doc.font("Helvetica-Bold").text(money(amount), columns.amount, textY, {
      width: columns.amountWidth,
      align: "right",
    });

    y += rowHeight;
  });

  // -------------------------------------------------------------------------
  // Total
  // -------------------------------------------------------------------------
  const total = input.lines.reduce(
    (sum, line) => sum + Number(line.quantity) * Number(line.unitCost),
    0
  );

  y += 10;
  doc
    .moveTo(left + columns.totalWidth - 260, y)
    .lineTo(left + columns.totalWidth, y)
    .lineWidth(1)
    .strokeColor("#D9D9D9")
    .stroke();

  doc.fillColor("#171717").font("Helvetica-Bold").fontSize(9);
  doc.text("TOTAL", left + columns.totalWidth - 260, y + 8, {
    width: 150,
    align: "right",
  });
  doc.fontSize(11).text(money(total), left + columns.totalWidth - 110, y + 7, {
    width: 110,
    align: "right",
  });

  // -------------------------------------------------------------------------
  // Notes / terms
  // -------------------------------------------------------------------------
  y += 40;
  if (y > doc.page.height - 190) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  doc.fillColor("#999999").font("Helvetica-Bold").fontSize(7).text("NOTES / TERMS", left, y);
  doc
    .fillColor("#555555")
    .font("Helvetica")
    .fontSize(8)
    .text(input.notes?.trim() || DEFAULT_TERMS, left, y + 12, {
      width: columns.totalWidth,
      lineGap: 2,
    });

  // -------------------------------------------------------------------------
  // Signatures
  // -------------------------------------------------------------------------
  const signatureY = Math.min(doc.page.height - 110, doc.y + 45);
  const signatureWidth = 200;

  doc
    .moveTo(left, signatureY)
    .lineTo(left + signatureWidth, signatureY)
    .lineWidth(0.8)
    .strokeColor("#999999")
    .stroke();
  doc.fillColor("#777777").font("Helvetica").fontSize(7).text("Authorised Signature", left, signatureY + 5, {
    width: signatureWidth,
    align: "center",
  });

  doc
    .moveTo(right - signatureWidth, signatureY)
    .lineTo(right, signatureY)
    .lineWidth(0.8)
    .strokeColor("#999999")
    .stroke();
  doc.text("Supplier Acknowledgement", right - signatureWidth, signatureY + 5, {
    width: signatureWidth,
    align: "center",
  });
}
