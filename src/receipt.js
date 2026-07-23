// Genera el comprobante de pago en PDF (nota interna de venta / recibo para
// el cliente). Usa pdfkit directamente (dibuja texto/lineas) en vez de
// HTML-a-PDF: no necesita Chromium/Puppeteer, es liviano y suficiente para
// un recibo simple de una pagina.
const PDFDocument = require('pdfkit');
const { formatCurrency } = require('./format');

const LABELS = {
  es: {
    title: 'COMPROBANTE DE PAGO',
    receiptNo: 'N°',
    date: 'Fecha',
    client: 'Cliente',
    concept: 'Concepto',
    method: 'Metodo de pago',
    amount: 'Monto',
    status: 'Estado',
    paid: 'PAGADO',
    pending: 'DEBE',
    daysAdded: 'Dias de servicio agregados',
    note: 'Nota',
    footer: 'Documento generado automaticamente. No es un comprobante fiscal salvo que se indique lo contrario.',
    methods: { cash: 'Efectivo', transfer: 'Transferencia', card: 'Tarjeta', other: 'Otro' },
    planTitle: 'Plan contratado',
    planName: 'Plan',
    planLimit: 'Limite de equipos',
    planDuration: 'Duracion',
    planExpires: 'Vigente hasta',
    days: 'dias',
    noPlan: 'Sin plan asignado',
    devicesTitle: 'Equipos que abarca',
    noDevices: 'Sin equipos asignados a esta cuenta',
    deviceIdCol: 'ID Sehcontrol',
    deviceAliasCol: 'Alias',
  },
  en: {
    title: 'PAYMENT RECEIPT',
    receiptNo: 'No.',
    date: 'Date',
    client: 'Client',
    concept: 'Concept',
    method: 'Payment method',
    amount: 'Amount',
    status: 'Status',
    paid: 'PAID',
    pending: 'DUE',
    daysAdded: 'Service days added',
    note: 'Note',
    footer: 'Automatically generated document. Not a tax receipt unless stated otherwise.',
    methods: { cash: 'Cash', transfer: 'Transfer', card: 'Card', other: 'Other' },
    planTitle: 'Plan',
    planName: 'Plan',
    planLimit: 'Device limit',
    planDuration: 'Duration',
    planExpires: 'Valid until',
    days: 'days',
    noPlan: 'No plan assigned',
    devicesTitle: 'Devices covered',
    noDevices: 'No devices assigned to this account',
    deviceIdCol: 'Sehcontrol ID',
    deviceAliasCol: 'Alias',
  },
};

// Devuelve un Buffer con el PDF (mas simple de usar desde un endpoint HTTP
// que manejar el stream de pdfkit directo sobre la response).
function buildReceiptPdf({ payment, user, devices = [], settings }) {
  const t = LABELS[settings.language] || LABELS.es;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).font('Helvetica-Bold').text(settings.business_name || 'Mi Empresa');
    doc.fontSize(9).font('Helvetica').fillColor('#555');
    if (settings.tax_id) doc.text(settings.tax_id);
    if (settings.address) doc.text(settings.address);
    const contactLine = [settings.phone, settings.contact_email].filter(Boolean).join('  ·  ');
    if (contactLine) doc.text(contactLine);
    doc.fillColor('#000');
    doc.moveDown(1.5);

    doc.fontSize(14).font('Helvetica-Bold').text(t.title, { align: 'center' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').text(
      `${t.receiptNo} ${String(payment.receipt_number).padStart(6, '0')}      ${t.date}: ${new Date(payment.created_at).toLocaleString()}`,
      { align: 'center' }
    );
    doc.moveDown(1.5);

    const statusColor = payment.status === 'paid' ? '#1e9e5a' : '#d64545';
    const statusText = payment.status === 'paid' ? t.paid : t.pending;
    doc.fontSize(12).font('Helvetica-Bold').fillColor(statusColor)
      .text(statusText, { align: 'right' });
    doc.fillColor('#000');
    doc.moveDown(0.5);

    doc.fontSize(10).font('Helvetica-Bold').text(`${t.client}:`);
    doc.font('Helvetica').text(user.name ? `${user.name} (${user.email})` : user.email);
    doc.moveDown(0.8);

    const rows = [
      [t.concept, payment.concept || '-'],
      [t.method, t.methods[payment.method] || payment.method],
      [t.amount, formatCurrency(payment.amount_cents, payment.currency) || `${(payment.amount_cents / 100).toFixed(2)} ${payment.currency}`],
    ];
    if (payment.days_added) rows.push([t.daysAdded, String(payment.days_added)]);
    if (payment.note) rows.push([t.note, payment.note]);

    const startY = doc.y;
    const labelWidth = 160;
    rows.forEach(([label, value], i) => {
      const y = startY + i * 22;
      doc.font('Helvetica-Bold').fontSize(10).text(label, 50, y, { width: labelWidth });
      doc.font('Helvetica').fontSize(10).text(value, 50 + labelWidth, y, { width: 300 });
    });
    doc.y = startY + rows.length * 22 + 20;

    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(1);

    // Plan contratado: a que membresia corresponde este pago, para que quede
    // claro en el comprobante que servicio esta cubriendo.
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#000').text(t.planTitle);
    doc.moveDown(0.4);
    if (user.plan_name) {
      const planRows = [
        [t.planName, user.plan_name],
        [t.planLimit, String(user.max_devices ?? '-')],
        [t.planDuration, user.plan_duration_days ? `${user.plan_duration_days} ${t.days}` : '-'],
        [t.planExpires, user.plan_expires_at ? new Date(user.plan_expires_at).toLocaleDateString() : '-'],
      ];
      const planStartY = doc.y;
      const labelWidth2 = 160;
      planRows.forEach(([label, value], i) => {
        const y = planStartY + i * 20;
        doc.font('Helvetica-Bold').fontSize(9).text(label, 50, y, { width: labelWidth2 });
        doc.font('Helvetica').fontSize(9).text(value, 50 + labelWidth2, y, { width: 300 });
      });
      doc.y = planStartY + planRows.length * 20 + 10;
    } else {
      doc.fontSize(9).font('Helvetica').fillColor('#888').text(t.noPlan);
      doc.fillColor('#000');
      doc.moveDown(0.5);
    }

    doc.moveDown(0.8);

    // Equipos que cubre la cuenta al momento de emitir el comprobante (no
    // necesariamente los que se pagaron con ESTE pago puntual, sino todos
    // los que la membresia del cliente tiene asignados ahora mismo).
    doc.fontSize(11).font('Helvetica-Bold').text(t.devicesTitle);
    doc.moveDown(0.4);
    if (devices.length === 0) {
      doc.fontSize(9).font('Helvetica').fillColor('#888').text(t.noDevices);
      doc.fillColor('#000');
    } else {
      const idColWidth = 160;
      doc.font('Helvetica-Bold').fontSize(9);
      const tableTop = doc.y;
      doc.text(t.deviceIdCol, 50, tableTop, { width: idColWidth });
      doc.text(t.deviceAliasCol, 50 + idColWidth, tableTop, { width: 300 });
      doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).strokeColor('#eee').stroke();
      doc.font('Helvetica').fontSize(9);
      devices.forEach((d, i) => {
        const y = tableTop + 20 + i * 18;
        if (y > 760) { doc.addPage(); }
        doc.text(d.rustdesk_id, 50, y, { width: idColWidth });
        doc.text(d.alias || '-', 50 + idColWidth, y, { width: 300 });
      });
      doc.y = tableTop + 20 + devices.length * 18 + 10;
    }

    doc.moveDown(1.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(1);
    doc.fontSize(8).fillColor('#888').text(t.footer, { align: 'center' });

    doc.end();
  });
}

module.exports = { buildReceiptPdf };
