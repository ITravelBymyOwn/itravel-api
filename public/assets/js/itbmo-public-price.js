(() => {
  function render(element, offer, lang) {
    if (!element) return;
    const { base_price: base, regular_price: regular } = offer ?? {};
    element.textContent = /^\d+\.\d{2}$/.test(base) ? `US$${base}` : '—';
    if (!/^\d+\.\d{2}$/.test(base) || !/^\d+\.\d{2}$/.test(regular) ||
        Number(regular) <= Number(base) || Number(base) <= 0) return;

    const discount = Math.round((1 - Number(base) / Number(regular)) * 100);
    const es = lang === 'es';
    const detail = document.createElement('small');
    detail.className = 'itbmo-price-promotion';
    const comparison = document.createElement('del');
    comparison.textContent = `US$${regular}`;
    detail.append(
      es ? 'Promoción · Regular ' : 'Offer · Regular ',
      comparison,
      es ? ` · ${discount}% de descuento` : ` · ${discount}% off`
    );
    element.append(' ', detail);
  }
  window.ITBMOPrice = { render };

  const prices = document.querySelectorAll('[data-itbmo-price]');
  if (!prices.length) return;
  const lang = document.documentElement.lang.toLowerCase().split('-')[0];
  let pending = false;
  async function refreshPrice() {
    if (pending || document.hidden) return;
    pending = true;
    try {
      const response = await fetch('/api/payment?action=pricing', { cache: 'no-store' });
      const offer = response.ok ? await response.json() : null;
      for (const element of prices) render(element, offer, lang);
    } catch {
      for (const element of prices) render(element, null, lang);
    } finally {
      pending = false;
    }
  }
  refreshPrice();
  document.addEventListener('visibilitychange', refreshPrice);
  window.setInterval(refreshPrice, 60_000);
})();
