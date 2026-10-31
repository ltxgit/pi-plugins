/**
 * pi-plugins: notify — ntfy notification platform
 *
 * Sends push notifications to an ntfy server via HTTP POST (JSON body).
 */

/** Send a notification to an ntfy server */
export async function sendNtfyNotification(serverUrl: string, topic: string, title: string, message: string, priority: number = 3, token?: string, tag?: string): Promise<void> {
  const url = serverUrl.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const clampedPriority = Math.max(1, Math.min(5, priority));
  const payload: Record<string, unknown> = {
    topic,
    title,
    message,
    priority: clampedPriority,
  };
  if (tag) {
    payload.tags = [tag];
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const resBody = await response.text().catch(() => "<no body>");
    throw new Error(`ntfy API error ${response.status}: ${resBody}`);
  }
}
