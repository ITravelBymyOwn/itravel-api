(() => {
  const prices = document.querySelectorAll('[data-itbmo-price]');
  if (!prices.length) return;
  let pending = false;
  async function refreshPrice() {
    if (pending || document.hidden) return;
    pending = true;
    try {
      const response = await fetch('/api/payment?action=pricing', { cache: 'no-store' });
      const offer = response.ok ? await response.json() : null;
      const price = /^\d+\.\d{2}$/.test(offer?.base_price) ? `US$${offer.base_price}` : '—';
      for (const element of prices) element.textContent = price;
    } catch {
      for (const element of prices) element.textContent = '—';
    } finally {
      pending = false;
    }
  }
  refreshPrice();
  document.addEventListener('visibilitychange', refreshPrice);
})();
