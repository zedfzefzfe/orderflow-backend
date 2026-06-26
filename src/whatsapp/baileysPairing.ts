import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
} from '@whiskeysockets/baileys';
import { rm } from 'fs/promises';

const SOCKET_KEEPALIVE_MS = 90_000;

/**
 * Creates a temporary Baileys session, registers a pairing code with WhatsApp
 * for the given phone number, and returns the formatted 8-character code
 * (e.g. "ABCD-1234"). The socket stays alive for 90 s so the merchant can
 * complete the link; it is cleaned up automatically afterwards.
 *
 * @param phoneNumber  Digits only, e.g. "212625869380"
 * @param instanceName Used to name the temp auth directory under /tmp
 * @param onConnected  Called when WhatsApp confirms the link (connection 'open')
 */
export async function getBaileysPairingCode(
  phoneNumber: string,
  instanceName: string,
  onConnected?: () => Promise<void>,
): Promise<string> {
  const authDir = `/tmp/pairing-${instanceName}-${Date.now()}`;
  let keepAliveTimer: ReturnType<typeof setTimeout> | null = null;
  let sock: ReturnType<typeof makeWASocket> | undefined;

  async function cleanup(): Promise<void> {
    if (keepAliveTimer !== null) clearTimeout(keepAliveTimer);
    try { sock?.end(new Error('cleanup')); } catch { /* ignore */ }
    await rm(authDir, { recursive: true, force: true }).catch(() => {});
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  async function attempt(): Promise<string> {
    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      shouldSyncHistoryMessage: () => false,
      browser: Browsers.ubuntu('Chrome'),
    });

    if (typeof sock.requestPairingCode !== 'function') {
      throw new Error('requestPairingCode not available — upgrade @whiskeysockets/baileys');
    }

    sock.ev.on('creds.update', saveCreds);

    // Step 1: wait until the socket has established contact with WhatsApp servers.
    // 'connecting' or a QR emission both mean the WS handshake succeeded and
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

    // Step 2: socket is ready — request the pairing code.
    console.log(`[baileys:${instanceName}] requesting pairing code for ${phoneNumber}`);
    const code = await sock.requestPairingCode(phoneNumber);

    const formatted = code.includes('-') ? code : code.replace(/^(.{4})(.{4})$/, '$1-$2');
    console.log(`[baileys:${instanceName}] code obtained: ${formatted}`);

    // Step 3: keep socket alive and listen for the merchant completing the link.
    sock.ev.on('connection.update', async (update) => {
      if (update.connection === 'open' && onConnected) {
        console.log(`[baileys:${instanceName}] link confirmed — calling onConnected`);
        onConnected().catch(err =>
          console.error(`[baileys:${instanceName}] onConnected error:`, err),
        );
      }
    });

    keepAliveTimer = setTimeout(() => void cleanup(), SOCKET_KEEPALIVE_MS);
    return formatted;
  }

  try {
    return await attempt();
  } catch (firstErr) {
    console.warn(`[baileys:${instanceName}] first attempt failed (${String(firstErr)}), retrying in 2s…`);
    // Retry once after 2 s — WhatsApp sometimes closes the connection on the
    // first try (428 / connection closed before ready).
    await new Promise<void>(r => setTimeout(r, 2_000));
    try {
      return await attempt();
    } catch (secondErr) {
      await cleanup();
      throw secondErr;
    }
  }
}
