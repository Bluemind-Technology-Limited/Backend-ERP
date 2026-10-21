import type { Prisma } from "@prisma/client";

/**
 * Purchase order state is derived from its lines, not set by hand:
 *
 *   all lines received  -> RECEIVED
 *   some lines received -> PARTIALLY_RECEIVED
 *   nothing received    -> unchanged (DRAFT / SENT)
 *
 * Keeping this in one place means PO-backed GRNs, consignment GRNs and GRN
 * deletions all leave the order in the same, correct state.
 */
export async function recomputePurchaseOrderStatus(
  tx: Prisma.TransactionClient,
  poId: string
): Promise<"DRAFT" | "SENT" | "PARTIALLY_RECEIVED" | "RECEIVED" | "CLOSED" | null> {
  const po = await tx.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      id: true,
      status: true,
      items: { select: { quantity: true, receivedQty: true } },
    },
  });

  if (!po || po.items.length === 0) return po?.status ?? null;
  if (po.status === "CLOSED") return po.status;

  const fullyReceived = po.items.every((i) => Number(i.receivedQty) >= Number(i.quantity));
  const anyReceived = po.items.some((i) => Number(i.receivedQty) > 0);

  const nextStatus = fullyReceived ? "RECEIVED" : anyReceived ? "PARTIALLY_RECEIVED" : po.status;

  if (nextStatus !== po.status) {
    await tx.purchaseOrder.update({
      where: { id: po.id },
      data: {
        status: nextStatus,
        // Only stamp the completion time once; reopening clears nothing else.
        ...(nextStatus === "RECEIVED" ? { receivedAt: new Date() } : {}),
      },
    });
  }

  return nextStatus;
}
