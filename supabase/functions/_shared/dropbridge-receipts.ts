import { admin } from "./device-auth.ts";

type ReceiptDetail = Record<string, unknown>;

export async function recordDropBridgeReceipt({
  uploadId,
  userId,
  deviceId,
  stage,
  source = "edge_function",
  detail = {},
}: {
  uploadId: string;
  userId: string;
  deviceId?: string | null;
  stage: string;
  source?: string;
  detail?: ReceiptDetail;
}): Promise<void> {
  const { error } = await admin.from("dropbridge_receipts").insert({
    upload_id: uploadId,
    user_id: userId,
    device_id: deviceId ?? null,
    stage,
    source,
    detail,
  });

  if (error) {
    console.error("Failed to record DropBridge receipt:", {
      uploadId,
      stage,
      error: error.message,
    });
  }
}
