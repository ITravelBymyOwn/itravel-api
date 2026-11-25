(() => {
  const code = new URLSearchParams(location.search).get('promo')?.trim().toUpperCase();
  if (!code || !/^[A-Z0-9_-]{1,80}$/.test(code)) return;
  const input = document.getElementById('checkout-promo-input');
  if (input && !input.value) input.value = code;
})();
