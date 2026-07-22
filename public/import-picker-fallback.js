(() => {
  const app = document.getElementById('app');
  const input = document.getElementById('bankImportInput');
  if (!app || !input) return;

  function attachNativeImportControl() {
    const button = document.getElementById('importBankBtn');
    if (!button) return;

    if (button.textContent?.trim() !== 'Add deck from file') {
      button.textContent = 'Add deck from file';
    }
    input.removeAttribute('aria-hidden');
    input.removeAttribute('tabindex');
    input.className = 'bank-import-native-input';
    input.setAttribute('aria-label', 'Choose a deck JSON file');
    Object.assign(input.style, {
      position: 'static',
      left: 'auto',
      top: 'auto',
      width: 'min(100%, 360px)',
      height: '44px',
      opacity: '1',
      pointerEvents: 'auto',
      display: 'inline-block',
      padding: '7px',
      border: '1px solid #d6e0e8',
      borderRadius: '10px',
      background: '#fff',
      color: '#203040'
    });

    if (input.parentElement !== button.parentElement || input.previousElementSibling !== button) {
      button.insertAdjacentElement('afterend', input);
    }

    button.type = 'button';
    button.onclick = () => input.click();
  }

  // Capture the click before any obsolete dashboard placeholder handler.
  app.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('#importBankBtn') : null;
    if (!button || !app.contains(button)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    input.value = '';
    input.click();
  }, true);

  const observer = new MutationObserver(attachNativeImportControl);
  observer.observe(app, { childList: true, subtree: true });
  attachNativeImportControl();
})();
