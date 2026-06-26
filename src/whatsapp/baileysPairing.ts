import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
} from '@whiskeysockets/baileys';
import { rm } from 'fs/promises';

/**
 * Creates a temporary Baileys session solely to obtain a WhatsApp pairing code.
 * The session is closed and cleaned up immediately after the code is returned —
 * it is NOT kept alive. The ongoing WhatsApp connection is managed by Evolution.
 *
 * @param phoneNumber  Digits only, e.g. "212625869380"
 * @param instanceName Used to name the temp auth directory under /tmp
 */
export async function getBaileysPairingCode(
  phoneNumber: string,
  instanceName: string,
): Promise<string> {
  const authDir = `/tmp/${instanceName}`;
  let sock: ReturnType<typeof makeWASocket> | undefined;

  async function cleanup(): Promise<void> {
    try { sock?.end(new Error('cleanup')); } catch { /* ignore */ }
    await rm(authDir, { recursive: true, force: true }).catch(() => {});
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  async function attempt(): Promise<string> {
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
    });

    if (typeof sock.requestPairingCode !== 'function') {
      throw new Error('requestPairingCode not available — upgrade @whiskeysockets/baileys');
    }

    sock.ev.on('creds.update', saveCreds);

    // Wait until the socket has established contact with WhatsApp servers.
    // 'connecting' or a QR emission both confirm the WS handshake is done and
    // sendNode() is safe to call. A 'close' before either means the connection
    // was rejected — surface it so the caller can retry.
    console.log(`[baileys:${instanceName}] waiting for WhatsApp handshake...`);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('Timeout waiting for WhatsApp connection')),
        15_000,
      );
      sock!.ev.on('connection.update', (update) => {
        if (update.connection === 'connecting' || update.qr) {
          clearTimeout(t);
          resolve();
        }
        if (update.connection === 'close' && !update.qr) {
          clearTimeout(t);
          reject(new Error('Connection closed before ready'));
        }
      });
    });

    console.log(`[baileys:${instanceName}] requesting pairing code for ${phoneNumber}`);
    const code = await sock.requestPairingCode(phoneNumber);
    const formatted = code.includes('-') ? code : code.replace(/^(.{4})(.{4})$/, '$1-$2');
    console.log(`[baileys:${instanceName}] code obtained: ${formatted}`);

    // Temp session only needed to register the code — close immediately.
    await cleanup();
    return formatted;
  }

  try {
    return await attempt();
  } catch (firstErr) {
    console.warn(`[baileys:${instanceName}] first attempt failed (${String(firstErr)}), retrying in 2s…`);
    // Retry once — WhatsApp sometimes closes the connection on the first try (428).
    await new Promise<void>(r => setTimeout(r, 2_000));
    try {
      return await attempt();
    } catch (secondErr) {
      await cleanup();
      throw secondErr;
    }
  }
}
