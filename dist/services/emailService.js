import { Resend } from 'resend';
let _resend = null;
function getResend() {
    if (!_resend)
        _resend = new Resend(process.env.RESEND_API_KEY);
    return _resend;
}
export async function sendWeeklyReport(merchantEmail, merchantName, stats) {
    const dateStr = new Date().toLocaleDateString('fr-FR');
    const { error } = await getResend().emails.send({
        from: 'OrderFlow <rapports@orderflow.ma>',
        to: merchantEmail,
        subject: `📊 Votre rapport hebdomadaire OrderFlow — ${dateStr}`,
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; }
    .header { background: #16a34a; padding: 30px; text-align: center; }
    .header h1 { color: white; margin: 0; font-size: 24px; }
    .header p { color: #dcfce7; margin: 8px 0 0 0; }
    .content { padding: 30px; }
    .kpi-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 20px 0; }
    .kpi-card { background: #f8fafc; border-radius: 8px; padding: 16px; text-align: center; border-left: 4px solid #16a34a; }
    .kpi-value { font-size: 28px; font-weight: bold; color: #16a34a; }
    .kpi-label { font-size: 12px; color: #6b7280; margin-top: 4px; }
    .section { margin: 24px 0; }
    .section h3 { color: #111827; border-bottom: 2px solid #f0fdf4; padding-bottom: 8px; }
    .stat-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f3f4f6; }
    .stat-label { color: #6b7280; }
    .stat-value { font-weight: bold; color: #111827; }
    .footer { background: #f8fafc; padding: 20px; text-align: center; color: #9ca3af; font-size: 12px; }
    .cta { background: #16a34a; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; display: inline-block; margin: 16px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📊 Rapport Hebdomadaire</h1>
      <p>Bonjour ${merchantName} ! Voici votre résumé de la semaine</p>
    </div>

    <div class="content">
      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-value">${stats.totalOrders}</div>
          <div class="kpi-label">Commandes totales</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">${stats.caReel.toLocaleString('fr-FR')} DH</div>
          <div class="kpi-label">CA Réel</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">${stats.confirmationRate}%</div>
          <div class="kpi-label">Taux de confirmation</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">${stats.caEstime.toLocaleString('fr-FR')} DH</div>
          <div class="kpi-label">CA Estimé</div>
        </div>
      </div>

      <div class="section">
        <h3>📦 Détail des commandes</h3>
        <div class="stat-row">
          <span class="stat-label">✅ Confirmées</span>
          <span class="stat-value">${stats.confirmedOrders}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">📦 Livrées</span>
          <span class="stat-value">${stats.deliveredOrders}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">❌ Annulées</span>
          <span class="stat-value">${stats.cancelledOrders}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">↩️ Taux de retour</span>
          <span class="stat-value">${stats.returnRate}%</span>
        </div>
      </div>

      <div class="section">
        <h3>🏆 Top performers</h3>
        <div class="stat-row">
          <span class="stat-label">📦 Produit le plus commandé</span>
          <span class="stat-value">${stats.topProduct || 'N/A'}</span>
        </div>
        <div class="stat-row">
          <span class="stat-label">📍 Ville principale</span>
          <span class="stat-value">${stats.topCity || 'N/A'}</span>
        </div>
      </div>

      <div style="text-align: center;">
        <a href="https://orderflow.vercel.app" class="cta">Voir mon dashboard →</a>
      </div>
    </div>

    <div class="footer">
      <p>OrderFlow — Gérez vos commandes WhatsApp</p>
      <p>Pour ne plus recevoir ces emails, modifiez vos préférences dans les paramètres.</p>
    </div>
  </div>
</body>
</html>`,
    });
    if (error) {
        console.error('[EMAIL] Failed to send weekly report to', merchantEmail, error);
        return false;
    }
    console.log('[EMAIL] Weekly report sent to:', merchantEmail);
    return true;
}
//# sourceMappingURL=emailService.js.map