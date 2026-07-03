import { admin } from "./device-auth.ts";

export function buildDropBridgeWakeTopic(userId: string, deviceId: string): string {
  return `dropbridge:user:${userId}:device:${deviceId}`;
}

export async function broadcastDropBridgeEvent(params: {
  userId: string;
  deviceId: string;
  event: string;
  payload: Record<string, unknown>;
}): Promise<boolean> {
  const topic = buildDropBridgeWakeTopic(params.userId, params.deviceId);
  const channel = admin.channel(topic, {
    config: {
      private: true,
    },
  });

  try {
    const result = await channel.send({
      type: "broadcast",
      event: params.event,
      payload: {
        ...params.payload,
        sentAt: new Date().toISOString(),
      },
    });
    return result === "ok";
  } catch (error) {
    console.error("DropBridge realtime broadcast failed:", {
      topic,
      event: params.event,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    try {
      await admin.removeChannel(channel);
    } catch {
      // Best effort cleanup for the ephemeral server-side channel.
    }
  }
}
