import { SignJWT, importPKCS8 } from "https://deno.land/x/jose@v5.2.2/index.ts";

export async function sendApnsPush(
  deviceToken: string,
  environment: "sandbox" | "production",
  payload: any
) {
  const teamId = Deno.env.get("APNS_TEAM_ID");
  const keyId = Deno.env.get("APNS_KEY_ID");
  const privateKey = Deno.env.get("APNS_PRIVATE_KEY_P8");
  const topic = Deno.env.get("APNS_TOPIC");

  if (!teamId || !keyId || !privateKey || !topic) {
    console.warn("APNS credentials missing in environment");
    return;
  }

  let formattedKey = privateKey.trim();
  if (!formattedKey.includes("BEGIN PRIVATE KEY")) {
    formattedKey = `-----BEGIN PRIVATE KEY-----\n${formattedKey.match(/.{1,64}/g)?.join("\n") || formattedKey}\n-----END PRIVATE KEY-----`;
  }

  try {
    const key = await importPKCS8(formattedKey, "ES256");
    const jwt = await new SignJWT({ iss: teamId, iat: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: "ES256", kid: keyId })
      .sign(key);

    const baseUrl = environment === "sandbox"
      ? "https://api.sandbox.push.apple.com"
      : "https://api.push.apple.com";
    
    const url = `${baseUrl}/3/device/${deviceToken}`;

    const headers = {
      "authorization": `bearer ${jwt}`,
      "apns-topic": topic,
      "apns-push-type": "background",
      "apns-priority": "5",
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error(`APNs failed: ${response.status} ${errorText}`);
    } else {
        console.log(`APNs success to ${deviceToken}`);
    }
  } catch (error) {
    console.error("APNs send exception:", error);
  }
}
