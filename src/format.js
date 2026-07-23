// Formato de moneda compartido: el cliente (nativo y web) recibe el texto ya
// armado (plan_amount_formatted) para no tener que implementar logica de
// locale/simbolo por su cuenta, igual que ya se hace con "message" en
// /api/membership/status.
const SYMBOLS = {
  USD: '$', ARS: '$', MXN: '$', COP: '$', CLP: '$', UYU: '$',
  EUR: '€', GBP: '£', PEN: 'S/', BRL: 'R$',
};

// Formato manual (no Intl.NumberFormat) para no depender de que variante de
// locale ICU este disponible en el runtime: punto como separador de miles,
// coma para decimales -- el formato usado en el ejemplo que pidio el cliente
// ("$15.000 ARS"), consistente sin importar el servidor donde corra esto.
function formatCurrency(cents, currency) {
  if (cents == null || !currency) return null;
  const amount = cents / 100;
  const symbol = SYMBOLS[currency] || '';
  const hasDecimals = Math.round(amount * 100) % 100 !== 0;
  const fixed = amount.toFixed(hasDecimals ? 2 : 0);
  const [intPart, decPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const formatted = decPart ? `${grouped},${decPart}` : grouped;
  return `${symbol}${formatted} ${currency}`;
}

module.exports = { formatCurrency };
