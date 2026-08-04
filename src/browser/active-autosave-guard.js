(() => {
  const suppressionKey = "abpn-study:suppress-active-autosave";

  // A destructive reload leaves the marker in sessionStorage during unload.
  // Clear that one-use marker as soon as the replacement page begins loading.
  if (sessionStorage.getItem(suppressionKey) === "true") {
    sessionStorage.removeItem(suppressionKey);
  }

  const originalAddEventListener = window.addEventListener;
  const originalRemoveEventListener = window.removeEventListener;
  const wrappedListeners = new WeakMap();

  // Keep this narrow wrapper for the lifetime of the page. The application is
  // loaded asynchronously after local question-bank packages are read, so its
  // beforeunload handler may be registered after DOMContentLoaded.
  window.addEventListener = function addGuardedEventListener(type, listener, options) {
    if (type !== "beforeunload" || typeof listener !== "function") {
      return originalAddEventListener.call(this, type, listener, options);
    }

    const wrapped = function guardedBeforeUnload(event) {
      if (sessionStorage.getItem(suppressionKey) === "true") return undefined;
      return listener.call(this, event);
    };
    wrappedListeners.set(listener, wrapped);
    return originalAddEventListener.call(this, type, wrapped, options);
  };

  window.removeEventListener = function removeGuardedEventListener(type, listener, options) {
    const wrapped = type === "beforeunload" && typeof listener === "function"
      ? wrappedListeners.get(listener) || listener
      : listener;
    return originalRemoveEventListener.call(this, type, wrapped, options);
  };
})();
