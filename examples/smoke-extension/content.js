(function () {
  window.__faceitExtensionLoaderSmokeTest = {
    loadedAt: new Date().toISOString(),
    href: location.href
  };
  document.documentElement.setAttribute('data-faceit-extension-loader-smoke-test', 'loaded');
  console.info('[faceit-extension-loader-smoke-test] content script loaded', location.href);
})();
