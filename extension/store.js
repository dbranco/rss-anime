export const get = async (key, def) => (await chrome.storage.local.get(key))[key] ?? def;
export const set = (key, value) => chrome.storage.local.set({ [key]: value });
