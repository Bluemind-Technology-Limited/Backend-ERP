/**
 * Email templates for stock alerts and reports
 */

export interface StockItem {
  materialId: string;
  materialName: string;
  sku: string;
  quantity: number;
  minimumQuantity: number;
  unitOfMeasure: string;
  isAlert: boolean;
}

export function generateStockEmailHTML(
  allItems: StockItem[],
  alertItems: StockItem[]
): string {
  const alertRows = alertItems
    .map(
      (item) => `
    <tr style="border-bottom: 1px solid #e5e7eb;">
      <td style="padding: 12px; text-align: left; font-size: 14px; color: #1f2937;">${item.sku}</td>
      <td style="padding: 12px; text-align: left; font-size: 14px; color: #1f2937;">${item.materialName}</td>
      <td style="padding: 12px; text-align: center; font-size: 14px; color: #dc2626; font-weight: 600;">${item.quantity.toFixed(2)}</td>
      <td style="padding: 12px; text-align: center; font-size: 14px; color: #6b7280;">${item.minimumQuantity.toFixed(2)}</td>
      <td style="padding: 12px; text-align: center; font-size: 14px; color: #dc2626;">−${(item.minimumQuantity - item.quantity).toFixed(2)}</td>
      <td style="padding: 12px; text-align: center; font-size: 14px; color: #1f2937;">${item.unitOfMeasure}</td>
    </tr>
  `
    )
    .join("");

  const stockTableRows = allItems
    .map(
      (item) => `
    <tr style="border-bottom: 1px solid #f3f4f6; ${item.isAlert ? 'background-color: #fef2f2;' : ''}">
      <td style="padding: 10px 12px; text-align: left; font-size: 13px; color: #1f2937;">${item.sku}</td>
      <td style="padding: 10px 12px; text-align: left; font-size: 13px; color: #1f2937;">${item.materialName}</td>
      <td style="padding: 10px 12px; text-align: center; font-size: 13px; ${item.isAlert ? 'color: #dc2626; font-weight: 600;' : 'color: #059669;'}">${item.quantity.toFixed(2)}</td>
      <td style="padding: 10px 12px; text-align: center; font-size: 13px; color: #6b7280;">${item.minimumQuantity.toFixed(2)}</td>
      <td style="padding: 10px 12px; text-align: center; font-size: 13px; color: #6b7280;">${item.unitOfMeasure}</td>
      <td style="padding: 10px 12px; text-align: center;">
        <span style="display: inline-block; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; ${item.isAlert ? 'background-color: #fee2e2; color: #dc2626;' : 'background-color: #d1fae5; color: #059669;'}">
          ${item.isAlert ? 'ALERT' : 'OK'}
        </span>
      </td>
    </tr>
  `
    )
    .join("");

  const timestamp = new Date().toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1f2937; line-height: 1.6; }
    .container { max-width: 1000px; margin: 0 auto; padding: 20px; }
    .header { margin-bottom: 30px; border-bottom: 2px solid #ea4335; padding-bottom: 20px; }
    .header h1 { margin: 0; color: #1f2937; font-size: 28px; }
    .header p { margin: 8px 0 0 0; color: #6b7280; font-size: 14px; }
    .section { margin-bottom: 30px; }
    .section-title { font-size: 16px; font-weight: 700; color: #1f2937; margin-bottom: 12px; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb; }
    .alert-box { background-color: #fef2f2; border-left: 4px solid #dc2626; padding: 16px; border-radius: 4px; margin-bottom: 20px; }
    .alert-box h3 { margin: 0 0 8px 0; color: #dc2626; font-size: 14px; font-weight: 700; }
    .alert-box p { margin: 0; color: #7f1d1d; font-size: 13px; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; }
    th { background-color: #f9fafb; padding: 12px; text-align: left; font-size: 13px; font-weight: 700; color: #374151; border-bottom: 2px solid #e5e7eb; }
    .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb; text-align: center; color: #6b7280; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📦 Daily Stock Level Report</h1>
      <p>Generated: ${timestamp} UTC</p>
    </div>

    ${
      alertItems.length > 0
        ? `
    <div class="alert-box">
      <h3>⚠️ ${alertItems.length} Material(s) Below Minimum Threshold</h3>
      <p>Immediate restocking action required for the items listed below.</p>
    </div>

    <div class="section">
      <div class="section-title">Restocking Priority Alert</div>
      <table>
        <thead>
          <tr style="background-color: #f9fafb;">
            <th>SKU</th>
            <th>Material Name</th>
            <th style="text-align: center;">Current Stock</th>
            <th style="text-align: center;">Minimum</th>
            <th style="text-align: center;">Shortage</th>
            <th style="text-align: center;">Unit</th>
          </tr>
        </thead>
        <tbody>
          ${alertRows}
        </tbody>
      </table>
    </div>
    `
        : `
    <div style="background-color: #f0fdf4; border-left: 4px solid #16a34a; padding: 16px; border-radius: 4px; margin-bottom: 20px;">
      <h3 style="margin: 0 0 8px 0; color: #16a34a; font-size: 14px; font-weight: 700;">✓ All Materials at Safe Levels</h3>
      <p style="margin: 0; color: #166534; font-size: 13px;">No items are below minimum threshold.</p>
    </div>
    `
    }

    <div class="section">
      <div class="section-title">Complete Inventory Status</div>
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>Material Name</th>
            <th style="text-align: center;">Current Stock</th>
            <th style="text-align: center;">Minimum</th>
            <th style="text-align: center;">Unit</th>
            <th style="text-align: center;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${stockTableRows}
        </tbody>
      </table>
      <p style="margin-top: 12px; color: #6b7280; font-size: 13px;">Total Materials: <strong>${allItems.length}</strong> | Alerts: <strong style="color: #dc2626;">${alertItems.length}</strong> | Normal: <strong style="color: #059669;">${allItems.length - alertItems.length}</strong></p>
    </div>

    <div class="footer">
      <p>This is an automated report from KIB Group ERP System. Please do not reply to this email.</p>
      <p style="margin-top: 8px;">For questions, contact your inventory management team.</p>
    </div>
  </div>
</body>
</html>
  `.trim();
}
