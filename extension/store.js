// chrome.storage.local en la extensión; localStorage en la PWA (no tiene chrome.*).
// Mismo interfaz get/set para que list.js y sync.js funcionen sin cambios en ambos sitios.
// Se comprueba en cada llamada (no se cachea a nivel de módulo): los tests asignan
// globalThis.chrome tras importar este módulo, y los import estáticos se izan antes.
const hasChromeStorage = () => typeof chrome !== "undefined" && chrome.storage?.local;

export const get = async (key, def) => {
  if (hasChromeStorage()) return (await chrome.storage.local.get(key))[key] ?? def;
  const raw = localStorage.getItem(key);
  return raw == null ? def : JSON.parse(raw);
};

export const set = (key, value) => {
  if (hasChromeStorage()) return chrome.storage.local.set({ [key]: value });
  localStorage.setItem(key, JSON.stringify(value));
  return Promise.resolve();
};
