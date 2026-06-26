import makeWASocket, {
  useMultiFileAuthState,
  Browsers,
} from '@whiskeysockets/baileys';
import { rm } from 'fs/promises';

const PAIRING_TIMEOUT_MS = 30_000;
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

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(async () => {
      if (!settled) {
        settled = true;
        await cleanup().catch(() => {});
        reject(new Error('TIMEOUT'));
      }
    }, PAIRING_TIMEOUT_MS);

    try {
      sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
      });
    } catch (err) {
      clearTimeout(timer);
      void cleanup();
      reject(err);
      return;
    }

    if (typeof sock.requestPairingCode !== 'function') {
      clearTimeout(timer);
      void cleanup();
      reject(new Error('requestPairingCode not available — upgrade @whiskeysockets/baileys'));
      return;
    }

    sock.ev.on('creds.update', saveCreds);

    let codeRequested = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection } = update;
      console.log(`[baileys:${instanceName}] connection → ${connection ?? 'n/a'}`);

      // Request pairing code the moment the socket can talk to WhatsApp
      if (connection === 'connecting' && !codeRequested) {
        codeRequested = true;
        try {
          console.log(`[baileys:${instanceName}] requesting pairing code for ${phoneNumber}`);
          const code = await sock!.requestPairingCode(phoneNumber);

          if (!settled) {
            settled = true;
            clearTimeout(timer);
            // Crockford base32 comes back as 8 chars without a dash — format it
            const formatted = code.includes('-') ? code : code.replace(/^(.{4})(.{4})$/, '$1-$2');
            console.log(`[baileys:${instanceName}] code obtained: ${formatted}`);
            // Keep socket alive so the merchant can complete the link in WhatsApp
            keepAliveTimer = setTimeout(() => void cleanup(), SOCKET_KEEPALIVE_MS);
            resolve(formatted);
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            await cleanup().catch(() => {});
            reject(err);
          }
        }
      }

      // Fired when the merchant enters the code and WhatsApp confirms the link
      if (connection === 'open' && onConnected) {
        console.log(`[baileys:${instanceName}] link confirmed — calling onConnected`);
        onConnected().catch(err =>
          console.error(`[baileys:${instanceName}] onConnected error:`, err),
        );
      }
    });
  });
}
